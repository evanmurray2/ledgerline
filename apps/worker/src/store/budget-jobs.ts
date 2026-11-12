// A budget's recurring and on-demand jobs (docs/multi-user.md 6.1, 6.2): the sync backstop every 4 hours, the daily
// scan at 5:00 AM and maintenance at 2:20 AM in the budget's time zone, plus starting a sync. Each store keeps its own
// recurring rows, so nothing has to loop over every budget; a recurring row is never deleted, only moved forward.
import type { Db } from '@ledgerline/db/sql';
import { nextLocalTime } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { dailyScan, scanTime } from '../daily-scan.js';
import { inboxScanned } from './inbox.js';
import { rollUpUsage, watchdogBudgetStmts } from '../maintenance.js';
import { processPending } from '../sync/process.js';
import { updateInFlight } from '../sync/turn.js';
import { fillPlaidNameStep, type FillPlaidNameState } from '../sync/fill-plaid-name.js';
import { QUEUE_REFILE, refilePayeesStep, type RefileState } from '../sync/refile-payees.js';
import { QUEUE_DROP_TEXT_ALIASES, dropTextAliasesStep } from '../sync/drop-text-aliases.js';
import { acquire, requestSync } from '../sync/lease.js';
import { bumpVersion } from '../http/version.js';
import type { Handler, StepResult } from './jobs.js';
import type { SyncState } from './sync-job.js';

export const BACKSTOP_ID = 'recurring:backstop';
export const DAILY_SCAN_ID = 'recurring:daily_scan';
export const MAINTENANCE_ID = 'recurring:maintenance';
const FOUR_HOURS = 4 * 3_600_000;
const SCAN_BATCH = 40; // dailyScan's LIMIT
/** The budget table's default, for a store whose budget row can't be read. */
const DEFAULT_ZONE = 'America/Los_Angeles';

/** Local clock times of the daily jobs. Each run reads the budget's time zone again, so a change takes effect the next day. */
export const nextScan = (now: number, timeZone: string): number => nextLocalTime(now, timeZone, 5, 0);
export const nextMaintenance = (now: number, timeZone: string): number => nextLocalTime(now, timeZone, 2, 20);

async function budgetZone(db: Db, budgetId: string): Promise<string> {
  const b = await db
    .prepare(`SELECT time_zone FROM budget WHERE id = ?1`)
    .bind(budgetId)
    .first<{ time_zone: string }>();
  return b?.time_zone ?? DEFAULT_ZONE;
}

/** The next time (UTC) at hour:minute strictly after now. */
export function nextUtc(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  if (t <= now) t += 86_400_000;
  return t;
}

export interface Enqueue {
  (
    kind: string,
    o: { id?: string; connectionId?: string | null; state?: unknown; runAt: number; recurring?: boolean },
  ): Promise<string>;
}

/** Jobs that failed for good stay visible in health for this long, then the daily prune removes them. */
export const FAILED_JOB_KEEP_MS = 30 * 86_400_000;

/** Recreates any missing recurring row (idempotent). Called when a store's budget is created and by the daily ensureJobs. */
export async function ensureRecurring(enqueue: Enqueue, now: number, timeZone: string): Promise<void> {
  await enqueue('backstop', { id: BACKSTOP_ID, runAt: now + FOUR_HOURS, recurring: true });
  await enqueue('daily_scan', { id: DAILY_SCAN_ID, runAt: nextScan(now, timeZone), recurring: true });
  await enqueue('maintenance', {
    id: MAINTENANCE_ID,
    state: { phase: 'start' },
    runAt: nextMaintenance(now, timeZone),
    recurring: true,
  });
}

/**
 * Starts a sync for one connection, as routes/settings.ts startSync() does: only once the link's
 * accounts are set up; records the request; takes the lease; queues a sync job holding it.
 */
export async function startSyncJob(
  db: Db,
  enqueue: Enqueue,
  connectionId: string,
  trigger: string,
  now: number,
): Promise<boolean> {
  const ready = await db
    .prepare(`SELECT setup_done FROM connection WHERE id = ?1`)
    .bind(connectionId)
    .first<{ setup_done: number }>();
  if (!ready || ready.setup_done !== 1) return false;
  await requestSync(db, connectionId, now);
  const holder = `sync:${ulid(now)}`;
  if (!(await acquire(db, connectionId, holder, now))) return false;
  const state: SyncState = { phase: 'begin', holder, trigger };
  await enqueue('sync', { id: holder, connectionId, state, runAt: now });
  return true;
}

/** Every 4 hours: any connection without a successful sync in the last 4 hours, or with a request left by a failed run. */
export function backstopHandler(db: Db, enqueue: Enqueue): Handler {
  return async (_job, now): Promise<StepResult> => {
    const due = await db
      .prepare(
        `SELECT id FROM connection WHERE removed_at IS NULL AND provider = 'plaid' AND status != 'login_required'
           AND (last_synced_at IS NULL OR last_synced_at < ?1 OR resync_requested = 1)`,
      )
      .bind(now - FOUR_HOURS)
      .all<{ id: string }>();
    for (const c of due.results) await startSyncJob(db, enqueue, c.id, 'cron', now).catch(() => false);
    return { state: {}, runAt: now + FOUR_HOURS };
  };
}

/** Daily at 5:00 AM local: repeating Upcoming entries get their next date, vanished pending rows get an alert. */
export function dailyScanHandler(env: Env, budgetId: () => Promise<string>): Handler {
  return async (_job, now): Promise<StepResult> => {
    const b = await budgetId();
    // The scan is noted for the device, which runs the same one (store/inbox.ts): its planned time, and the
    // budget's data version before and after it.
    const version = async () =>
      (
        await env.DB.prepare(`SELECT data_version AS v FROM budget WHERE id = ?1`)
          .bind(b)
          .first<{ v: number }>()
      )?.v ?? 0;
    const base = await version();
    const r = await dailyScan(env, b, now);
    await inboxScanned(env.DB, scanTime(now, await budgetZone(env.DB, b)), base, await version(), now).catch(
      () => undefined,
    );
    // A full batch may mean more are due: run again shortly instead of waiting a day.
    if (r.materialized >= SCAN_BATCH) return { state: {}, runAt: now + 1000 };
    return { state: {}, runAt: nextScan(now, await budgetZone(env.DB, b)) };
  };
}

interface MaintState {
  phase: 'start' | 'catchup' | 'rollup' | 'watchdog' | 'prune' | 'bump';
  i?: number;
}

/**
 * Daily at 2:20 AM local: the daily maintenance steps (maintenance.ts). The full recompute and the identity check run on
 * the phone (D-45, local/engine.ts).
 */
export function maintenanceHandler(env: Env, budgetId: () => Promise<string>): Handler {
  return async (job, now): Promise<StepResult> => {
    const db = env.DB;
    const b = await budgetId();
    const s = job.state as MaintState;
    const next = (state: MaintState): StepResult => ({ state, runAt: now });
    switch (s.phase ?? 'start') {
      // A phase this code doesn't know (a run saved by an older release) starts over at the catch-up.
      default:
      case 'start':
        return next({ phase: 'catchup', i: 0 });
      case 'catchup': {
        // 2. Post-sync catch-up from the watermark: for rows whose sync job is gone. A bank update that is alive files
        // its own rows, whole and in its turn (D-86 A2), so the catch-up leaves it alone.
        if (await updateInFlight(db, b, now)) return next({ phase: 'rollup' });
        const r = await processPending(env, b, now);
        const i = (s.i ?? 0) + 1;
        return next(r.caughtUp || i >= 400 ? { phase: 'rollup' } : { phase: 'catchup', i });
      }
      case 'rollup':
        // 3. Usage roll-up into usage_daily; prune raw events older than 90 days.
        await rollUpUsage(env, b, now);
        return next({ phase: 'watchdog' });
      case 'watchdog':
        // 4. Watchdog (the account-wide usage refresh and the auth prune run in the Directory).
        await db.batch(watchdogBudgetStmts(db, b, now));
        return next({ phase: 'prune' });
      case 'prune':
        // Staged pages of finished runs (driven from sync_page, which stays small, not from every run ever), and
        // jobs that failed for good more than 30 days ago. The bank history itself (raw_page, bank_page,
        // bank_event) is append-only by design: database triggers refuse deletes (threat-model.md).
        await db.batch([
          db
            .prepare(
              `DELETE FROM sync_page WHERE sync_run_id IN (
                 SELECT p.sync_run_id FROM (SELECT DISTINCT sync_run_id FROM sync_page) p
                 JOIN sync_run r ON r.id = p.sync_run_id WHERE r.budget_id = ?1 AND r.phase IN ('done', 'failed'))`,
            )
            .bind(b),
          db
            .prepare(`DELETE FROM job WHERE failed_at IS NOT NULL AND failed_at < ?1`)
            .bind(now - FAILED_JOB_KEEP_MS),
          // Offline edit ids (routes/sync.ts) and moved transaction keys, after 30 days.
          db.prepare(`DELETE FROM edit_seen WHERE at < ?1`).bind(now - 30 * 86_400_000),
          db.prepare(`DELETE FROM txn_key_move WHERE at < ?1`).bind(now - 30 * 86_400_000),
        ]);
        return next({ phase: 'bump' });
      case 'bump':
        // The daily job's writes change what screens show: a new data version (http/version.ts). Then wait for tomorrow.
        await bumpVersion(db, b);
        return { state: { phase: 'start' }, runAt: nextMaintenance(now, await budgetZone(db, b)) };
    }
  };
}

/**
 * Once, after migration 0007 (docs/payee-names.md 8.1): Plaid's name for rows imported before bank_txn.plaid_name
 * existed, one raw page per step (sync/fill-plaid-name.ts). Steps follow each other at once; the job ends when no row
 * is left to fill, and queues the re-file job (8.2, 8.3) where it hasn't run.
 */
export function fillPlaidNameHandler(db: Db, budgetId: () => Promise<string>): Handler {
  return async (job, now): Promise<StepResult> => {
    const r = await fillPlaidNameStep(db, await budgetId(), job.state as FillPlaidNameState);
    if (!r.done) return { state: r.state, runAt: now };
    await db.prepare(QUEUE_REFILE).bind(now).run();
    return { done: true };
  };
}

/**
 * Once (docs/payee-names.md 8.2, 8.3): every existing transaction filed again by the new payee rules. When it ends, it
 * queues the deletion of the old cleaned-text aliases (sync/drop-text-aliases.ts).
 */
export function refilePayeesHandler(db: Db, budgetId: () => Promise<string>): Handler {
  return async (job, now): Promise<StepResult> => {
    const r = await refilePayeesStep(db, await budgetId(), job.id, job.state as RefileState, now);
    if (!r.done) return { state: r.state, runAt: r.runAt };
    await db.prepare(QUEUE_DROP_TEXT_ALIASES).bind(now).run();
    return { done: true };
  };
}

/** Once, after the re-file: the old cleaned-text aliases deleted, a step at a time (sync/drop-text-aliases.ts). */
export function dropTextAliasesHandler(db: Db): Handler {
  return async (job, now): Promise<StepResult> =>
    (await dropTextAliasesStep(db)).done ? { done: true } : { state: job.state, runAt: now };
}
