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
import { SYNC_FORMAT, SYNC_TABLES, triggerNames, type SyncTable } from '../sync-tables.js';
import type { BankLogBatch, SyncPage, SyncRow } from '../routes/sync.js';
import { Shadow, type Fork, type ShadowEvent, type ShadowReport } from './shadow.js';
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
  /**
   * Queued edits that no longer pass on the server's newer rows (the row they change is gone): taken out of the
   * copy and out of the queue. Set only when the queue was run again on top of this page.
   */
  lost?: number;
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
  // The bank log only grows, on the server and here. One thing a copy takes back out: a bank run it filed
  // itself, when the log took another device's entry for it (local/sealed-filing.ts resetFiling). So the copy's
  // own guard lets the rows of a sealed run be deleted, and no others.
  await db.batch(
    ['bank_event', 'bank_page'].flatMap((t) => [
      db.prepare(`DROP TRIGGER IF EXISTS ${t}_no_delete`),
      db.prepare(
        `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} WHEN OLD.sync_run_id NOT LIKE 'sealed:%' BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END`,
      ),
    ]),
  );
  await db.batch([
    ...PHONE_TABLES.map((sql) => db.prepare(sql)),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
  ]);
  // What one edit changed, while the engine records it (LocalEngine.record): one line per changed row, with the
  // row as it was before the edit first touched it (`had` 0: there was none). Nothing is kept here between edits,
  // so the table and its triggers are made again at each open: a migration may have added a column.
  const columns = new Map<string, string[]>();
  for (const t of RECORDED_TABLES) {
    const info = await db.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all<{ name: string }>();
    columns.set(
      t.name,
      info.results.map((c) => c.name).filter((c) => !t.omit?.includes(c) && !WORKED_OUT[t.name]?.includes(c)),
    );
  }
  await db.batch([
    db.prepare(`DROP TABLE IF EXISTS edit_change`),
    db.prepare(
      `CREATE TABLE edit_change (
         tbl TEXT NOT NULL, pk TEXT NOT NULL, n INTEGER NOT NULL, deleted INTEGER NOT NULL,
         had INTEGER NOT NULL, before TEXT, PRIMARY KEY (tbl, pk)
       ) WITHOUT ROWID`,
    ),
    ...RECORDED_TABLES.flatMap((t) => recordTriggers(t, columns.get(t.name)!)).map((sql) => db.prepare(sql)),
    // A copy closed in the middle of a recording starts with it off.
    db.prepare(`DELETE FROM local_state WHERE key = 'recording'`),
  ]);
}

/**
 * The tables an edit's recording covers: the ones the phone syncs, and the two others an edit writes
 * (docs/privacy.md 5.3, "What the row changes cover"). `audit_log` is the record an undo reads; `txn_key_move` says
 * where a transaction's key went. The server never sends these two in a sync: they reach a copy only as the
 * recorded rows of an edit.
 */
export const RECORDED_TABLES: readonly SyncTable[] = [
  ...SYNC_TABLES,
  { name: 'audit_log', pk: ['id'] },
  { name: 'txn_key_move', pk: ['old_key'] },
];

/**
 * Columns derive() works out, in a table an edit also writes: left out of the row kept for taking an edit back
 * out, so that an undo never puts an older worked-out value over a newer one.
 */
export const WORKED_OUT: Record<string, readonly string[]> = {
  budget: ['rta', 'summary_version', 'summary_month', 'summary_dirty_from'],
};

/** Set while the engine records an edit; the triggers below write nothing at any other time (a sync, derive()). */
const RECORDING = `(SELECT value FROM local_state WHERE key = 'recording') = '1'`;

/**
 * The copy's own triggers for one table. They write into `edit_change`, only while an edit is being recorded: the
 * row's key, whether it is gone now, and the row as it was before this edit first touched it (kept from the first
 * touch: a later change to the same row in the same edit doesn't replace it).
 */
function recordTriggers(t: SyncTable, columns: readonly string[]): string[] {
  const pk = (row: 'NEW' | 'OLD') => `json_array(${t.pk.map((c) => `${row}.${c}`).join(', ')})`;
  const old = `json_object(${columns.map((c) => `'${c}', OLD.${c}`).join(', ')})`;
  const n = `(SELECT coalesce(max(n), 0) + 1 FROM edit_change)`;
  const log = (row: 'NEW' | 'OLD', deleted: 0 | 1, had: 0 | 1) =>
    `INSERT INTO edit_change (tbl, pk, n, deleted, had, before) VALUES ('${t.name}', ${pk(row)}, ${n}, ${deleted}, ${had}, ${had ? old : 'NULL'}) ON CONFLICT (tbl, pk) DO UPDATE SET n = excluded.n, deleted = ${deleted};`;
  const moved = t.pk.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const name = (kind: string) => `${t.name}_rec_${kind}`;
  const make = (kind: string, when: string, body: string) =>
    [
      `DROP TRIGGER IF EXISTS ${name(kind)}`,
      `CREATE TRIGGER ${name(kind)} AFTER ${when} ON ${t.name} WHEN ${RECORDING}`,
    ].join(';;') + ` ${body}`;
  return [
    make('ins', 'INSERT', `BEGIN ${log('NEW', 0, 0)} END`),
    make('upd', 'UPDATE', `AND NOT (${moved}) BEGIN ${log('NEW', 0, 1)} END`),
    // A changed primary key: the old key's row is gone, and the new key had no row.
    make('key', 'UPDATE', `AND (${moved}) BEGIN ${log('OLD', 1, 1)} ${log('NEW', 0, 0)} END`),
    make('del', 'DELETE', `BEGIN ${log('OLD', 1, 1)} END`),
  ].flatMap((sql) => {
    const [drop, create] = sql.split(';;');
    return [drop!, create!];
  });
}

/** The app was closed while the copy was filing bank runs (LocalEngine.fileBank): the copy must be made again. */
export class FilingInterrupted extends Error {
  constructor() {
    super('this copy was closed while it was filing bank runs');
  }
}

/** Rows that no honest writer makes (LocalEngine checkRows): nothing of them was written. */
export class RowsRefused extends Error {}

/** An edit the engine ran and recorded. */
export interface Recorded {
  response: Response;
  /** The rows the edit changed, as they are after it. */
  rows: SyncRow[];
  /**
   * The same rows as they were before it, newest change first: written with `applyRows`, they take the edit back
   * out of the copy (the redo of a refused write, docs/privacy.md 5.3).
   */
  undo: SyncRow[];
}

/**
 * An edit kept on the device until the server takes it. The engine owns the queue (`local_state`, key `outbox`):
 * every change to it is one step of the engine, so the copy and its queue can't come apart.
 */
export interface QueuedEdit {
  id: string;
  at: number;
  method: string;
  path: string;
  body: unknown;
  appVersion?: string;
  /**
   * What takes the edit back out of the copy, and the change number the copy held when the edit ran. The undo is
   * good only while the copy still holds that number. An edit with neither (queued by an older app, or after the
   * copy was downloaded again) can only be sent.
   */
  undo?: SyncRow[];
  through?: number;
  /**
   * The rows the edit changed, as they were after it: what the edit's entry in the log holds (local/log-session.ts).
   * Made again whenever the edit is run again.
   */
  rows?: SyncRow[];
  /**
   * The server may hold this edit: the app is sending it, or sent it and lost the answer. The copy never runs
   * such an edit again by itself; a sync brings its rows.
   */
  sending?: boolean;
  /**
   * Not an edit: bank runs this device filed (`LocalEngine.fileBank`), waiting to become a bank entry of the log.
   * Always first in the queue: the edits after it ran on top of it. It is never run again by the engine (the
   * runs are not kept here): when it must come out, it is dropped, and the device files the runs again.
   */
  bank?: { filedThrough: number; receipts: string[] };
}

/** An edit whose undo is good for a copy at change number `through`. */
type Exact = QueuedEdit & { undo: SyncRow[]; through: number };
const exactAt = (e: QueuedEdit, through: number): e is Exact =>
  Array.isArray(e.undo) && e.through === through;

/** Where the app keeps its queue of edits (apps/web/src/copy/copy.ts), in `local_state`. */
const OUTBOX = 'outbox';

export class LocalEngine {
  private readonly app: Hono<AppEnv>;

  constructor(
    readonly db: Db,
    private readonly who: EngineIdentity,
    /** The device's clock; corrected by the measured offset from the server. */
    private readonly deviceNow: () => number = () => Date.now(),
    /** Called when Ready to Assign doesn't satisfy rule 10 (the identity check). */
    private readonly onIdentity?: (r: { difference: number; month: string }) => Promise<void>,
    /** Makes a scratch copy of this database, for the shadow run (local/shadow.ts). */
    private readonly fork?: () => Promise<Fork>,
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
  async apply(
    page: SyncPage,
    receivedAt = this.deviceNow(),
    /** The tables the page may write: a sync's, or everything an entry of the log carries (local/log-session.ts). */
    tables: readonly SyncTable[] = SYNC_TABLES,
  ): Promise<ApplyResult> {
    const st = await this.state();
    const fresh = st.epoch === null && st.through === 0 && st.cursor === null;
    if (!fresh && (page.epoch !== st.epoch || page.format !== st.format)) {
      await this.clear();
      return { reset: true, rows: 0, caughtUp: false };
    }
    // Edits wait in the queue: the server's rows go under them, not over them. The queue is taken out of the copy
    // (which is then the server's rows as of `st.through`), the page is written, and the queue is run again on
    // top (docs/privacy.md 5.3). Only when that can be done exactly. A sync of several pages takes the queue out
    // before its first page and runs it again after its last: `held` is the queue while it is out.
    await this.checkRows(page.rows, tables, tables !== SYNC_TABLES);
    let held = fresh ? null : await this.heldQueue();
    if (!held && !fresh) {
      const queue = await this.exactQueue(st, page);
      if (queue) {
        for (const e of [...queue].reverse()) await this.applyRows(e.undo);
        held = queue;
        if (page.more) await this.setHeld(queue);
      }
    }
    const stmts: Stmt[] = [this.db.prepare(`PRAGMA defer_foreign_keys = ON`)];
    // What the next derive() must redo (read before the rows change: a moved or deleted row's old key counts too).
    const todo = await this.pendingDerive();
    if (st.cursor || page.cursor || st.through === 0) todo.full = true;
    if (!todo.full) await this.noteChanges(page.rows, todo);
    for (const r of page.rows) stmts.push(...this.rowStatements(r, tables));
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
    // A page of changes with no row (in the log: a key or slot change) leaves the copy as it was, at a new place:
    // what was kept for taking the waiting edits out is still right there.
    if (
      !held &&
      !fresh &&
      page.rows.length === 0 &&
      !st.cursor &&
      !page.cursor &&
      next.through !== st.through
    ) {
      const q = await this.queue();
      if (q.some((e) => exactAt(e, st.through)))
        await this.putQueue(q.map((e) => (exactAt(e, st.through) ? { ...e, through: next.through } : e)));
    }
    const result: ApplyResult = {
      reset: false,
      rows: page.rows.length,
      caughtUp: !page.more && !page.cursor,
    };
    if (held && !page.more) {
      const { kept, lost } = await this.rerun(held, next.through);
      // Edits made while the queue was out (between two pages) ran on a half-synced copy: they stay in the queue
      // to be sent, with nothing kept for taking them out.
      const mine = new Set(held.map((e) => e.id));
      const since = (await this.queue())
        .filter((e) => !mine.has(e.id))
        .map(({ undo: _undo, through: _through, rows: _rows, ...e }) => e);
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          )
          .bind(OUTBOX, JSON.stringify([...kept, ...since])),
        this.db.prepare(`DELETE FROM local_state WHERE key = 'held_queue'`),
      ]);
      result.lost = lost.length;
    }
    return result;
  }

  /**
   * The queue, when the server's page can go under it: every edit in it ran on the copy as it is now (the same
   * change number, so the rows kept for taking it out are the server's), none is on its way to the server, and
   * the page is one of changes, not of a download.
   */
  private async exactQueue(st: EngineState, page: SyncPage): Promise<Exact[] | null> {
    if (st.cursor || page.cursor || st.through === 0 || page.rows.length === 0) return null;
    const q = await this.queue();
    if (!q.length) return null;
    return q.every((e) => exactAt(e, st.through) && !e.sending) ? (q as Exact[]) : null;
  }

  /** The queue while it is out of the copy, between the pages of one sync; null when it is in. */
  private async heldQueue(): Promise<Exact[] | null> {
    const r = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = 'held_queue'`)
      .first<{ value: string }>();
    return r ? (JSON.parse(r.value) as Exact[]) : null;
  }

  private async setHeld(q: readonly Exact[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('held_queue', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(q))
      .run();
  }

  /** The queue of edits waiting for the server, oldest first. */
  async queue(): Promise<QueuedEdit[]> {
    const r = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = ?1`)
      .bind(OUTBOX)
      .first<{ value: string }>();
    return r ? (JSON.parse(r.value) as QueuedEdit[]) : [];
  }

  private async putQueue(q: readonly QueuedEdit[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(OUTBOX, JSON.stringify(q))
      .run();
  }

  /**
   * Runs queued edits again, in order, on the copy as it is. An edit its route refuses now (4xx: the row it
   * changes is gone) is `lost`. An edit that fails any other way stays in the queue with no undo: the copy doesn't
   * show it until the server has taken it and a sync brings its rows.
   */
  private async rerun(
    queue: readonly QueuedEdit[],
    through: number,
  ): Promise<{ kept: QueuedEdit[]; lost: QueuedEdit[] }> {
    const kept: QueuedEdit[] = [];
    const lost: QueuedEdit[] = [];
    for (const e of queue) {
      // Filed bank runs are not run again here: the device opens and files them again (local/log-session.ts).
      if (e.bank) continue;
      const { undo: _undo, through: _through, rows: _rows, ...bare } = e;
      const r = await this.record(e.method, e.path, e.body, { id: e.id, at: e.at }).catch(() => null);
      const status = r?.response.status ?? 500;
      if (status < 300) kept.push({ ...bare, undo: r!.undo, rows: r!.rows, through });
      else if (status < 500) lost.push(e);
      else kept.push(bare);
    }
    if (await this.needsDerive()) await this.derive();
    return { kept, lost };
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
      owed_close: ['txn_key'],
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

  private readonly columnsOf = new Map<string, Set<string>>();

  private async columns(table: string): Promise<Set<string>> {
    let c = this.columnsOf.get(table);
    if (!c) {
      const info = await this.db
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all<{ name: string }>();
      c = new Set(info.results.map((x) => x.name));
      this.columnsOf.set(table, c);
    }
    return c;
  }

  /**
   * Refuses rows no honest writer makes, before any of them is written: a table that is not one of `tables`
   * (`strict`: the rows of a log entry; a sync skips a table it doesn't know, as a newer server may have one), a
   * key of the wrong length, a column the table doesn't have, a value that is not text, a number or null, or a
   * row whose key columns differ from its key. A row's table and column names go into SQL, so they must be the
   * copy's own names and nothing else: rows come from the server, or from another device through the log.
   */
  private async checkRows(
    rows: readonly SyncRow[],
    tables: readonly SyncTable[],
    strict: boolean,
  ): Promise<void> {
    const scalar = (v: unknown) =>
      v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
    const refuse = (why: string): never => {
      throw new RowsRefused(why);
    };
    for (const r of rows) {
      if (!r || typeof r.t !== 'string') return refuse('not a row');
      const t = tables.find((x) => x.name === r.t);
      if (!t) {
        if (strict) refuse('a table this copy does not keep');
        continue;
      }
      if (!Array.isArray(r.k) || r.k.length !== t.pk.length || !r.k.every(scalar))
        refuse(`${t.name}: its key`);
      if (r.d === null) continue;
      if (typeof r.d !== 'object' || Array.isArray(r.d)) refuse(`${t.name}: not a row`);
      const cols = await this.columns(t.name);
      for (const [c, v] of Object.entries(r.d)) {
        if (!cols.has(c)) refuse(`${t.name}: a column this copy does not have`);
        if (!scalar(v)) refuse(`${t.name}: a value that is not text, a number or null`);
      }
      t.pk.forEach((c, i) => {
        if (r.d![c] !== r.k[i]) refuse(`${t.name}: the row is not the one its key names`);
      });
    }
  }

  private rowStatements(r: SyncRow, tables: readonly SyncTable[] = SYNC_TABLES): Stmt[] {
    const t = tables.find((x) => x.name === r.t);
    if (!t) return [];
    const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
    if (!r.d) return [this.db.prepare(`DELETE FROM ${t.name} WHERE ${where}`).bind(...r.k)];
    const cols = Object.keys(r.d);
    const vals = cols.map((c) => r.d![c]);
    const update = cols
      .filter((c) => !t.pk.includes(c))
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    // The server's row replaces a row of the copy that is the same thing under another primary key (an edit made
    // offline gave it an id of its own): without this the row's other unique key refuses the write, and every later
    // page with it.
    const displaced = (t.unique ?? [])
      .filter((key) => key.every((c) => r.d![c] !== undefined && r.d![c] !== null))
      .map((key) =>
        this.db
          .prepare(
            `DELETE FROM ${t.name} WHERE ${key.map((c, i) => `${c} = ?${i + 1}`).join(' AND ')}
               AND NOT (${t.pk.map((c, i) => `${c} = ?${key.length + i + 1}`).join(' AND ')})`,
          )
          .bind(...key.map((c) => r.d![c]), ...r.k),
      );
    return [
      ...displaced,
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
    // The rows kept for taking a queued edit out were this copy's: they mean nothing to the next download, even
    // one that ends on the same change number.
    const q = await this.queue();
    if (q.length) await this.putQueue(q.map(({ undo: _undo, through: _through, rows: _rows, ...e }) => e));
    // The next download already holds every bank update so far: the shadow run starts over from there. A queue
    // that was out of the copy between two pages is simply the queue again.
    await this.db
      .prepare(`DELETE FROM local_state WHERE key IN ('shadow_seq', 'shadow_scan', 'held_queue', 'filing')`)
      .run();
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

  private env(now: number, through?: number): Env {
    return {
      DB: this.db,
      PLAID_ENV: 'engine',
      // The time of this request, given by the engine (the device's clock plus its offset from the server's).
      NOW: now,
      ...(through === undefined ? {} : { THROUGH: through }),
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
  async request(
    method: string,
    path: string,
    body?: unknown,
    /**
     * A change the phone makes: its own id and the moment the person made it. The request runs at that moment, and
     * its new rows get their ids from that id, so the server, which gets both with the queued edit, makes the same
     * rows (docs/privacy.md 5.3).
     */
    edit?: { id: string; at: number },
  ): Promise<Response> {
    return (await this.run(method, path, body, edit, false)).response;
  }

  /**
   * Runs an edit and gives the rows it changed, as they are after it: what a log entry for the edit holds
   * (docs/privacy.md 5.3: an entry is results, not operations). Another copy that writes these rows with
   * `applyRows` has the edit without running it. Only the edit's own writes are recorded, not what derive() works
   * out from them. Covers RECORDED_TABLES.
   */
  async record(
    method: string,
    path: string,
    body: unknown,
    edit: { id: string; at: number },
  ): Promise<Recorded> {
    return this.run(method, path, body, edit, true);
  }

  /**
   * An edit made on this device with no connection: runs it, and puts it in the queue with what takes it back
   * out, in one step. `sending`: the edit already went to the server once and the answer was lost, so the server
   * may hold it.
   */
  async enqueue(e: {
    id: string;
    at: number;
    method: string;
    path: string;
    body: unknown;
    appVersion?: string;
    sending?: boolean;
  }): Promise<{ response: Response; queued: number }> {
    const through = (await this.state()).through;
    const r = await this.record(e.method, e.path, e.body, { id: e.id, at: e.at });
    const q = await this.queue();
    if (r.response.status < 300) {
      q.push({ ...e, undo: r.undo, rows: r.rows, through });
      await this.putQueue(q);
    }
    return { response: r.response, queued: q.length };
  }

  /** The app is about to send this edit: from now on the server may hold it. */
  async queueSending(id: string): Promise<void> {
    const q = await this.queue();
    const e = q.find((x) => x.id === id);
    if (!e || e.sending) return;
    e.sending = true;
    await this.putQueue(q);
  }

  /** The server took this edit: it leaves the queue. Gives how many are left. */
  async queueDone(id: string): Promise<number> {
    const q = (await this.queue()).filter((x) => x.id !== id);
    await this.putQueue(q);
    return q.length;
  }

  /**
   * The log took this edit as an entry (local/log-session.ts): it leaves the queue, and the copy now stands at
   * the log's new last entry. The edits still waiting ran on top of it, so what was kept for taking them out is
   * still right, at the new place.
   */
  async queueSent(id: string, through: number): Promise<number> {
    const st = await this.state();
    const q = (await this.queue())
      .filter((x) => x.id !== id)
      .map((x) => (exactAt(x, st.through) ? { ...x, through } : x));
    await this.db.batch([
      this.setState({ ...st, through }),
      this.db
        .prepare(
          `INSERT INTO local_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(OUTBOX, JSON.stringify(q)),
    ]);
    return q.length;
  }

  /**
   * The server refused this edit. It leaves the queue, and the copy when that can be done exactly: the edit and
   * every one queued after it (they ran on top of it) ran on the copy as it is now, so they are taken out, newest
   * first, and the later ones are run again. A later edit that no longer passes (it changed a row the refused
   * edit made) is lost too. When it can't be done exactly, `redownload` says the copy still shows the refused
   * edit and must be downloaded again.
   */
  async queueRefused(id: string): Promise<{ redownload: boolean; lost: number; left: number }> {
    const q = await this.queue();
    const i = q.findIndex((x) => x.id === id);
    if (i < 0) return { redownload: false, lost: 0, left: q.length };
    const before = q.slice(0, i);
    const refused = q[i]!;
    const later = q.slice(i + 1);
    const through = (await this.state()).through;
    if (!exactAt(refused, through) || !later.every((e) => exactAt(e, through) && !e.sending)) {
      await this.putQueue([...before, ...later]);
      return { redownload: true, lost: 0, left: q.length - 1 };
    }
    for (const e of [...(later as Exact[])].reverse()) await this.applyRows(e.undo);
    await this.applyRows(refused.undo);
    const { kept, lost } = await this.rerun(later, through);
    await this.putQueue([...before, ...kept]);
    return { redownload: false, lost: lost.length, left: before.length + kept.length };
  }

  /**
   * Files bank runs on the copy, under the queue (docs/privacy.md 5.4): the waiting edits come out, `work` files
   * the runs with everything it writes recorded, and the edits run again on top. What was filed waits first in
   * the queue, as `bank`, until the log takes it as a bank entry. Null when it can't be done exactly now (an edit
   * is on its way, was queued on another base, or filed runs already wait): read the log, then try again. If
   * `work` throws, what it wrote is taken back out and the copy is as it was.
   */
  async fileBank(
    id: string,
    at: number,
    bank: { filedThrough: number; receipts: string[] },
    work: (env: Env) => Promise<void>,
  ): Promise<{ rows: SyncRow[]; lost: number } | null> {
    if (await this.filingInterrupted()) throw new FilingInterrupted();
    if (!(await this.canFileBank())) return null;
    const st = await this.state();
    const q = await this.queue();
    // Filing is many steps. If the app is closed in the middle, the copy holds half of it: the mark says so, and
    // the copy is then made again from the log, never used as it is.
    await this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('filing', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(String(st.through))
      .run();
    const finished = () => this.db.prepare(`DELETE FROM local_state WHERE key = 'filing'`);
    for (const e of [...(q as Exact[])].reverse()) await this.applyRows(e.undo);
    let rec: { rows: SyncRow[]; undo: SyncRow[] } = { rows: [], undo: [] };
    let failed: unknown = null;
    await this.db.batch([this.db.prepare(`DELETE FROM edit_change`), this.recording(true)]);
    try {
      await work(this.env(at));
    } catch (x) {
      failed = x ?? new Error('filing failed');
    } finally {
      rec = await this.recorded();
      await this.db.batch([this.recording(false), this.db.prepare(`DELETE FROM edit_change`)]);
    }
    if (failed) {
      await this.applyRows(rec.undo);
      const { kept } = await this.rerun(q, st.through);
      await this.putQueue(kept);
      await finished().run();
      throw failed;
    }
    // What derive() must work out again: the rows as they were name the old keys, the copy holds the new ones.
    const todo = await this.pendingDerive();
    await this.noteChanges(rec.undo, todo);
    await this.db.batch([this.setPendingDerive(todo)]);
    const filed: QueuedEdit = {
      id,
      at,
      method: 'BANK',
      path: '',
      body: null,
      undo: rec.undo,
      rows: rec.rows,
      through: st.through,
      bank,
    };
    await this.putQueue([filed, ...q]);
    const { kept, lost } = await this.rerun(q, st.through);
    await this.putQueue([filed, ...kept]);
    await finished().run();
    if (await this.needsDerive()) await this.derive();
    return { rows: rec.rows, lost: lost.length };
  }

  /** Whether bank runs can be filed under the queue now: every waiting edit can be taken out exactly. */
  async canFileBank(): Promise<boolean> {
    const st = await this.state();
    const q = await this.queue();
    return !st.cursor && !q.some((e) => e.bank || !exactAt(e, st.through) || e.sending);
  }

  /** The app was closed while this copy was filing bank runs: the copy holds half of it and must be made again. */
  async filingInterrupted(): Promise<boolean> {
    return !!(await this.db.prepare(`SELECT 1 AS x FROM local_state WHERE key = 'filing'`).first());
  }

  // ---- the shadow run (local/shadow.ts): the device files the inbox's bank updates on a scratch copy

  private shadow: { run: Shadow; token: number } | null = null;
  private shadowTokens = 0;

  /**
   * Makes the scratch copy for a shadow run, before the server's rows for newer bank updates are written into
   * this copy. Gives a token for the later steps (a newer run replaces an unfinished one, whose steps then do
   * nothing), or null when this engine can't make a scratch copy.
   */
  async shadowFork(): Promise<number | null> {
    this.shadow?.run.discard();
    this.shadow = null;
    if (!this.fork) return null;
    const run = await Shadow.fork(this.db, this.who.budgetId, this.fork);
    this.shadow = { run, token: ++this.shadowTokens };
    return this.shadow.token;
  }

  private shadowOf(token: number): Shadow | null {
    return this.shadow?.token === token ? this.shadow.run : null;
  }

  /** The updates to file. Null: ready to step. A report: a comparison would say nothing, and why. */
  async shadowBegin(token: number, runs: ShadowEvent[]): Promise<ShadowReport | null> {
    const s = this.shadowOf(token);
    return s ? s.begin(runs) : { runs: 0, compared: false, why: 'incomplete', differences: [] };
  }

  /** Files the next update on the scratch copy; false when none is left. */
  async shadowStep(token: number): Promise<boolean> {
    return (await this.shadowOf(token)?.step()) ?? false;
  }

  /** Compares the scratch copy with this one (which holds the server's rows by now) and frees it. */
  async shadowEnd(token: number): Promise<ShadowReport | null> {
    const s = this.shadowOf(token);
    if (!s) return null;
    this.shadow = null;
    return s.end(this.db);
  }

  /** What to ask the server's bank log for next (routes/sync.ts `/sync/bank-log`). */
  async bankLogRequest(): Promise<{ after: number; pagesAfter: string | null }> {
    const r = await this.db
      .prepare(`SELECT value FROM local_state WHERE key = 'bank_log'`)
      .first<{ value: string }>();
    return r
      ? (JSON.parse(r.value) as { after: number; pagesAfter: string | null })
      : { after: 0, pagesAfter: null };
  }

  /**
   * Adds a batch of the server's bank log to the copy's own (docs/privacy.md 5.4). Rows are only ever added: the
   * copy has the same append-only triggers as the server, and a row it already holds is left as it is.
   */
  async applyBankLog(batch: BankLogBatch): Promise<{ rows: number; caughtUp: boolean }> {
    const insert = (table: string, row: Record<string, unknown>): Stmt => {
      const cols = Object.keys(row);
      return this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`,
        )
        .bind(...cols.map((c) => row[c]));
    };
    const stmts: Stmt[] = [
      ...batch.pages.map((r) => insert('bank_page', r)),
      ...batch.events.map((r) => insert('bank_event', r)),
      this.db
        .prepare(
          `INSERT INTO local_state (key, value) VALUES ('bank_log', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .bind(JSON.stringify({ after: batch.after, pagesAfter: batch.pagesAfter })),
    ];
    for (const part of chunks(stmts, 500)) await this.db.batch(part);
    return { rows: batch.pages.length + batch.events.length, caughtUp: !batch.more };
  }

  /** Writes rows another copy recorded, and marks what derive() must work out again. */
  async applyRows(rows: SyncRow[]): Promise<void> {
    await this.checkRows(rows, RECORDED_TABLES, true);
    const todo = await this.pendingDerive();
    await this.noteChanges(rows, todo);
    const stmts: Stmt[] = [this.db.prepare(`PRAGMA defer_foreign_keys = ON`)];
    for (const r of rows) stmts.push(...this.rowStatements(r, RECORDED_TABLES));
    stmts.push(this.setPendingDerive(todo));
    for (const part of chunks(stmts, 500)) await this.db.batch(part);
  }

  private recording(on: boolean): Stmt {
    return this.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('recording', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(on ? '1' : '0');
  }

  /**
   * The rows named in `edit_change`, as they are now, in the order they last changed; and what puts each back as it
   * was, newest change first.
   */
  private async recorded(): Promise<{ rows: SyncRow[]; undo: SyncRow[] }> {
    const changes = await this.db
      .prepare(`SELECT tbl, pk, deleted, had, before FROM edit_change ORDER BY n`)
      .all<{ tbl: string; pk: string; deleted: number; had: number; before: string | null }>();
    const rows: SyncRow[] = [];
    const undo: SyncRow[] = [];
    for (const ch of changes.results) {
      const t = RECORDED_TABLES.find((x) => x.name === ch.tbl)!;
      const k = JSON.parse(ch.pk) as unknown[];
      let d: Record<string, unknown> | null = null;
      if (!ch.deleted) {
        const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
        d = await this.db
          .prepare(`SELECT * FROM ${t.name} WHERE ${where}`)
          .bind(...k)
          .first<Record<string, unknown>>();
      }
      rows.push({ t: t.name, k, d });
      undo.unshift({
        t: t.name,
        k,
        d: ch.had && ch.before ? (JSON.parse(ch.before) as Record<string, unknown>) : null,
      });
    }
    return { rows, undo };
  }

  private async run(
    method: string,
    path: string,
    body: unknown,
    edit: { id: string; at: number } | undefined,
    record: boolean,
  ): Promise<Recorded> {
    const now = edit?.at ?? (await this.now());
    const mutation = method !== 'GET' && method !== 'HEAD';
    let rec: { rows: SyncRow[]; undo: SyncRow[] } = { rows: [], undo: [] };
    let r: Response;
    if (record) {
      await this.db.batch([this.db.prepare(`DELETE FROM edit_change`), this.recording(true)]);
      try {
        r = await this.route(method, path, body, now, mutation, edit);
        rec = await this.recorded();
      } finally {
        await this.db.batch([this.recording(false), this.db.prepare(`DELETE FROM edit_change`)]);
      }
    } else r = await this.route(method, path, body, now, mutation, edit);
    return { response: await this.afterEdit(method, path, body, mutation, r), ...rec };
  }

  private async afterEdit(
    method: string,
    path: string,
    body: unknown,
    mutation: boolean,
    r: Response,
  ): Promise<Response> {
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
    edit?: { id: string; at: number },
  ): Promise<Response> {
    const req = new Request(`https://engine.local${path}`, {
      method,
      headers: mutation
        ? {
            'content-type': 'application/json',
            [CSRF_HEADER]: '1',
            origin: 'https://engine.local',
            // As the queued edit will carry them to the server (apps/web/src/copy/copy.ts flush).
            ...(edit ? { 'x-edit-id': edit.id, 'x-edit-at': String(edit.at) } : {}),
          }
        : {},
      body: mutation ? JSON.stringify(body ?? {}) : undefined,
    });
    const through = mutation ? (await this.state()).through : undefined;
    return this.app.fetch(req, this.env(now, through), {
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
