// Write budget circuit breaker (Sync spec F8). Limits are account-wide, so the figures come from Cloudflare's
// GraphQL Analytics API (refreshed into usage_day at most every 10 minutes) plus this app's own estimates since.
import type { Env } from '../env.js';
import { extendForSleep } from './lease.js';

export const WRITE_LIMIT = 100_000;
export const READ_LIMIT = 5_000_000;

/** Durable Objects on Free: 100,000 requests and 13,000 GB-s of active time a day (docs/multi-user.md 9.3). */
export const DO_REQUEST_LIMIT = 100_000;
export const DO_GBS_LIMIT = 13_000;

/** Workers on Free: 100,000 requests a day, account-wide (static assets don't count). */
export const WORKER_REQUEST_LIMIT = 100_000;

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
): BudgetState {
  const share = usageShare(rowsWritten, rowsRead, d, workerRequests);
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
): number {
  return Math.max(
    rowsWritten / WRITE_LIMIT,
    rowsRead / READ_LIMIT,
    d.requests / DO_REQUEST_LIMIT,
    d.gbs / DO_GBS_LIMIT,
    workerRequests / WORKER_REQUEST_LIMIT,
  );
}

/** Refused while resting: everything but sign-in, the session (so the app knows) and Plaid webhooks. */
export function restsDuring(method: string, path: string): boolean {
  if (path.startsWith('/api/auth/') || path === '/api/webhooks/plaid') return false;
  return !(method === 'GET' && path === '/api/session');
}

export const RESTING = {
  error: 'resting',
  message:
    'Ledgerline is resting to stay inside Cloudflare’s free daily limit. Your data is safe. It’s back after midnight UTC.',
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
  const s = classifyUsage(u.written, u.read, u.do, u.workers);
  return s === 'readonly' || s === 'rest' ? 'pause' : s;
}

/** Adds this app's own row counts between analytics refreshes. */
export function noteUsage(
  db: D1Database,
  written: number,
  read: number,
  now = Date.now(),
): D1PreparedStatement {
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
