// Emptying the old tables of a sealed budget, and the check 30 days later (docs/privacy.md section 8, steps 8
// and 9; phase 6). After the cutover the budget lives in its sealed log; the tables the old code read are still
// there, readable, for the 7 days of the way back. Once the way back has closed, and only when the person asks
// (Settings → Privacy, a fresh passkey check: deleting the old copy can't be undone), a job empties them:
//
//   triggers  The triggers on the old tables go first, on this store only: `bank_event`, `bank_page` and
//             `raw_page` refuse deletes, every delete on a synced table writes a `change_log` row, and a delete
//             on `connection` deletes its `bank_link` row, which the sealed fetch needs. A store migration can't
//             do this: it would run in every budget's store, sealed or not (D-99).
//   tables    Each old table, a few rows a step, children before parents. A day's rows written have a limit of
//             their own, and the breaker's pause (70% of a daily limit) holds the job until the next day.
//   budget    The budget row stays (the store knows its budget by it), with its name gone.
//   check     31 days later (Cloudflare's point-in-time recovery reaches 30 days back), every old table is
//             looked at again, with the budget's name here and in the Directory. The result is kept.
//
// The sealed tables, the job queue and the bank links are never touched.
import type { Db } from '@ledgerline/db/sql';
import type { Handler, StepResult } from '../store/jobs.js';
import { nextUtcMidnight } from '../store/jobs.js';

export const PURGE = 'purge_old';
export const PURGE_ID = 'purge_old';
/** Cloudflare's point-in-time recovery reaches 30 days back; the check waits a day more. */
export const CHECK_AFTER_MS = 31 * 86_400_000;
/** Rows deleted in one step; the tables of large rows (bank pages, up to about 200 KB each) take fewer. */
export const PURGE_ROWS = 200;
const ROWS_FOR: Record<string, number> = {
  raw_page: 4,
  sync_page: 4,
  bank_page: 8,
  inbox_run: 50,
  bank_event: 100,
};
/** Rows written (with their index entries) in one UTC day, at most, so that the purge leaves room for the rest. */
export const PURGE_ROWS_PER_DAY = 20_000;
/** Triggers dropped in one step. */
const TRIGGERS_PER_STEP = 20;
/** Time between steps: the alarm comes back soon, but no step runs straight after the one before. */
const STEP_GAP_MS = 2_000;

/**
 * Tables the sealed budget lives in, the job queue and the budget row (the store knows its budget by it): never
 * emptied. `inbox_run` and `inbox_scan` are store tables too, but plain (the shadow run's inbox), so they go.
 */
export const KEPT_TABLES: ReadonlySet<string> = new Set([
  'store_mark',
  'bank_link',
  'log_entry',
  'log_state',
  'key_stamp',
  'run_state',
  'link_cursor',
  'run_stage',
  'sealed_page',
  'sealed_run',
  'snapshot',
  'snapshot_chunk',
  'store_note',
  'job',
  'budget',
]);

export interface PurgeState {
  phase: 'triggers' | 'tables' | 'budget' | 'check';
  /** The old tables, in the order they are emptied. */
  tables?: string[];
  /** The table being emptied. */
  i?: number;
  /** The UTC day and the rows written in it. */
  day?: number;
  written?: number;
}

export interface PurgeDeps {
  db: Db;
  /** 'pause' when the account is past 70% of a daily limit (sync/breaker.ts). */
  budgetState: () => Promise<'normal' | 'pause'>;
  /** The budget's name in the Directory (only the default "My budget" is ever written there). */
  directoryName: () => Promise<string | null>;
}

const note = async (db: Db, key: string): Promise<number | null> =>
  (await db.prepare(`SELECT value FROM store_note WHERE key = ?1`).bind(key).first<{ value: number }>())
    ?.value ?? null;
const setNote = (db: Db, key: string, value: number) =>
  db
    .prepare(
      `INSERT INTO store_note (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value);

const sealed = async (db: Db): Promise<boolean> =>
  (await db.prepare(`SELECT 1 AS x FROM store_mark WHERE key = 'sealed'`).first()) !== null;

/** Why the old tables can't be emptied now, or null when they can. */
export async function purgeRefusal(db: Db, now: number): Promise<string | null> {
  if (!(await sealed(db))) return 'This budget is not locked.';
  const at = await note(db, 'cutover_at');
  if (at === null) return 'This budget is not locked.';
  // The owner may delete it before the way back closes (Nov 13, 2026): starting ends the way back for good
  // (cutoverBack refuses once `purge_started_at` is noted).
  void now;
  return null;
}

/**
 * The old tables, children before parents: the ones the full backup doesn't list first (the change log, the undo
 * records, the inbox), then the backup's tables from the last to the first (it lists parents first).
 */
/** The tables of the server's full backup from before D-102, parents first: the order the old tables go in. */
const BACKUP_ORDER = [
  'alert',
  'apply_counter',
  'audit_log',
  'bank_event',
  'bank_page',
  'bank_txn',
  'budget',
  'expected_reimbursement',
  'health_status',
  'holding_snapshot',
  'liability_snapshot',
  'not_same',
  'owed_close',
  'payee',
  'raw_page',
  'rule',
  'setting',
  'txn_link',
  'txn_overlay',
  'txn_split',
  'usage_daily',
  'usage_event',
  'usage_note',
  'account',
  'category_group',
  'connection',
  'payee_alias',
  'category',
  'manual_pending',
  'provider_account',
  'sync_run',
  'assignment',
  'sync_page',
  'target',
] as const;

export async function oldTables(db: Db): Promise<string[]> {
  const rows = (
    await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all<{ name: string }>()
  ).results.map((r) => r.name);
  const order = BACKUP_ORDER as readonly string[];
  const old = rows.filter((t) => !KEPT_TABLES.has(t));
  const rank = (t: string) => {
    const i = order.indexOf(t);
    return i < 0 ? -1 : order.length - i;
  };
  return old.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Deletes up to `n` rows of a table; gives the rows deleted and the rows written (with index entries). */
async function deleteSome(db: Db, t: string, n: number): Promise<{ deleted: number; written: number }> {
  const def = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`)
    .bind(t)
    .first<{ sql: string }>();
  let which = 'rowid';
  if (/WITHOUT\s+ROWID/i.test(def?.sql ?? '')) {
    const cols = (
      await db.prepare(`PRAGMA table_info(${quote(t)})`).all<{ name: string; pk: number }>()
    ).results
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quote(c.name));
    which = cols.length === 1 ? cols[0]! : `(${cols.join(', ')})`;
  }
  const sel = which.startsWith('(') ? which.slice(1, -1) : which;
  const r = await db
    .prepare(`DELETE FROM ${quote(t)} WHERE ${which} IN (SELECT ${sel} FROM ${quote(t)} LIMIT ?1)`)
    .bind(n)
    .run();
  return { deleted: r.changes, written: r.rowsWritten };
}

/** Starts the job, once. Refused before the way back closes and for a budget that is not sealed. */
export async function purgeStart(
  db: Db,
  now: number,
  enqueue: (kind: string, o: { id: string; state: PurgeState; runAt: number }) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const why = await purgeRefusal(db, now);
  if (why) return { ok: false, why };
  if ((await note(db, 'purge_done_at')) !== null) return { ok: true };
  const running = await db
    .prepare(`SELECT failed_at FROM job WHERE id = ?1`)
    .bind(PURGE_ID)
    .first<{ failed_at: number | null }>();
  if (running && running.failed_at === null) return { ok: true };
  if ((await note(db, 'purge_started_at')) === null) await setNote(db, 'purge_started_at', now).run();
  // A job that stopped starts again from the top: each step is safe to run again.
  await enqueue(PURGE, { id: PURGE_ID, state: { phase: 'triggers' }, runAt: now });
  return { ok: true };
}

export function purgeHandler(deps: PurgeDeps): Handler {
  return async (job, now): Promise<StepResult> => {
    const db = deps.db;
    const s = job.state as PurgeState;
    // Checked again at every step: whatever queued this job, nothing is deleted from a budget that isn't sealed,
    // or while the way back is open.
    const why = await purgeRefusal(db, now);
    if (why) {
      console.log(JSON.stringify({ event: 'purge_refused', why }));
      return { done: true };
    }
    if (s.phase === 'check') {
      await purgeCheck(deps, now);
      return { done: true };
    }
    if (s.phase !== 'triggers' && (await deps.budgetState()) === 'pause')
      return { state: s, runAt: nextUtcMidnight(now) };
    const today = Math.floor(now / 86_400_000);
    const day = today;
    const written = s.day === today ? (s.written ?? 0) : 0;
    if (written >= PURGE_ROWS_PER_DAY) return { state: { ...s, day, written }, runAt: nextUtcMidnight(now) };

    switch (s.phase) {
      case 'triggers': {
        const tables = await oldTables(db);
        const on = [...tables, 'budget'];
        const triggers = (
          await db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(?1))`,
            )
            .bind(JSON.stringify(on))
            .all<{ name: string }>()
        ).results;
        // A few at a time: each drop rewrites the schema, which reads it whole.
        const some = triggers.slice(0, TRIGGERS_PER_STEP);
        await db.batch(some.map((t) => db.prepare(`DROP TRIGGER IF EXISTS ${quote(t.name)}`)));
        if (triggers.length > some.length) return { state: { phase: 'triggers', day, written }, runAt: now };
        return { state: { phase: 'tables', tables, i: 0, day, written }, runAt: now };
      }
      case 'tables': {
        const tables = s.tables ?? [];
        const i = s.i ?? 0;
        const t = tables[i];
        if (t === undefined) return { state: { phase: 'budget', day, written }, runAt: now };
        const exists = await db
          .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?1`)
          .bind(t)
          .first();
        const n = ROWS_FOR[t] ?? PURGE_ROWS;
        const r = exists ? await deleteSome(db, t, n) : { deleted: 0, written: 0 };
        await db.batch([
          setNote(db, 'purge_tables', tables.length),
          setNote(db, 'purge_done_tables', r.deleted < n ? i + 1 : i),
          db
            .prepare(
              `INSERT INTO store_note (key, value) VALUES ('purge_rows', ?1)
               ON CONFLICT (key) DO UPDATE SET value = value + excluded.value`,
            )
            .bind(r.deleted),
        ]);
        const next: PurgeState = {
          phase: 'tables',
          tables,
          i: r.deleted < n ? i + 1 : i,
          day,
          written: written + r.written,
        };
        return { state: next, runAt: now + STEP_GAP_MS };
      }
      case 'budget': {
        await db.batch([db.prepare(`UPDATE budget SET name = ''`), setNote(db, 'purge_done_at', now)]);
        console.log(JSON.stringify({ event: 'purge_done' }));
        return { state: { phase: 'check' }, runAt: now + CHECK_AFTER_MS };
      }
    }
    return { done: true };
  };
}

/** What the check found: the old tables that still hold a row, and whether a name is still kept. */
export async function purgeFindings(deps: Pick<PurgeDeps, 'db' | 'directoryName'>): Promise<string[]> {
  const left: string[] = [];
  for (const t of await oldTables(deps.db))
    if (await deps.db.prepare(`SELECT 1 AS x FROM ${quote(t)} LIMIT 1`).first()) left.push(t);
  const b = await deps.db.prepare(`SELECT name FROM budget LIMIT 1`).first<{ name: string }>();
  if (b && b.name !== '') left.push('budget name');
  const dir = await deps.directoryName();
  // The Directory has only ever held the default name; anything else is a name the person chose.
  if (dir !== null && dir !== '' && dir !== 'My budget') left.push('budget name in the Directory');
  return left;
}

async function purgeCheck(deps: PurgeDeps, now: number): Promise<void> {
  const left = await purgeFindings(deps);
  await deps.db.batch([
    setNote(deps.db, 'purge_checked_at', now),
    setNote(deps.db, 'purge_left', left.length),
  ]);
  console.log(JSON.stringify({ event: 'purge_checked', left }));
}

export interface PurgeStatus {
  /** waiting: the way back is open; ready: it closed and nothing is deleted yet. */
  stage: 'none' | 'waiting' | 'ready' | 'running' | 'stopped' | 'done' | 'checked';
  /** Tables emptied, of how many; rows deleted. */
  tables: number;
  done: number;
  rows: number;
  startedAt: number | null;
  doneAt: number | null;
  /** When the check runs (done) or ran (checked). */
  checkAt: number | null;
  /** The check found nothing readable left (checked only). */
  clean: boolean | null;
}

/** Where the emptying stands, for Settings → Privacy. */
export async function purgeStatus(db: Db, now: number): Promise<PurgeStatus> {
  const n = async (k: string) => note(db, k);
  const base = {
    tables: (await n('purge_tables')) ?? 0,
    done: (await n('purge_done_tables')) ?? 0,
    rows: (await n('purge_rows')) ?? 0,
    startedAt: await n('purge_started_at'),
    doneAt: await n('purge_done_at'),
    checkAt: null as number | null,
    clean: null as boolean | null,
  };
  if (!(await sealed(db))) return { stage: 'none', ...base };
  const checked = await n('purge_checked_at');
  if (checked !== null)
    return { stage: 'checked', ...base, checkAt: checked, clean: (await n('purge_left')) === 0 };
  if (base.doneAt !== null) return { stage: 'done', ...base, checkAt: base.doneAt + CHECK_AFTER_MS };
  if (base.startedAt !== null) {
    const job = await db
      .prepare(`SELECT failed_at FROM job WHERE id = ?1`)
      .bind(PURGE_ID)
      .first<{ failed_at: number | null }>();
    return { stage: job && job.failed_at === null ? 'running' : 'stopped', ...base };
  }
  return { stage: (await purgeRefusal(db, now)) ? 'waiting' : 'ready', ...base };
}
