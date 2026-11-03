// The one Durable Object for users, passkeys, sessions, invites, Plaid slots and routing (docs/multi-user.md 5.2).
// It serves sign-in (/api/auth/*) and Settings → Sign-in (/api/settings/security/*) with the same
// routes the D1 path uses, and answers authenticate() for every other request so the Worker knows whose budget
// to open.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { SqlD1 } from './adapter.js';
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
  noteUsage,
  restsDuring,
  usageToday,
  type BudgetState,
} from '../sync/breaker.js';
import { refreshUsage } from '../ops/usage.js';
import { pruneAuthStmts } from '../maintenance.js';
import { JobRunner, type Handler } from './jobs.js';
import { nextUtc } from './budget-jobs.js';

/** Budgets checked per ensure_all step (docs/multi-user.md 6.2). */
export const ENSURE_BATCH = 25;

/** The Directory is a single object; this is its name. */
export const DIRECTORY_NAME = 'directory';

/** Who is asking, as the Worker hands it to a budget's store. */
export interface Caller {
  userId: string;
  budgetId: string;
  email: string;
  sessionId: string;
  verifiedAt: number;
  /** The budget's sync epoch (migration 0006): changes when its database is restored. */
  syncEpoch?: string;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403 | 503; body: { error: string; message: string } };

/** How long the Directory trusts its last look at today's usage (it changes at most every refresh). */
const STATE_MS = 60_000;

export class Directory extends DurableObject<Env> {
  protected readonly db: SqlD1;
  private startError: string | null = null;
  private app: Hono<AppEnv> | null = null;
  private readonly runner: JobRunner;
  private usageState: { state: BudgetState; at: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlD1(ctx.storage);
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
        await this.db.batch(pruneAuthStmts(this.db as unknown as D1Database, now) as never);
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
      // Every budget's ensureJobs, ENSURE_BATCH per step.
      ensure_all: async (job, now) => {
        const cursor = (job.state as { cursor: string }).cursor ?? '';
        const ids = this.ctx.storage.sql
          .exec(`SELECT id FROM budget WHERE id > ? ORDER BY id LIMIT ?`, cursor, ENSURE_BATCH)
          .toArray()
          .map((r) => String(r.id));
        for (const id of ids)
          await this.env.BUDGET.get(this.env.BUDGET.idFromName(id))
            .ensureJobs()
            .catch((e: unknown) =>
              console.log(JSON.stringify({ event: 'ensure_failed', budget: id, error: String(e) })),
            );
        if (ids.length < ENSURE_BATCH) return { done: true };
        return { state: { cursor: ids[ids.length - 1] }, runAt: now };
      },
    };
  }

  /** Sign-in and Settings → Sign-in, with the D1 path's own routes on the Directory's database. */
  override async fetch(request: Request): Promise<Response> {
    this.ready();
    if (!this.app) {
      const app = new Hono<AppEnv>();
      app.route('/api/auth', authRoutes);
      app.use('/api/settings/security/*', identity);
      app.use('/api/settings/security/*', csrf);
      app.use('/api/settings/security', identity);
      app.route('/api', securityRoutes);
      this.app = app;
    }
    return this.app.fetch(request, this.appEnv(), {
      waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
      passThroughOnException() {},
    } as never);
  }

  /** For every other API request: the signed-in user's budget, or why not (same answers as the D1 path). */
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
        body: { error: 'unauthenticated', message: 'Sign in with your passkey' },
      };
    if (needsRecentPasskey(method, path) && now - who.verifiedAt > REAUTH_MS)
      return {
        ok: false,
        status: 401,
        body: { error: 'reauth', message: 'Confirm it’s you with your passkey' },
      };
    const m = await membership(env.DB, who.userId);
    if (!m)
      return {
        ok: false,
        status: 403,
        body: { error: 'not_member', message: 'Not a member of this budget' },
      };
    // 95% of a daily limit: stop reading too, so the app never runs into Cloudflare's hard stop (sync/breaker.ts).
    if (restsDuring(method, path) && (await this.state(Date.now())) === 'rest')
      return { ok: false, status: 503, body: { ...RESTING } };
    return {
      ok: true,
      caller: {
        userId: m.userId,
        budgetId: m.budgetId,
        email: m.email,
        sessionId: who.sessionId ?? '',
        verifiedAt: who.verifiedAt,
        syncEpoch: this.syncEpoch(m.budgetId),
      },
    };
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

  /** Today's account usage, for the write breaker in every store (docs/multi-user.md 9.2). */
  async usageToday(): Promise<{
    written: number;
    read: number;
    do: { requests: number; gbs: number };
    workers: number;
  }> {
    const u = await usageToday(this.appEnv());
    return { written: u.written, read: u.read, do: u.do, workers: u.workers };
  }

  /** The breaker's state, from usage_day at most once a minute (one row read). */
  private async state(now: number): Promise<BudgetState> {
    if (this.usageState && now - this.usageState.at < STATE_MS) return this.usageState.state;
    const u = await usageToday(this.appEnv(), now);
    const state = classifyUsage(u.written, u.read, u.do, u.workers);
    this.usageState = { state, at: now };
    return state;
  }

  /** Adds a store's own row counts to today's account usage (between analytics refreshes). */
  async noteUsage(written: number, read: number): Promise<void> {
    await noteUsage(this.db as unknown as D1Database, written, read).run();
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
    return { ...this.env, DB: this.db as unknown as D1Database };
  }
}
