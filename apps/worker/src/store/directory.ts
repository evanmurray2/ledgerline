// The one Durable Object for users, passkeys, sessions, invites, Plaid slots and routing (docs/multi-user.md 5.2).
// It serves sign-in (/api/auth/*) and Settings → Sign-in (/api/settings/security/*), and answers authenticate() for
// every other request so the Worker knows whose budget to open.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { DurableDb } from './adapter.js';
import { answering } from './body.js';
import { migrate } from './migrate.js';
import { DIRECTORY_MIGRATIONS } from './migrations.gen.js';
import { storeHealth, type StoreHealth } from './budget-store.js';
import { authRoutes } from '../routes/auth.js';
import { securityRoutes } from '../routes/security.js';
import { identity } from '../routes/api.js';
import { csrf } from '../http/security.js';
import { REAUTH_MS, identify, needsRecentPasskey } from '../http/auth.js';
import { membership } from '../db/scoped.js';
import { clock } from '../http/clock.js';
import {
  RESTING,
  classifyUsage,
  dailyLimits,
  noteUsage,
  restsDuring,
  usageToday,
  utcDay,
  type BudgetState,
} from '../sync/breaker.js';
import { refreshUsage } from '../ops/usage.js';
import { pruneAuthStmts } from '../maintenance.js';
import { JobRunner, type Handler } from './jobs.js';
import { nextUtc } from './budget-jobs.js';
import { SHARE_PAUSED, Shares, type ShareState } from './shares.js';
import { recoverOptions, recoveryNotice, recoveryRoutes, signupOptions } from '../routes/signup.js';
import { deletingKey, peopleRoutes } from '../routes/people.js';

/** Budgets checked per ensure_all step (docs/multi-user.md 6.2). */
export const ENSURE_BATCH = 25;

/** A budget whose users haven't signed in for this long, and that has no banks, stops its daily jobs. */
export const IDLE_MS = 30 * 86_400_000;

/** The Directory is a single object; this is its name. */
export const DIRECTORY_NAME = 'directory';

/** Who is asking, as the Worker hands it to a budget's store. */
export interface Caller {
  userId: string;
  budgetId: string;
  email: string;
  sessionId: string;
  verifiedAt: number;
  /** An admin (the first user): links banks, sees Settings → Users (docs/open-signup.md 5, 10). False when not given. */
  isAdmin?: boolean;
  /** Fair use (store/shares.ts): whether the store reports its usage, and the budget's share. */
  countUsage?: boolean;
  share?: ShareState;
  /** When a recovery code was last used for this user, while its notice shows (docs/open-signup.md 4). */
  recoveryNoticeAt?: number | null;
  /** The budget's sync epoch (migration 0006): changes when its database is restored. */
  syncEpoch?: string;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403 | 503; body: { error: string; message: string } };

/** How long the Directory trusts its last look at today's usage (it changes at most every refresh). */
const STATE_MS = 60_000;

export class Directory extends DurableObject<Env> {
  protected readonly db: DurableDb;
  private startError: string | null = null;
  private app: Hono<AppEnv> | null = null;
  private readonly runner: JobRunner;
  private usageState: { state: BudgetState; at: number } | null = null;
  private shares: Shares | null = null;
  /** When each user's last_seen_at was last written by this instance (at most once an hour). */
  private readonly seen = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new DurableDb(ctx.storage);
    this.runner = new JobRunner(ctx.storage, this.handlers(), async (job, err) => {
      console.log(JSON.stringify({ event: 'job_failed', kind: job.kind, id: job.id, error: err }));
    });
    void ctx.blockConcurrencyWhile(async () => {
      try {
        migrate(ctx.storage, DIRECTORY_MIGRATIONS, Date.now());
      } catch (e) {
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  async health(): Promise<StoreHealth> {
    return storeHealth(this.ctx.storage, 'directory', this.startError);
  }

  /**
   * The daily cron after the move (6.2): keep the Directory's recurring jobs and start the safety check that walks
   * every budget in batches, so it covers any number of budgets.
   */
  async daily(): Promise<{ jobs: ReturnType<JobRunner['list']> }> {
    this.ready();
    const now = Date.now();
    await this.runner.enqueue(
      'auth_prune',
      { id: 'recurring:auth_prune', runAt: nextUtc(now, 10, 20), recurring: true },
      now,
    );
    await this.runner.enqueue(
      'usage_refresh',
      { id: 'recurring:usage_refresh', runAt: now, recurring: true },
      now,
    );
    await this.runner.enqueue('ensure_all', { id: 'ensure_all', state: { cursor: '' }, runAt: now }, now);
    return { jobs: this.runner.list() };
  }

  override async alarm(): Promise<void> {
    this.ready();
    await this.runner.runNext(Date.now());
  }

  private handlers(): Record<string, Handler> {
    return {
      // Expired sign-in state (D-27), daily.
      auth_prune: async (_job, now) => {
        await this.db.batch(pruneAuthStmts(this.db, now) as never);
        return { state: {}, runAt: nextUtc(now, 10, 20) };
      },
      // Account usage from GraphQL Analytics, every 30 minutes, for the write breaker. Durable Object requests and
      // active time can climb fast (they went from 90% to 100% in about an hour on Nov 2, 2026).
      // Every 10 minutes once any limit is past 70%, so the 90% and 95% brakes engage in time.
      usage_refresh: async (_job, now) => {
        await refreshUsage(this.appEnv(), now, true).catch(() => null);
        this.usageState = null;
        const busy = (await this.state(now)) !== 'normal';
        return { state: {}, runAt: now + (busy ? 10 : 30) * 60_000 };
      },
      // Deleting an account (routes/people.ts): the store wipes itself, then the user's last rows go. Each step is
      // idempotent; after 6 failed tries the job stops and Settings → Users offers Try again.
      delete_account: async (job) => {
        const { userId, budgetId } = job.state as { userId: string; budgetId: string };
        const w = await this.env.BUDGET.get(this.env.BUDGET.idFromName(budgetId)).wipe(budgetId);
        if (!w.ok) throw new Error(`wipe_${w.why}`);
        await this.db.batch([
          this.db.prepare(`DELETE FROM passkey WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM recovery_code WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM recovery_notice WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM device WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM device_link WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM auth_session WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM budget_member WHERE user_id = ?1`).bind(userId),
          this.db.prepare(`DELETE FROM budget_usage_day WHERE budget_id = ?1`).bind(budgetId),
          this.db.prepare(`DELETE FROM connection_route WHERE budget_id = ?1`).bind(budgetId),
          this.db.prepare(`DELETE FROM budget WHERE id = ?1`).bind(budgetId),
          this.db
            .prepare(`DELETE FROM user WHERE id = ?1 AND status = 'deleting' AND is_admin = 0`)
            .bind(userId),
          this.db
            .prepare(`DELETE FROM app_state WHERE key IN (?1, ?2)`)
            .bind(deletingKey(budgetId), `idle:${budgetId}`),
        ]);
        return { done: true };
      },
      // Every budget's ensureJobs, ENSURE_BATCH per step.
      ensure_all: async (job, now) => {
        const cursor = (job.state as { cursor: string }).cursor ?? '';
        const rows = this.ctx.storage.sql
          .exec(
            `SELECT b.id, (SELECT max(u.last_seen_at) FROM budget_member m JOIN user u ON u.id = m.user_id
               WHERE m.budget_id = b.id) AS seen,
               (SELECT value FROM app_state WHERE key = 'idle:' || b.id) AS idle_at
             FROM budget b WHERE b.id > ?
               AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'deleting:' || b.id) ORDER BY b.id LIMIT ?`,
            cursor,
            ENSURE_BATCH,
          )
          .toArray();
        const ids = rows.map((r) => String(r.id));
        for (const r of rows) {
          const id = String(r.id);
          // A budget nobody has opened for 30 days rests (docs/open-signup.md 9): once its store has stopped its
          // daily jobs, it isn't called again until its user comes back.
          const seen = r.seen === null ? null : Number(r.seen);
          const idle = seen !== null && now - seen > IDLE_MS;
          if (idle && r.idle_at !== null && seen! <= Number(r.idle_at)) continue;
          const res = await this.env.BUDGET.get(this.env.BUDGET.idFromName(id))
            .ensureJobs({ idle })
            .catch((e: unknown) => {
              console.log(JSON.stringify({ event: 'ensure_failed', budget: id, error: String(e) }));
              return null;
            });
          if (res?.resting)
            this.ctx.storage.sql.exec(
              `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              `idle:${id}`,
              String(now),
              now,
            );
          else if (res && r.idle_at !== null)
            this.ctx.storage.sql.exec(`DELETE FROM app_state WHERE key = ?`, `idle:${id}`);
        }
        if (ids.length < ENSURE_BATCH) return { done: true };
        return { state: { cursor: ids[ids.length - 1] }, runAt: now };
      },
    };
  }

  /** Sign-in and Settings → Sign-in, on the Directory's database. */
  override async fetch(request: Request): Promise<Response> {
    this.ready();
    if (!this.app) {
      const app = new Hono<AppEnv>();
      app.route('/api/auth', authRoutes);
      app.use('/api/settings/security/*', identity);
      app.use('/api/settings/security/*', csrf);
      app.use('/api/settings/security', identity);
      app.route('/api', securityRoutes);
      app.route('/api', recoveryRoutes);
      app.route('/api', peopleRoutes);
      this.app = app;
    }
    const app = this.app;
    return answering(request, () =>
      app.fetch(request, this.appEnv(), {
        waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
        passThroughOnException() {},
      } as never),
    );
  }

  /** For every other API request: the signed-in user's budget, or why not. */
  async authenticate(cookie: string | null, method: string, path: string): Promise<AuthResult> {
    this.ready();
    const env = this.appEnv();
    const now = clock(env);
    const req = new Request('https://directory.internal/', { headers: cookie ? { cookie } : {} });
    const who = await identify(req, env, now);
    if (!who || who.kind !== 'user')
      return {
        ok: false,
        status: 401,
        body: { error: 'unauthenticated', message: 'Sign in again with your passkey.' },
      };
    if (needsRecentPasskey(method, path) && now - who.verifiedAt > REAUTH_MS)
      return {
        ok: false,
        status: 401,
        body: { error: 'reauth', message: 'Confirm it’s you with your passkey, then try again.' },
      };
    const m = await membership(env.DB, who.userId);
    if (!m)
      return {
        ok: false,
        status: 403,
        body: { error: 'not_member', message: 'You don’t have access to this budget.' },
      };
    // 95% of a daily limit: stop reading too, so the app never runs into Cloudflare's hard stop (sync/breaker.ts).
    if (restsDuring(method, path) && (await this.state(Date.now())) === 'rest')
      return { ok: false, status: 503, body: { ...RESTING } };
    this.touch(m.userId, now);
    const share = await this.shareTracker().shareFor(m.budgetId, m.isAdmin, now);
    if (share.state === 'readonly' && method !== 'GET' && method !== 'HEAD')
      return { ok: false, status: 503, body: { ...SHARE_PAUSED } };
    return {
      ok: true,
      caller: {
        userId: m.userId,
        budgetId: m.budgetId,
        email: m.email,
        sessionId: who.sessionId ?? '',
        verifiedAt: who.verifiedAt,
        isAdmin: m.isAdmin,
        countUsage: share.count,
        share: share.state,
        recoveryNoticeAt: m.isAdmin ? null : await recoveryNotice(env, m.userId, now),
        syncEpoch: this.syncEpoch(m.budgetId),
      },
    };
  }

  /** Sign-up's passkey options (routes/signup.ts); the Worker has checked the switch and Turnstile. */
  async signupOptions(
    url: string,
    name: string,
  ): Promise<{ status: number; body: unknown; cookie?: string }> {
    this.ready();
    return signupOptions(this.appEnv(), url, name, (await this.state(Date.now())) === 'normal');
  }

  /** A recovery code's passkey options (routes/signup.ts); the Worker has checked the switch and Turnstile. */
  async recoverOptions(
    url: string,
    code: string,
  ): Promise<{ status: number; body: unknown; cookie?: string }> {
    this.ready();
    return recoverOptions(this.appEnv(), url, code, (await this.state(Date.now())) === 'normal');
  }

  /**
   * Whether a store may make its budget row: the budget exists and isn't being deleted (docs/open-signup.md 12),
   * so a late call after a wipe can't bring a deleted budget back.
   */
  async budgetExists(budgetId: string): Promise<boolean> {
    this.ready();
    const r = this.ctx.storage.sql
      .exec(
        `SELECT EXISTS (SELECT 1 FROM budget WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM app_state WHERE key = ?) AS ok`,
        budgetId,
        deletingKey(budgetId),
      )
      .one();
    return Number(r.ok) === 1;
  }

  /** Whether this budget's account is being deleted: only then may its store wipe itself. */
  async isDeleting(budgetId: string): Promise<boolean> {
    this.ready();
    return (
      this.ctx.storage.sql.exec(`SELECT 1 FROM app_state WHERE key = ?`, deletingKey(budgetId)).toArray()
        .length > 0
    );
  }

  /** The budget's sync epoch (D-45, migration 0006). */
  syncEpoch(budgetId: string): string {
    const r = this.ctx.storage.sql.exec(`SELECT sync_epoch FROM budget WHERE id = ?`, budgetId).toArray()[0];
    return r ? String(r.sync_epoch) : 'e0';
  }

  /**
   * A new sync epoch for a budget whose database was restored, so every phone throws its copy away and downloads
   * again. It lives here, not in the budget's own database, because a restore rolls that database back too.
   */
  async bumpSyncEpoch(budgetId: string): Promise<string> {
    this.ready();
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const epoch = 'e' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.ctx.storage.sql.exec(
      `UPDATE budget SET sync_epoch = ?, updated_at = ? WHERE id = ?`,
      epoch,
      Date.now(),
      budgetId,
    );
    return epoch;
  }

  /** The budget the ops token's health check reports on: the first one (the owner's). */
  async firstBudget(): Promise<string | null> {
    const r = this.ctx.storage.sql.exec(`SELECT id FROM budget ORDER BY created_at, id LIMIT 1`).toArray()[0];
    return r ? String(r.id) : null;
  }

  /**
   * Today's account usage, for the write breaker in every store (docs/multi-user.md 9.2), and, given the store's
   * budget, its fair-use share (store/shares.ts).
   */
  async usageToday(budgetId?: string): Promise<{
    written: number;
    read: number;
    do: { requests: number; gbs: number };
    workers: number;
    share?: ShareState;
  }> {
    const u = await usageToday(this.appEnv());
    const out = { written: u.written, read: u.read, do: u.do, workers: u.workers };
    if (!budgetId) return out;
    const admin = this.ctx.storage.sql
      .exec(
        `SELECT u.is_admin FROM budget_member m JOIN user u ON u.id = m.user_id WHERE m.budget_id = ? LIMIT 1`,
        budgetId,
      )
      .toArray()[0];
    const share = await this.shareTracker().shareFor(budgetId, admin?.is_admin !== 0, clock(this.appEnv()));
    return { ...out, share: share.state };
  }

  /** A store's own rows and requests since its last report (store/shares.ts UsageCounter). */
  async noteBudgetUsage(budgetId: string, written: number, read: number, requests: number): Promise<void> {
    this.ready();
    await this.shareTracker().record(budgetId, utcDay(clock(this.appEnv())), written, read, requests);
  }

  private shareTracker(): Shares {
    this.shares ??= new Shares(this.db, this.appEnv());
    return this.shares;
  }

  /** last_seen_at, at most once an hour per user (fair use counts active users; idle budgets rest). */
  private touch(userId: string, now: number): void {
    const last = this.seen.get(userId) ?? 0;
    if (now - last < 3_600_000) return;
    this.seen.set(userId, now);
    this.ctx.storage.sql.exec(
      `UPDATE user SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      now,
      userId,
      now - 3_600_000,
    );
  }

  /** The breaker's state, from usage_day at most once a minute (one row read). */
  private async state(now: number): Promise<BudgetState> {
    if (this.usageState && now - this.usageState.at < STATE_MS) return this.usageState.state;
    const u = await usageToday(this.appEnv(), now);
    const state = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(this.env));
    this.usageState = { state, at: now };
    return state;
  }

  /** Adds a store's own row counts to today's account usage (between analytics refreshes). */
  async noteUsage(written: number, read: number): Promise<void> {
    await noteUsage(this.db, written, read).run();
  }

  /**
   * Records which budget owns a Plaid Item (6.4). Idempotent. An Item already routed to another budget is refused
   * ('duplicate'), which replaces the old global unique index on (provider, provider_item_id).
   */
  async registerRoute(itemId: string, budgetId: string, connectionId: string): Promise<'ok' | 'duplicate'> {
    this.ready();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO connection_route (provider_item_id, budget_id, connection_id, created_at) VALUES (?, ?, ?, ?)`,
      itemId,
      budgetId,
      connectionId,
      Date.now(),
    );
    const r = this.ctx.storage.sql
      .exec(`SELECT budget_id FROM connection_route WHERE provider_item_id = ?`, itemId)
      .one();
    return String(r.budget_id) === budgetId ? 'ok' : 'duplicate';
  }

  /** Which budget owns a Plaid Item (webhooks, 6.4). */
  async routeFor(itemId: string): Promise<string | null> {
    const r = this.ctx.storage.sql
      .exec(`SELECT budget_id FROM connection_route WHERE provider_item_id = ?`, itemId)
      .toArray()[0];
    return r ? String(r.budget_id) : null;
  }

  private ready(): void {
    if (!this.startError) return;
    // A failed start (for example Cloudflare refusing writes for the rest of the day) is retried on the next call,
    // so the object recovers by itself once writes are allowed again instead of waiting to be evicted.
    try {
      migrate(this.ctx.storage, DIRECTORY_MIGRATIONS, Date.now());
      this.startError = null;
    } catch (e) {
      this.startError = e instanceof Error ? e.message : String(e);
      throw new Error(`directory_unavailable: ${this.startError}`);
    }
  }

  private appEnv(): Env {
    return {
      ...this.env,
      DB: this.db,
      BREAKER_NORMAL: async () => (await this.state(Date.now())) === 'normal',
      NEW_STORE: async (budgetId: string) => {
        await this.env.BUDGET.get(this.env.BUDGET.idFromName(budgetId)).health();
      },
      BUDGET_INFO: (budgetId: string) => this.env.BUDGET.get(this.env.BUDGET.idFromName(budgetId)).info(),
      SET_DISABLED: async (budgetId: string, disabled: boolean) => {
        await this.env.BUDGET.get(this.env.BUDGET.idFromName(budgetId)).setDisabled(disabled);
      },
      DELETE_ACCOUNT: async (userId: string, budgetId: string) => {
        await this.runner.enqueue(
          'delete_account',
          { id: `delete_account:${userId}`, state: { userId, budgetId }, runAt: Date.now() },
          Date.now(),
        );
      },
    };
  }
}
