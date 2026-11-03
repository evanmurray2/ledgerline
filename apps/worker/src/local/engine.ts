// The phone's local engine (docs/phone-budget.md, decisions.md D-45). It keeps a copy of the budget's synced tables
// in its own SQLite (sql.js in the browser, a Durable Object's SQLite in tests), works out everything the server no
// longer keeps (budget lines, month snapshots, Ready to Assign, month totals) with the same code the server used to
// run, and answers the app's screen requests with the server's own routes. Nothing here talks to the network: the
// browser host (web-entry.ts) fetches sync pages and hands them in.
import { Hono } from 'hono';
import { localDate, type Month } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import type { Env } from '../env.js';
import { budgetApi } from '../routes/api.js';
import { derived } from '../budget/derived.js';
import { markDirty, recompute } from '../budget/recompute.js';
import { Scoped } from '../db/scoped.js';
import {
  budgetMeta,
  chunks,
  planLineRebuild,
  planStartLines,
  toLedgerAccount,
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

/** What a sync page did to the copy. */
export interface ApplyResult {
  /** The copy was thrown away first (new epoch or format). */
  reset: boolean;
  rows: number;
  /** Everything up to the server's latest change is in the copy. */
  caughtUp: boolean;
}

/** Applies migrations to the local copy (idempotent: the same _migrations table the server objects use). */
export async function migrateLocal(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    .run();
  const done = new Set(
    (await db.prepare(`SELECT name FROM _migrations`).all<{ name: string }>()).results.map((r) => r.name),
  );
  for (const m of BUDGET_MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)`).bind(m.name, now),
    ]);
  }
  // The copy has no use for the server's change log: its triggers would only double every write.
  await db.batch(
    SYNC_TABLES.flatMap((t) => triggerNames(t.name)).map((n) => db.prepare(`DROP TRIGGER IF EXISTS ${n}`)),
  );
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    .run();
}

export class LocalEngine {
  private readonly app: Hono<AppEnv>;

  constructor(
    readonly db: D1Database,
    private readonly who: EngineIdentity,
    /** The device's clock; corrected by the measured offset from the server. */
    private readonly deviceNow: () => number = () => Date.now(),
    /** Called when Ready to Assign doesn't satisfy rule 10 (the identity check). */
    private readonly onIdentity?: (r: { difference: number; month: string }) => Promise<void>,
  ) {
    // This engine works out everything derived (budget/derived.ts).
    derived.enabled = true;
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

  private setState(s: EngineState): D1PreparedStatement {
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
    const stmts: D1PreparedStatement[] = [this.db.prepare(`PRAGMA defer_foreign_keys = ON`)];
    for (const r of page.rows) stmts.push(...this.rowStatements(r));
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

  private rowStatements(r: SyncRow): D1PreparedStatement[] {
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
    await s.run(`DELETE FROM budget_line WHERE budget_id = ?1`);
    const accounts = await s.all<AccountRowDb>(`SELECT * FROM account WHERE budget_id = ?1`);
    const start = accounts.flatMap((a) => planStartLines(s, toLedgerAccount(a), meta, now));
    if (start.length) await s.batch(start);
    const keys = (await s.all<{ key: string }>(`SELECT key FROM v_transaction WHERE budget_id = ?1`)).map(
      (r) => r.key,
    );
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
    const identity = await checkIdentityDb(this.env(now), this.who.budgetId).catch(() => null);
    if (identity && !identity.ok && this.onIdentity)
      await this.onIdentity({ difference: identity.difference, month: today.slice(0, 7) }).catch(
        () => undefined,
      );
    return { rta: r.rta };
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
      JOBS: {
        sync: async () => undefined,
        recompute: async () => {
          for (let i = 0; i < 20; i++) {
            const r = await recompute(this.db, this.who.budgetId, now, { maxMonths: 1200 });
            if (r.done) break;
          }
        },
      },
    } as unknown as Env;
  }

  /**
   * Answers an app request from the copy with the server's own routes: every screen, and the short list of changes
   * the phone may make offline (they're sent to the server later; web-entry.ts).
   */
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const now = await this.now();
    const mutation = method !== 'GET' && method !== 'HEAD';
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
