// A budget's recurring and on-demand jobs (docs/multi-user.md 6.1, 6.2): the sync backstop every 4 hours, the daily
// scan at 08:10 UTC and maintenance at 10:20 UTC (today's cron times), plus starting a sync. Each store keeps its own
// recurring rows, so nothing has to loop over every budget; a recurring row is never deleted, only moved forward.
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { recompute } from '../budget/recompute.js';
import { dailyScan } from '../cron.js';
import { checkIdentityDb, rollUpUsage, watchdogBudgetStmts } from '../maintenance.js';
import { processPending } from '../sync/process.js';
import { acquire, requestSync } from '../sync/lease.js';
import { bumpVersion } from '../http/etag.js';
import type { Handler, StepResult } from './jobs.js';
import { STORE_MONTHS_PER_STEP, type SyncState } from './sync-job.js';

export const BACKSTOP_ID = 'recurring:backstop';
export const DAILY_SCAN_ID = 'recurring:daily_scan';
export const MAINTENANCE_ID = 'recurring:maintenance';
const FOUR_HOURS = 4 * 3_600_000;
const SCAN_BATCH = 40; // dailyScan's LIMIT

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

/** Recreates any missing recurring row (idempotent). Called at store start and by the daily ensureJobs. */
export async function ensureRecurring(enqueue: Enqueue, now: number): Promise<void> {
  await enqueue('backstop', { id: BACKSTOP_ID, runAt: now + FOUR_HOURS, recurring: true });
  await enqueue('daily_scan', { id: DAILY_SCAN_ID, runAt: nextUtc(now, 8, 10), recurring: true });
  await enqueue('maintenance', {
    id: MAINTENANCE_ID,
    state: { phase: 'start' },
    runAt: nextUtc(now, 10, 20),
    recurring: true,
  });
}

/**
 * Starts a sync for one connection, as routes/settings.ts startSync() does for the Workflow: only once the link's
 * accounts are set up; records the request; takes the lease; queues a sync job holding it.
 */
export async function startSyncJob(
  db: D1Database,
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
export function backstopHandler(db: D1Database, enqueue: Enqueue): Handler {
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

/** Daily at 08:10 UTC: due Upcoming entries come into the budget, vanished pending rows get an alert. */
export function dailyScanHandler(env: Env, budgetId: () => Promise<string>, enqueue: Enqueue): Handler {
  return async (_job, now): Promise<StepResult> => {
    const r = await dailyScan(env, await budgetId(), now, { recompute: false });
    await enqueue('recompute', { id: 'recompute', runAt: now });
    // A full batch may mean more are due: run again shortly instead of waiting a day.
    return { state: {}, runAt: r.materialized >= SCAN_BATCH ? now + 1000 : nextUtc(now, 8, 10) };
  };
}

interface MaintState {
  phase: 'start' | 'recompute' | 'identity' | 'catchup' | 'rollup' | 'watchdog' | 'prune' | 'bump';
  dirtyBefore?: string | null;
  written?: number;
  i?: number;
  identity?: { ok: boolean; difference: number; literal: boolean };
}

/** Daily at 10:20 UTC: today's MaintenanceWorkflow steps, smaller (full recompute 2 months per step). */
export function maintenanceHandler(env: Env, budgetId: () => Promise<string>): Handler {
  return async (job, now): Promise<StepResult> => {
    const db = env.DB;
    const b = await budgetId();
    const s = job.state as MaintState;
    const next = (state: MaintState): StepResult => ({ state, runAt: now });
    switch (s.phase ?? 'start') {
      case 'start': {
        const r = await db
          .prepare(`SELECT summary_dirty_from FROM budget WHERE id = ?1`)
          .bind(b)
          .first<{ summary_dirty_from: string | null }>();
        return next({ phase: 'recompute', dirtyBefore: r?.summary_dirty_from ?? null, written: 0, i: 0 });
      }
      case 'recompute': {
        // 1. Full recompute from budget start; any month that changes without a pending edit is drift.
        const i = s.i ?? 0;
        const r = await recompute(db, b, now, {
          maxMonths: STORE_MONTHS_PER_STEP,
          ...(i === 0 ? { force: true, fullFrom: true } : {}),
        });
        const written = (s.written ?? 0) + r.monthsWritten;
        if (r.done || !r.ok || i >= 200) return next({ ...s, phase: 'identity', written });
        return next({ ...s, written, i: i + 1 });
      }
      case 'identity': {
        const identity = await checkIdentityDb(env, b);
        const stmts = [
          db
            .prepare(
              `INSERT INTO health_status (budget_id, key, value, at) VALUES (?1, 'last_recompute', ?2, ?3) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
            )
            .bind(
              b,
              JSON.stringify({
                monthsChanged: s.written ?? 0,
                drift: s.dirtyBefore === null && (s.written ?? 0) > 0,
                identity,
              }),
              now,
            ),
        ];
        if (!identity.ok) {
          stmts.push(
            db
              .prepare(
                `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?1, ?2, 'identity', ?3, ?4, ?5) ON CONFLICT (budget_id, type, ref_key) DO UPDATE SET data = excluded.data`,
              )
              .bind(ulid(now), b, new Date(now).toISOString().slice(0, 10), JSON.stringify(identity), now),
          );
          console.log(JSON.stringify({ event: 'identity_failed', count: identity.difference }));
        }
        await db.batch(stmts);
        return next({ phase: 'catchup', i: 0 });
      }
      case 'catchup': {
        // 2. Post-sync catch-up from the watermark.
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
        await db
          .prepare(
            `DELETE FROM sync_page WHERE sync_run_id IN (SELECT id FROM sync_run WHERE phase IN ('done', 'failed') AND budget_id = ?1)`,
          )
          .bind(b)
          .run();
        return next({ phase: 'bump' });
      case 'bump':
        // The daily job's writes change what screens show: new ETags (http/etag.ts). Then wait for tomorrow.
        await bumpVersion(db, b);
        return { state: { phase: 'start' }, runAt: nextUtc(now, 10, 20) };
    }
  };
}
