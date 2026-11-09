// The phone's local engine (docs/phone-budget.md, decisions.md D-45). It keeps a copy of the budget's synced tables
// in its own SQLite (sql.js in the browser, a Durable Object's SQLite in tests), works out everything the server no
// longer keeps (budget lines, month snapshots, Ready to Assign, month totals) with the same code the server used to
// run, and answers the app's screen requests with the server's own routes. Nothing here talks to the network: the
// browser host (web-entry.ts) fetches sync pages and hands them in.
import type { Db, Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { localDate, type Month } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import type { Env } from '../env.js';
import { budgetApi } from '../routes/api.js';
import { markDirty, recompute } from '../budget/recompute.js';
import { Scoped } from '../db/scoped.js';
import {
  budgetMeta,
  chunks,
  planLineRebuild,
  planStartLines,
  toLedgerAccount,
  uncovered,
  type AccountRowDb,
} from '../ledger/ledger.js';
import { clearTotals } from '../ledger/totals.js';
import { checkIdentityDb } from '../maintenance.js';
import { splitStatements } from '../store/adapter.js';
import { BUDGET_MIGRATIONS } from '../store/migrations.gen.js';
import { SYNC_FORMAT, SYNC_TABLES, triggerNames } from '../sync-tables.js';
import type { SyncPage, SyncRow } from '../routes/sync.js';
import { CSRF_HEADER } from '@ledgerline/contracts';

export interface EngineIdentity {
  budgetId: string;
  userId: string;
  email: string;
}

export interface EngineState {
  /** Change number the copy holds (0: nothing yet). */
  through: number;
  epoch: string | null;
  format: number;
  /** Full download in progress: where it continues. */
  cursor: string | null;
  /** Server time of the last sync answer, and how far this device's clock is from it (ms). */
  serverTime: number | null;
  offset: number;
}

const EMPTY: EngineState = {
  through: 0,
  epoch: null,
  format: SYNC_FORMAT,
  cursor: null,
  serverTime: null,
  offset: 0,
};

/** What the next derive() has to redo, kept in the copy so a reload in between loses nothing. */
export interface PendingDerive {
  /** Every line, from the budget start (first download, an account or the budget's start or time zone changed). */
  full: boolean;
  /** Transactions whose lines to rebuild. */
  keys: string[];
  /** Earliest month whose assignments changed. */
  fromMonth: string | null;
  /** Categories changed: recompute from the budget start, without rebuilding lines. */
  fromStart?: boolean;
}

/** What a sync page did to the copy. */
export interface ApplyResult {
  /** The copy was thrown away first (new epoch or format). */
  reset: boolean;
  rows: number;
  /** Everything up to the server's latest change is in the copy. */
  caughtUp: boolean;
}

/**
 * Bump when the rules that turn rows into budget lines or stored totals change, so every copy rebuilds them once
 * (2: rows dated before the budget start move the starting balance, D-67).
 */
export const DERIVE_VERSION = 2;
const derivedMark = (today: string) => `${today}#${DERIVE_VERSION}`;

/** Server migrations the copy skips: they remove what only the phone keeps. */
const SERVER_ONLY = new Set(['0006_drop_phone_tables_on_server.sql']);

/**
 * What the phone works out and keeps (D-45): budget lines, month snapshots and stored month totals. The server
 * dropped these tables (migration 0006); the copy creates them itself, as migration 0001 defined them.
 */
export const PHONE_TABLES = [
  `CREATE TABLE IF NOT EXISTS budget_line (
    budget_id TEXT NOT NULL,
    txn_key TEXT NOT NULL,
    line TEXT NOT NULL,
    month TEXT NOT NULL,
    date TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('rta', 'cat', 'owed', 'close', 'payment', 'debt', 'wait', 'unsorted', 'uncat')),
    account_id TEXT NOT NULL,
    card INTEGER NOT NULL,
    category_id TEXT,
    amount INTEGER NOT NULL,
    ref TEXT,
    PRIMARY KEY (budget_id, txn_key, line)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS budget_line_month ON budget_line(budget_id, month)`,
  `CREATE TABLE IF NOT EXISTS month_snapshot (
    budget_id TEXT NOT NULL,
    month TEXT NOT NULL,
    state TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (budget_id, month)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS account_month_total (
    budget_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    month TEXT NOT NULL,
    posted_all INTEGER NOT NULL,
    posted_in_budget INTEGER NOT NULL,
    PRIMARY KEY (budget_id, month, account_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS month_total_done (
    budget_id TEXT NOT NULL,
    month TEXT NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (budget_id, month)
  ) WITHOUT ROWID`,
];

/**
 * Applies migrations to the local copy (idempotent: the same _migrations table the server objects use). `migrations`
 * is for tests that build a copy as an older app version left it (test/engine-upgrade.test.ts).
 */
export async function migrateLocal(
  db: Db,
  now: number,
  migrations: readonly { name: string; sql: string }[] = BUDGET_MIGRATIONS,
): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    .run();
  const done = new Set(
    (await db.prepare(`SELECT name FROM _migrations`).all<{ name: string }>()).results.map((r) => r.name),
  );
  for (const m of migrations) {
    if (done.has(m.name) || SERVER_ONLY.has(m.name)) continue;
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)`).bind(m.name, now),
    ]);
  }
  // The copy has no use for the server's change log: its triggers would only double every write.
  await db.batch(
    SYNC_TABLES.flatMap((t) => triggerNames(t.name)).map((n) => db.prepare(`DROP TRIGGER IF EXISTS ${n}`)),
  );
  await db.batch([
    ...PHONE_TABLES.map((sql) => db.prepare(sql)),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
  ]);
}

export class LocalEngine {
  private readonly app: Hono<AppEnv>;

  constructor(
    readonly db: Db,
    private readonly who: EngineIdentity,
    /** The device's clock; corrected by the measured offset from the server. */
    private readonly deviceNow: () => number = () => Date.now(),
    /** Called when Ready to Assign doesn't satisfy rule 10 (the identity check). */
    private readonly onIdentity?: (r: { difference: number; month: string }) => Promise<void>,
  ) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'local');
      c.set('userId', who.userId);
      c.set('budgetId', who.budgetId);
      c.set('email', who.email);
      c.set('sessionId', '');
      c.set('syncEpoch', 'local');
      return next();
    });
    app.route('/api', budgetApi);
    this.app = app;
  }

  async state(): Promise<EngineState> {
    const r = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = 'sync'`)
      .first<{ value: string }>();
    return r ? { ...EMPTY, ...(JSON.parse(r.value) as Partial<EngineState>) } : { ...EMPTY };
  }

  private setState(s: EngineState): Stmt {
    return this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('sync', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(s));
  }

  /** The server's clock as this device sees it (the phone's own clock is never used for money, section 9). */
  async now(): Promise<number> {
    return this.deviceNow() + (await this.state()).offset;
  }

  /** Where the next sync request starts: `since` and, during a full download, `cursor`. */
  async nextRequest(): Promise<{ since: number; cursor: string | null }> {
    const s = await this.state();
    return { since: s.cursor ? 0 : s.through, cursor: s.cursor };
  }

  /**
   * Applies one sync page in one transaction. A page from another epoch or format, when the copy already holds
   * data, throws the copy away first; the caller then starts a full download (nextRequest() says so).
   */
  async apply(page: SyncPage, receivedAt = this.deviceNow()): Promise<ApplyResult> {
    const st = await this.state();
    const fresh = st.epoch === null && st.through === 0 && st.cursor === null;
    if (!fresh && (page.epoch !== st.epoch || page.format !== st.format)) {
      await this.clear();
      return { reset: true, rows: 0, caughtUp: false };
    }
    const stmts: Stmt[] = [this.db.prepare(`PRAGMA defer_foreign_keys = ON`)];
    // What the next derive() must redo (read before the rows change: a moved or deleted row's old key counts too).
    const todo = await this.pendingDerive();
    if (st.cursor || page.cursor || st.through === 0) todo.full = true;
    if (!todo.full) await this.noteChanges(page.rows, todo);
    for (const r of page.rows) stmts.push(...this.rowStatements(r));
    stmts.push(this.setPendingDerive(todo));
    const next: EngineState = {
      ...st,
      epoch: page.epoch,
      format: page.format,
      serverTime: page.serverTime,
      offset: page.serverTime - receivedAt,
      cursor: page.cursor,
      // A full download holds `through` until its last page; a change page moves it.
      through: page.cursor ? st.through : page.through,
    };
    stmts.push(this.setState(next));
    for (const part of chunks(stmts, 500)) await this.db.batch(part);
    return { reset: false, rows: page.rows.length, caughtUp: !page.more && !page.cursor };
  }

  private async pendingDerive(): Promise<PendingDerive> {
    const r = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = 'derive'`)
      .first<{ value: string }>();
    return r ? (JSON.parse(r.value) as PendingDerive) : { full: false, keys: [], fromMonth: null };
  }

  private setPendingDerive(p: PendingDerive): Stmt {
    return this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('derive', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify({ ...p, keys: [...new Set(p.keys)] }));
  }

  /**
   * Which transactions' lines and which months a sync page changes. Rows that only change what screens read
   * directly (payees, rules, alerts, balances, targets, settings) need no derive at all.
   */
  private async noteChanges(rows: readonly SyncRow[], todo: PendingDerive): Promise<void> {
    const keyCols: Record<string, string[]> = {
      bank_txn: ['txn_key'],
      manual_pending: ['txn_key'],
      txn_split: ['txn_key'],
      expected_reimbursement: ['txn_key'],
      txn_link: ['from_key', 'to_key'],
      txn_overlay: ['txn_key'],
    };
    const month = (m: unknown) => {
      if (typeof m === 'string' && (!todo.fromMonth || m < todo.fromMonth)) todo.fromMonth = m;
    };
    for (const r of rows) {
      const t = SYNC_TABLES.find((x) => x.name === r.t);
      if (!t) continue;
      const cols = keyCols[r.t];
      if (cols) {
        const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
        const old = await this.db
          .prepare(
            `SELECT ${[...cols, ...(r.t === 'manual_pending' ? ['covers_provider_txn_id'] : [])].join(', ')} FROM ${r.t} WHERE ${where}`,
          )
          .bind(...r.k)
          .first<Record<string, unknown>>();
        for (const c of cols) {
          if (old?.[c]) todo.keys.push(String(old[c]));
          if (r.d?.[c]) todo.keys.push(String(r.d[c]));
        }
        // A posted bank row removed can change another row's place: a reissue of it keeps its arrival, so that row
        // moves out of the starting balance (ledger/link.ts, D-67). Rare, so everything is rebuilt.
        if (r.t === 'bank_txn' && r.d?.removed_at && r.d.pending === 0) todo.full = true;
        // An entry's cover hides the bank pending row it covers (docs/payee-names.md 9.2): any change to the entry
        // (the cover, deleted, matched) can show or hide that row, before or after.
        if (r.t === 'manual_pending')
          for (const id of [old?.covers_provider_txn_id, r.d?.covers_provider_txn_id]) {
            if (typeof id !== 'string') continue;
            const b = await this.db
              .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = ?1`)
              .bind(id)
              .first<{ txn_key: string }>();
            if (b) todo.keys.push(b.txn_key);
          }
      } else if (r.t === 'assignment') month(r.k[1]);
      else if (r.t === 'category') todo.fromStart = true;
      else if (r.t === 'account') todo.full = true;
      else if (r.t === 'budget') {
        const b = await this.db
          .prepare(`SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`)
          .bind(r.k[0])
          .first<{ budget_start_month: string | null; time_zone: string }>();
        if (!b || !r.d || b.budget_start_month !== r.d.budget_start_month || b.time_zone !== r.d.time_zone)
          todo.full = true;
      }
    }
  }

  private rowStatements(r: SyncRow): Stmt[] {
    const t = SYNC_TABLES.find((x) => x.name === r.t);
    if (!t) return [];
    const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
    if (!r.d) return [this.db.prepare(`DELETE FROM ${t.name} WHERE ${where}`).bind(...r.k)];
    const cols = Object.keys(r.d);
    const vals = cols.map((c) => r.d![c]);
    const update = cols
      .filter((c) => !t.pk.includes(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    return [
      this.db
        .prepare(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})
           ON CONFLICT (${t.pk.join(', ')}) DO ${update ? `UPDATE SET ${update}` : 'NOTHING'}`,
        )
        .bind(...vals),
    ];
  }

  /** Empties the copy (a new epoch, or a failed offline edit): everything is downloaded again. */
  async clear(): Promise<void> {
    const derivedTables = ['budget_line', 'month_snapshot', 'account_month_total', 'month_total_done'];
    await this.db.batch([
      this.db.prepare(`PRAGMA defer_foreign_keys = ON`),
      ...[...SYNC_TABLES].reverse().map((t) => this.db.prepare(`DELETE FROM ${t.name}`)),
      ...derivedTables.map((t) => this.db.prepare(`DELETE FROM ${t}`)),
      this.setState({ ...EMPTY }),
    ]);
  }

  /**
   * Works out everything derived from scratch: every transaction's budget lines (from today's date in the budget's
   * time zone), the month snapshots and Ready to Assign, then checks rule 10. A few hundred ms at most on a phone.
   */
  async derive(): Promise<{ rta: number } | null> {
    const now = await this.now();
    const s = new Scoped(this.db, this.who.budgetId, this.who.userId);
    const meta = await budgetMeta(s);
    if (!meta) return null;
    const today = localDate(now, meta.timeZone);
    const todo = await this.pendingDerive();
    const last = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = 'derived_today'`)
      .first<{ value: string }>();
    // A new day can make upcoming rows count, so it rebuilds everything; otherwise only what the syncs changed. So
    // does a new DERIVE_VERSION: lines worked out by older code are rebuilt once.
    if (!todo.full && last?.value === derivedMark(today)) {
      // Nothing that counts changed (payees, rules, alerts, balances, targets…): the numbers stand.
      if (!todo.keys.length && !todo.fromMonth && !todo.fromStart) return { rta: (await this.rta()).rta };
      const stmts: Stmt[] = [];
      if (todo.keys.length) {
        for (const part of chunks([...new Set(todo.keys)], 450)) {
          const plan = await planLineRebuild(s, part, meta, today, now);
          if (plan.stmts.length) await s.batch(plan.stmts);
        }
        stmts.push(clearTotals(s));
      }
      if (todo.fromStart) stmts.push(markDirty(this.db, this.who.budgetId, meta.startMonth, now));
      else if (todo.fromMonth)
        stmts.push(
          markDirty(
            this.db,
            this.who.budgetId,
            (todo.fromMonth < meta.startMonth ? meta.startMonth : todo.fromMonth) as Month,
            now,
          ),
        );
      stmts.push(this.setPendingDerive({ full: false, keys: [], fromMonth: null }));
      await s.batch(stmts);
      let r = await recompute(this.db, this.who.budgetId, now, { maxMonths: 1200 });
      for (let i = 0; !r.done && i < 20; i++)
        r = await recompute(this.db, this.who.budgetId, now, { maxMonths: 1200 });
      await this.identity(now, today);
      return { rta: r.rta };
    }
    await s.run(`DELETE FROM budget_line WHERE budget_id = ?1`);
    const accounts = await s.all<AccountRowDb>(`SELECT * FROM account WHERE budget_id = ?1`);
    const start = accounts.flatMap((a) => planStartLines(s, toLedgerAccount(a), meta, now));
    if (start.length) await s.batch(start);
    const keys = (
      await s.all<{ key: string }>(
        `SELECT key FROM v_transaction WHERE budget_id = ?1 AND ${uncovered('v_transaction')}`,
      )
    ).map((r) => r.key);
    for (const part of chunks(keys, 450)) {
      const plan = await planLineRebuild(s, part, meta, today, now);
      if (plan.stmts.length) await s.batch(plan.stmts);
    }
    await s.batch([markDirty(this.db, this.who.budgetId, meta.startMonth as Month, now), clearTotals(s)]);
    let r = await recompute(this.db, this.who.budgetId, now, {
      force: true,
      fullFrom: true,
      maxMonths: 1200,
    });
    for (let i = 0; !r.done && i < 20; i++)
      r = await recompute(this.db, this.who.budgetId, now, { maxMonths: 1200 });
    await s.batch([
      this.setPendingDerive({ full: false, keys: [], fromMonth: null }),
      this.db
        .prepare(
          `INSERT INTO local_state (key, value) VALUES ('derived_today', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(derivedMark(today)),
    ]);
    await this.identity(now, today);
    return { rta: r.rta };
  }

  /** Rule 10 on the copy; a failure is reported to the server (an `identity` alert). */
  private async identity(now: number, today: string): Promise<void> {
    const identity = await checkIdentityDb(this.env(now), this.who.budgetId).catch(() => null);
    if (identity && !identity.ok && this.onIdentity)
      await this.onIdentity({ difference: identity.difference, month: today.slice(0, 7) }).catch(
        () => undefined,
      );
  }

  /** Whether a derive has anything to do (the host skips it otherwise). */
  async needsDerive(): Promise<boolean> {
    const todo = await this.pendingDerive();
    return todo.full || todo.keys.length > 0 || !!todo.fromMonth || !!todo.fromStart;
  }

  /** The current Ready to Assign in the copy. */
  async rta(): Promise<{ rta: number; updating: boolean }> {
    const b = await this.db
      .prepare(`SELECT rta, summary_dirty_from FROM budget WHERE id = ?1`)
      .bind(this.who.budgetId)
      .first<{ rta: number; summary_dirty_from: string | null }>();
    return { rta: b?.rta ?? 0, updating: (b?.summary_dirty_from ?? null) !== null };
  }

  private env(now: number): Env {
    return {
      DB: this.db,
      PLAID_ENV: 'engine',
      FAKE_NOW: new Date(now).toISOString(),
      USAGE: async () => ({
        written: 0,
        read: 0,
        do: { requests: 0, gbs: 0 },
        workers: 0,
        refreshedAt: null,
      }),
      JOBS: { sync: async () => undefined },
    } as unknown as Env;
  }

  /**
   * Answers an app request from the copy with the server's own routes: every screen, and the short list of changes
   * the phone may make offline (they're sent to the server later; web-entry.ts). The routes only store what was
   * entered, as on the server; after a change this works out what it affects (derive()) and adds Ready to Assign to
   * the answer.
   */
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const now = await this.now();
    const mutation = method !== 'GET' && method !== 'HEAD';
    const r = await this.route(method, path, body, now, mutation);
    if (!mutation || r.status >= 300) return r;
    const todo = await this.pendingDerive();
    noteEdit(method, path, body, todo);
    await this.db.batch([this.setPendingDerive(todo)]);
    const { rta } = (await this.derive()) ?? { rta: 0 };
    const text = await r.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    const ack =
      json && typeof json === 'object' && !('rta' in json) ? { ...json, rta, rtaUpdating: false } : json;
    return new Response(JSON.stringify(ack), { status: r.status, headers: r.headers });
  }

  private async route(
    method: string,
    path: string,
    body: unknown,
    now: number,
    mutation: boolean,
  ): Promise<Response> {
    const req = new Request(`https://engine.local${path}`, {
      method,
      headers: mutation
        ? { 'content-type': 'application/json', [CSRF_HEADER]: '1', origin: 'https://engine.local' }
        : {},
      body: mutation ? JSON.stringify(body ?? {}) : undefined,
    });
    return this.app.fetch(req, this.env(now), {
      waitUntil: () => undefined,
      passThroughOnException() {},
    } as never);
  }
}

/**
 * What an offline edit (the short list in apps/web/src/copy/copy.ts) asks the next derive() to redo: a transaction's
 * lines, or the months from an assignment on. A target changes nothing derived. Anything else rebuilds everything.
 */
export function noteEdit(method: string, path: string, body: unknown, todo: PendingDerive): void {
  const b = (body ?? {}) as { keys?: unknown; month?: unknown; amount?: unknown };
  const txn = method === 'PATCH' ? /^\/api\/transactions\/([^/]+)$/.exec(path) : null;
  // A new amount on your entry can end its cover, which shows the bank row it covered (docs/payee-names.md 9.2).
  if (txn && b.amount !== undefined) todo.full = true;
  else if (txn) todo.keys.push(decodeURIComponent(txn[1]!));
  else if (method === 'POST' && path === '/api/transactions/categorize' && Array.isArray(b.keys))
    todo.keys.push(...b.keys.map(String));
  else if (
    method === 'POST' &&
    /^\/api\/budget\/(assign|set|move)$/.test(path) &&
    typeof b.month === 'string'
  ) {
    if (!todo.fromMonth || b.month < todo.fromMonth) todo.fromMonth = b.month;
  } else if (method === 'PUT' && /^\/api\/categories\/[^/]+\/target$/.test(path)) return;
  else todo.full = true;
}
