// Write budget circuit breaker (Sync spec F8). Limits are account-wide, so the figures come from Cloudflare's
// GraphQL Analytics API (refreshed into usage_day at most every 10 minutes) plus this app's own estimates since.
import type { Db, Stmt } from '@ledgerline/db/sql';
import type { Env } from '../env.js';
import { extendForSleep } from './lease.js';

/**
 * The account's daily limits. Today's figures are Cloudflare's Free plan (docs/multi-user.md 9.3); each can be set
 * with a Worker variable for another plan (docs/open-signup.md 7). The 70%, 90% and 95% rules don't change (D-40).
 */
export interface DailyLimits {
  rowsWritten: number;
  rowsRead: number;
  /** Durable Object requests and active time (GB-s). */
  doRequests: number;
  doGbs: number;
  /** Worker requests, account-wide (static assets don't count). */
  workerRequests: number;
}

export const FREE_LIMITS: DailyLimits = {
  rowsWritten: 100_000,
  rowsRead: 5_000_000,
  doRequests: 100_000,
  doGbs: 13_000,
  workerRequests: 100_000,
};

/** A positive whole number, or the default when the variable is missing or invalid. */
function limit(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The limits this deploy runs under: the Worker variables `LIMIT_*`, else the Free plan's. */
export function dailyLimits(
  env: Pick<
    Env,
    'LIMIT_ROWS_WRITTEN' | 'LIMIT_ROWS_READ' | 'LIMIT_DO_REQUESTS' | 'LIMIT_DO_GBS' | 'LIMIT_WORKER_REQUESTS'
  >,
): DailyLimits {
  return {
    rowsWritten: limit(env.LIMIT_ROWS_WRITTEN, FREE_LIMITS.rowsWritten),
    rowsRead: limit(env.LIMIT_ROWS_READ, FREE_LIMITS.rowsRead),
    doRequests: limit(env.LIMIT_DO_REQUESTS, FREE_LIMITS.doRequests),
    doGbs: limit(env.LIMIT_DO_GBS, FREE_LIMITS.doGbs),
    workerRequests: limit(env.LIMIT_WORKER_REQUESTS, FREE_LIMITS.workerRequests),
  };
}

/**
 * 'normal'; 'pause' (70%: background work waits); 'readonly' (90%: changes refused, the app reads less often);
 * 'rest' (95%: reading stops too, so the last few percent never run out and take the app offline).
 */
export type BudgetState = 'normal' | 'pause' | 'readonly' | 'rest';

/** Today's Durable Object requests and active time (GB-s), from analytics. */
export interface DoUsage {
  requests: number;
  gbs: number;
}

/**
 * 70% of any daily limit pauses background work, 90% makes the app read-only, 95% stops reading too. Rows read
 * and written, Durable Object requests and active time (since Nov 2, 2026, when running out of them took the app
 * offline for the day), and Worker requests.
 */
export function classifyUsage(
  rowsWritten: number,
  rowsRead: number,
  d: DoUsage = { requests: 0, gbs: 0 },
  workerRequests = 0,
  limits: DailyLimits = FREE_LIMITS,
): BudgetState {
  const share = usageShare(rowsWritten, rowsRead, d, workerRequests, limits);
  if (share >= 0.95) return 'rest';
  if (share >= 0.9) return 'readonly';
  if (share >= 0.7) return 'pause';
  return 'normal';
}

/** The highest share of any daily limit used so far today (0 to 1, or more). */
export function usageShare(
  rowsWritten: number,
  rowsRead: number,
  d: DoUsage = { requests: 0, gbs: 0 },
  workerRequests = 0,
  limits: DailyLimits = FREE_LIMITS,
): number {
  return Math.max(
    rowsWritten / limits.rowsWritten,
    rowsRead / limits.rowsRead,
    d.requests / limits.doRequests,
    d.gbs / limits.doGbs,
    workerRequests / limits.workerRequests,
  );
}

/** Refused while resting: everything but sign-in, the session (so the app knows) and Plaid webhooks. */
export function restsDuring(method: string, path: string): boolean {
  if (path.startsWith('/api/auth/') || path === '/api/webhooks/plaid') return false;
  return !(method === 'GET' && path === '/api/session');
}

export const RESTING = {
  error: 'resting',
  message: 'Paused until the daily limit resets. Nothing is lost.',
} as const;

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function usageToday(
  env: Env,
  now = Date.now(),
): Promise<{ written: number; read: number; do: DoUsage; workers: number; refreshedAt: number | null }> {
  // Inside a budget's Durable Object, account usage lives in the Directory (docs/multi-user.md 9.2).
  if (env.USAGE) {
    const u = await env.USAGE();
    return {
      written: u.written,
      read: u.read,
      do: u.do ?? { requests: 0, gbs: 0 },
      workers: u.workers ?? 0,
      refreshedAt: null,
    };
  }
  const r = await env.DB.prepare(
    `SELECT rows_written + est_written AS w, rows_read + est_read AS r, do_requests, do_gbs, worker_requests,
       refreshed_at
     FROM usage_day WHERE day = ?1`,
  )
    .bind(utcDay(now))
    .first<{
      w: number;
      r: number;
      do_requests: number;
      do_gbs: number;
      worker_requests: number;
      refreshed_at: number;
    }>();
  return {
    written: r?.w ?? 0,
    read: r?.r ?? 0,
    do: { requests: r?.do_requests ?? 0, gbs: r?.do_gbs ?? 0 },
    workers: r?.worker_requests ?? 0,
    refreshedAt: r?.refreshed_at ?? null,
  };
}

/** Background paths call this before each unit of work. Usage events are dropped from the 70% tier. */
export async function writeBudgetState(env: Env): Promise<BudgetState> {
  const u = await usageToday(env);
  const s = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(env));
  return s === 'readonly' || s === 'rest' ? 'pause' : s;
}

/** Adds this app's own row counts between analytics refreshes. */
export function noteUsage(db: Db, written: number, read: number, now = Date.now()): Stmt {
  return db
    .prepare(
      `INSERT INTO usage_day (day, rows_read, rows_written, est_read, est_written, refreshed_at) VALUES (?1, 0, 0, ?3, ?2, 0)
       ON CONFLICT (day) DO UPDATE SET est_written = est_written + ?2, est_read = est_read + ?3`,
    )
    .bind(utcDay(now), written, read);
}

export async function sleepUntilUtcMidnight(env: Env, connectionId: string, holder: string): Promise<void> {
  const d = new Date();
  const wake = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30);
  await extendForSleep(env.DB, connectionId, holder, wake);
}
