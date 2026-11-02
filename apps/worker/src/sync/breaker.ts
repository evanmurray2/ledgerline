// Write budget circuit breaker (Sync spec F8). Limits are account-wide, so the figures come from Cloudflare's
// GraphQL Analytics API (refreshed into usage_day at most every 10 minutes) plus this app's own estimates since.
import type { Env } from '../env.js';
import { extendForSleep } from './lease.js';

export const WRITE_LIMIT = 100_000;
export const READ_LIMIT = 5_000_000;

export type BudgetState = 'normal' | 'pause' | 'readonly';

export function classifyUsage(rowsWritten: number, rowsRead: number): BudgetState {
  if (rowsWritten >= 90_000 || rowsRead >= 4_500_000) return 'readonly';
  if (rowsWritten >= 70_000 || rowsRead >= 3_500_000) return 'pause';
  return 'normal';
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function usageToday(
  env: Env,
  now = Date.now(),
): Promise<{ written: number; read: number; refreshedAt: number | null }> {
  // Inside a budget's Durable Object, account usage lives in the Directory (docs/multi-user.md 9.2).
  if (env.USAGE) {
    const u = await env.USAGE();
    return { written: u.written, read: u.read, refreshedAt: null };
  }
  const r = await env.DB.prepare(
    `SELECT rows_written + est_written AS w, rows_read + est_read AS r, refreshed_at FROM usage_day WHERE day = ?1`,
  )
    .bind(utcDay(now))
    .first<{ w: number; r: number; refreshed_at: number }>();
  return { written: r?.w ?? 0, read: r?.r ?? 0, refreshedAt: r?.refreshed_at ?? null };
}

/** Background paths call this before each unit of work. Usage events are dropped from the 70% tier. */
export async function writeBudgetState(env: Env): Promise<BudgetState> {
  const u = await usageToday(env);
  const s = classifyUsage(u.written, u.read);
  return s === 'readonly' ? 'pause' : s;
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
