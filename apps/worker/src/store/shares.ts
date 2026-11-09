// Fair use: each user's share of the daily limits (docs/open-signup.md 8, D-75). Users who aren't admins share a pool,
// at most OTHER_USERS_SHARE of each daily limit (default half), split evenly among those active in the last 7 days.
// It applies only while more than one user is active. Everything about it is in this file, so it can be turned off
// (OTHER_USERS_SHARE = off) or deleted on a paid plan: the Directory calls shareFor() in authenticate and records
// usage with noteBudgetUsage(); the store counts its own rows and requests with UsageCounter.
import type { Db } from '@ledgerline/db/sql';
import type { Env } from '../env.js';
import { dailyLimits, utcDay, type DailyLimits } from '../sync/breaker.js';

/** 'normal'; 'pause' (past the share, or the pool is used: background work waits); 'readonly' (past 1.5 × the share). */
export type ShareState = 'normal' | 'pause' | 'readonly';

export const SHARE_PAUSED = {
  error: 'readonly',
  message: 'Paused until tomorrow. Nothing is lost.',
} as const;

/** Users count as active for a share when seen in the last 7 days. */
export const ACTIVE_MS = 7 * 86_400_000;
/** How long the Directory trusts its last look at a budget's share, and how often a store reports its usage. */
export const SHARE_CACHE_MS = 60_000;

/** The part of each daily limit other users may use together, or null when fair use is off. */
export function poolFraction(env: Pick<Env, 'OTHER_USERS_SHARE'>): number | null {
  const v = env.OTHER_USERS_SHARE?.trim();
  if (v === 'off') return null;
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
}

export interface Usage {
  written: number;
  requests: number;
}

/**
 * One budget's state: past the pool every other user waits; past its share (pool ÷ active users) it waits; past
 * 1.5 × its share its changes are refused too.
 */
export function shareState(
  own: Usage,
  others: Usage,
  limits: DailyLimits,
  fraction: number,
  activeUsers: number,
): ShareState {
  const poolW = limits.rowsWritten * fraction;
  const poolR = limits.doRequests * fraction;
  const n = Math.max(1, activeUsers);
  const ratio = Math.max(own.written / (poolW / n), own.requests / (poolR / n));
  if (ratio >= 1.5) return 'readonly';
  if (ratio >= 1 || others.written >= poolW || others.requests >= poolR) return 'pause';
  return 'normal';
}

/** The Directory's side: whether to count a budget's usage and what state its share is in, cached a minute. */
export class Shares {
  private users: { at: number; active: number; others: number } | null = null;
  private readonly cache = new Map<string, { at: number; state: ShareState }>();
  /** Requests to the Directory made for each budget, written with its next share check. */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly env: Env,
  ) {}

  /**
   * For a request from a budget's user: `count` tells the store to report its usage (only while shares apply and
   * the user isn't an admin), and `state` is the budget's share.
   */
  async shareFor(
    budgetId: string,
    isAdmin: boolean,
    now: number,
  ): Promise<{ count: boolean; state: ShareState }> {
    const fraction = poolFraction(this.env);
    if (fraction === null || isAdmin) return { count: false, state: 'normal' };
    const users = await this.activeUsers(now);
    if (users.active <= 1) return { count: false, state: 'normal' };
    this.pending.set(budgetId, (this.pending.get(budgetId) ?? 0) + 1);
    const hit = this.cache.get(budgetId);
    if (hit && now - hit.at < SHARE_CACHE_MS) return { count: true, state: hit.state };
    const day = utcDay(now);
    const asked = this.pending.get(budgetId) ?? 0;
    this.pending.delete(budgetId);
    if (asked > 0) await this.record(budgetId, day, 0, 0, asked);
    const own = await this.db
      .prepare(`SELECT written, requests FROM budget_usage_day WHERE budget_id = ?1 AND day = ?2`)
      .bind(budgetId, day)
      .first<Usage>();
    const others = await this.db
      .prepare(
        `SELECT coalesce(sum(d.written), 0) AS written, coalesce(sum(d.requests), 0) AS requests
         FROM budget_usage_day d JOIN budget_member m ON m.budget_id = d.budget_id JOIN user u ON u.id = m.user_id
         WHERE d.day = ?1 AND u.is_admin = 0`,
      )
      .bind(day)
      .first<Usage>();
    const state = shareState(
      own ?? { written: 0, requests: 0 },
      others ?? { written: 0, requests: 0 },
      dailyLimits(this.env),
      fraction,
      users.others,
    );
    this.cache.set(budgetId, { at: now, state });
    return { count: true, state };
  }

  /** A store's own rows and requests since its last report (at most once a minute). */
  async record(
    budgetId: string,
    day: string,
    written: number,
    read: number,
    requests: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO budget_usage_day (budget_id, day, written, read, steps, requests) VALUES (?1, ?2, ?3, ?4, 0, ?5)
         ON CONFLICT (budget_id, day) DO UPDATE SET written = written + ?3, read = read + ?4, requests = requests + ?5`,
      )
      .bind(budgetId, day, written, read, requests)
      .run();
  }

  /** Active users, and active users who aren't admins (seen in the last 7 days), at most once a minute. */
  private async activeUsers(now: number): Promise<{ active: number; others: number }> {
    if (this.users && now - this.users.at < SHARE_CACHE_MS) return this.users;
    const r = await this.db
      .prepare(
        `SELECT count(*) AS active,
           coalesce(sum(is_admin = 0 AND last_seen_at IS NOT NULL AND last_seen_at >= ?1), 0) AS others
         FROM user WHERE status = 'active'`,
      )
      .bind(now - ACTIVE_MS)
      .first<{ active: number; others: number }>();
    this.users = { at: now, active: r?.active ?? 0, others: r?.others ?? 0 };
    return this.users;
  }
}

/** The store's side: its own rows (from the database's counters) and requests, reported once a minute at most. */
export class UsageCounter {
  private requests = 0;
  private base = { rowsRead: 0, rowsWritten: 0 };
  private reportedAt = 0;

  constructor(private readonly stats: { rowsRead: number; rowsWritten: number }) {
    this.base = { rowsRead: stats.rowsRead, rowsWritten: stats.rowsWritten };
  }

  request(): void {
    this.requests++;
  }

  /** What to report now, or null (not counting, or reported less than a minute ago). Resets the counts. */
  take(counting: boolean, now: number): { written: number; read: number; requests: number } | null {
    // The database's counters can be reset (measurements do it); then they count from 0 again.
    if (this.stats.rowsWritten < this.base.rowsWritten || this.stats.rowsRead < this.base.rowsRead)
      this.base = { rowsRead: 0, rowsWritten: 0 };
    const out = {
      written: this.stats.rowsWritten - this.base.rowsWritten,
      read: this.stats.rowsRead - this.base.rowsRead,
      requests: this.requests,
    };
    if (counting && now - this.reportedAt < SHARE_CACHE_MS) return null;
    this.base = { rowsRead: this.stats.rowsRead, rowsWritten: this.stats.rowsWritten };
    this.requests = 0;
    if (!counting || (out.written === 0 && out.read === 0 && out.requests === 0)) return null;
    this.reportedAt = now;
    return out;
  }
}
