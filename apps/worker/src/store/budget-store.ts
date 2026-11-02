// One Durable Object per budget, holding all of that budget's data in its own SQLite database
// (docs/multi-user.md 5.3). It migrates itself at start, runs its background work on alarms (6.1) and keeps its own
// recurring jobs (6.2). Nothing routes requests to it yet: until the move, the app runs entirely on D1.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import type { Caller } from './directory.js';
import { DIRECTORY_NAME } from './directory.js';
import { budgetApi } from '../routes/api.js';
import type { Env } from '../env.js';
import { SqlD1 } from './adapter.js';
import { appliedMigrations, migrate } from './migrate.js';
import { BUDGET_MIGRATIONS } from './migrations.gen.js';
import { JobRunner, type Handler, type Job } from './jobs.js';
import { failSync, recomputeHandler, syncHandler, type SyncDeps, type SyncState } from './sync-job.js';
import {
  backstopHandler,
  dailyScanHandler,
  ensureRecurring,
  maintenanceHandler,
  startSyncJob,
  type Enqueue,
} from './budget-jobs.js';
import { connectionToken, makeProvider, pageSize } from '../sync/provider.js';
import { writeBudgetState } from '../sync/breaker.js';
import { storeMoveHandler, type MoveStatus } from './move-jobs.js';
import type { QueuedWebhook } from './frozen.js';

export interface StoreHealth {
  ok: boolean;
  kind: 'budget' | 'directory';
  migrations: string[];
  tables: number;
  error?: string;
}

export class BudgetStore extends DurableObject<Env> {
  protected readonly db: SqlD1;
  private startError: string | null = null;
  private readonly runner: JobRunner;
  private cachedBudgetId: string | null = null;
  private app: Hono<AppEnv> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlD1(ctx.storage);
    this.runner = new JobRunner(ctx.storage, this.handlers(), (job, err) => this.onFailed(job, err));
    void ctx.blockConcurrencyWhile(async () => {
      try {
        migrate(ctx.storage, BUDGET_MIGRATIONS, Date.now());
      } catch (e) {
        // Refuse to serve a half-migrated schema; health() reports why.
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  // ---- RPC

  /** Called by the deploy smoke test and the daily check; running it applies pending migrations. */
  async health(): Promise<StoreHealth> {
    return storeHealth(this.ctx.storage, 'budget', this.startError);
  }

  /**
   * The budget's API (routes/api.ts budgetApi) for a caller the Worker has already authenticated with the
   * Directory. The store can only be reached through its binding, so the caller it is given can be trusted.
   */
  async api(request: Request, caller: Caller): Promise<Response> {
    this.ready();
    this.ensureBudget(caller.budgetId);
    if (!this.app) {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        const who = (c.env as Env & { CALLER: Caller }).CALLER;
        c.set('requestId', crypto.randomUUID());
        c.set('userId', who.userId);
        c.set('budgetId', who.budgetId);
        c.set('email', who.email);
        c.set('sessionId', who.sessionId);
        return next();
      });
      app.route('/api', budgetApi);
      this.app = app;
    }
    return this.app.fetch(
      request,
      { ...this.appEnv(), CALLER: caller } as never,
      {
        waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
        passThroughOnException() {},
      } as never,
    );
  }

  // ---- the move (docs/multi-user.md 8.3–8.5)

  /**
   * Empties this store and starts copying its budget from D1. Refused unless D1 says a move is copying right now,
   * so a store holding live data can never be wiped by mistake.
   */
  async resetForMove(budgetId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const refused = await notFrozen(this.env.DB);
    if (refused) return { ok: false, reason: refused };
    await this.ctx.storage.deleteAll();
    migrate(this.ctx.storage, BUDGET_MIGRATIONS, Date.now());
    this.cachedBudgetId = null;
    this.app = null;
    await this.ctx.storage.put('move_status', { state: 'copying' } satisfies MoveStatus);
    await this.enqueue('move_in', {
      id: 'move_in',
      state: { phase: 'copy', budgetId, t: 0, cursor: null, rows: 0, hash: '' },
      runAt: Date.now(),
    });
    return { ok: true };
  }

  async moveStatus(): Promise<MoveStatus | null> {
    return (await this.ctx.storage.get<MoveStatus>('move_status')) ?? null;
  }

  /** After the switch: replay webhooks that arrived during the freeze, keep recurring jobs, sync every bank. */
  async afterMove(webhooks: QueuedWebhook[]): Promise<void> {
    this.ready();
    const now = Date.now();
    const db = this.adapter();
    for (const w of webhooks) {
      const conn = await db
        .prepare(`SELECT id FROM connection WHERE provider_item_id = ?1 AND removed_at IS NULL`)
        .bind(w.itemId)
        .first<{ id: string }>();
      if (conn && (w.type === 'item_error' || w.type === 'pending_expiration'))
        await db
          .prepare(
            `UPDATE connection SET status = 'login_required', error_code = ?2, updated_at = ?3 WHERE id = ?1`,
          )
          .bind(conn.id, w.code, now)
          .run();
    }
    await this.ensureJobs();
    const conns = await db
      .prepare(
        `SELECT id FROM connection WHERE removed_at IS NULL AND provider = 'plaid' AND status != 'login_required' AND setup_done = 1`,
      )
      .all<{ id: string }>();
    for (const c of conns.results) await startSyncJob(db, this.enqueue, c.id, 'cron', now).catch(() => false);
  }

  /** Daily safety net (6.2): recreate missing recurring jobs and make sure an alarm is set. */
  async ensureJobs(): Promise<{ ok: boolean; jobs: ReturnType<JobRunner['list']> }> {
    this.ready();
    const now = Date.now();
    const budgetId = await this.budgetId().catch(() => null);
    if (!budgetId) return { ok: false, jobs: [] };
    await ensureRecurring(this.enqueue, now);
    // Every Plaid Item this budget holds is routed to it in the Directory (6.4); missing routes are re-registered.
    const items = this.ctx.storage.sql
      .exec(
        `SELECT id, provider_item_id FROM connection WHERE provider_item_id IS NOT NULL AND removed_at IS NULL`,
      )
      .toArray();
    for (const c of items)
      await this.enqueue('register_link', {
        id: `register_link:${String(c.id)}`,
        state: { itemId: String(c.provider_item_id), connectionId: String(c.id) },
        runAt: now,
      });
    await this.runner.scheduleNext(now);
    return { ok: true, jobs: this.runner.list() };
  }

  /** Starts a sync for one connection (webhook, refresh, link, backstop). */
  async startSync(connectionId: string, trigger: string): Promise<boolean> {
    this.ready();
    return startSyncJob(this.adapter(), this.enqueue, connectionId, trigger, Date.now());
  }

  async jobs(): Promise<ReturnType<JobRunner['list']>> {
    return this.runner.list();
  }

  // ---- alarms: one job step per invocation

  override async alarm(): Promise<void> {
    this.ready();
    await this.runner.runNext(Date.now());
  }

  // ---- internals

  protected ready(): void {
    if (this.startError) throw new Error(`store_unavailable: ${this.startError}`);
  }

  private adapter(): D1Database {
    return this.db as unknown as D1Database;
  }

  /**
   * The env every app function sees inside the store: the same bindings, with DB = this store's database, account
   * usage from the Directory, and the Workflow bindings standing in for jobs, so the routes that start a sync or
   * an older-month recompute queue a job here instead (docs/multi-user.md 6.1).
   */
  private appEnv(): Env {
    const now = () => Date.now();
    const dir = this.env.DIRECTORY?.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
    return {
      ...this.env,
      DB: this.adapter(),
      ...(dir
        ? { USAGE: () => dir.usageToday(), NOTE_USAGE: (w: number, r: number) => dir.noteUsage(w, r) }
        : {}),
      ROUTE_LINK: async (itemId: string, connectionId: string) => {
        await this.enqueue('register_link', {
          id: `register_link:${connectionId}`,
          state: { itemId, connectionId },
          runAt: now(),
        });
      },
      SYNC: {
        create: async (o: { id: string; params: { connectionId: string; trigger: string } }) => {
          // routes/settings.ts startSync() has already taken the lease with this id.
          const state: SyncState = { phase: 'begin', holder: o.id, trigger: o.params.trigger };
          await this.enqueue('sync', { id: o.id, connectionId: o.params.connectionId, state, runAt: now() });
          return { id: o.id };
        },
        get: async () => {
          throw new Error('not available inside a store');
        },
      } as never,
      RECOMPUTE: {
        create: async () => {
          await this.enqueue('recompute', { id: 'recompute', runAt: now() });
          return { id: 'recompute' };
        },
        get: async () => {
          throw new Error('not available inside a store');
        },
      } as never,
    };
  }

  /** The store fills in its own budget row on first use (sign-up and setup create it in the Directory). */
  private ensureBudget(budgetId: string): void {
    if (this.cachedBudgetId === budgetId) return;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO budget (id, name, created_at, updated_at) VALUES (?, 'My budget', ?, ?)`,
      budgetId,
      Date.now(),
      Date.now(),
    );
    this.cachedBudgetId = budgetId;
  }

  /** The store's budget: the one row in its budget table. */
  private async budgetId(): Promise<string> {
    if (this.cachedBudgetId) return this.cachedBudgetId;
    const r = this.ctx.storage.sql.exec(`SELECT id FROM budget LIMIT 1`).toArray()[0];
    if (!r) throw new Error('store has no budget yet');
    this.cachedBudgetId = String(r.id);
    return this.cachedBudgetId;
  }

  private readonly enqueue: Enqueue = (kind, o) => this.runner.enqueue(kind, o, Date.now());

  private async syncDeps(): Promise<SyncDeps> {
    const env = this.appEnv();
    return {
      env,
      budgetId: await this.budgetId(),
      provider: () => makeProvider(env),
      token: (id) => connectionToken(env, id),
      pageSize: pageSize(env),
      // Account usage: from the Directory once it exists here (env.USAGE), else D1's usage_day (sync/breaker.ts).
      budgetState: async () => ((await writeBudgetState(env)) === 'normal' ? 'normal' : 'pause'),
      enqueue: this.enqueue,
    };
  }

  private handlers(): Record<string, Handler> {
    const budgetId = () => this.budgetId();
    return {
      sync: async (job, now) => syncHandler(await this.syncDeps())(job, now),
      recompute: async (job, now) => recomputeHandler(this.adapter(), await budgetId())(job, now),
      backstop: (job, now) => backstopHandler(this.adapter(), this.enqueue)(job, now),
      daily_scan: (job, now) => dailyScanHandler(this.appEnv(), budgetId, this.enqueue)(job, now),
      maintenance: (job, now) => maintenanceHandler(this.appEnv(), budgetId)(job, now),
      move_in: (job, now) =>
        storeMoveHandler(
          this.env.DB,
          this.adapter(),
          () => this.appEnv(),
          (st) => this.ctx.storage.put('move_status', st),
        )(job, now),
      register_link: async (job) => {
        // Retried until the Directory answers; a duplicate Item is flagged on the connection (6.4).
        const { itemId, connectionId } = job.state as { itemId: string; connectionId: string };
        const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
        const r = await dir.registerRoute(itemId, await budgetId(), connectionId);
        if (r === 'duplicate')
          this.ctx.storage.sql.exec(
            `UPDATE connection SET error_code = 'duplicate_item', updated_at = ? WHERE id = ?`,
            Date.now(),
            connectionId,
          );
        return { done: true };
      },
    };
  }

  private async onFailed(job: Job, error: string): Promise<void> {
    console.log(JSON.stringify({ event: 'job_failed', kind: job.kind, id: job.id, error }));
    if (job.kind === 'sync' && job.connectionId)
      await failSync(await this.syncDeps(), job.connectionId, job.state as SyncState, error);
  }
}

/** Null when D1's move_state is 'frozen' (a move is copying), else why a wipe is refused. */
export async function notFrozen(d1: D1Database): Promise<string | null> {
  const r = await d1.prepare(`SELECT phase FROM move_state WHERE id = 1`).first<{ phase: string }>();
  return r?.phase === 'frozen' ? null : `refused: no move is copying (phase ${r?.phase ?? 'unknown'})`;
}

export function storeHealth(
  storage: DurableObjectStorage,
  kind: StoreHealth['kind'],
  startError: string | null,
): StoreHealth {
  if (startError) return { ok: false, kind, migrations: [], tables: 0, error: startError };
  const tables = Number(
    storage.sql
      .exec(
        `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'`,
      )
      .one().n,
  );
  return { ok: true, kind, migrations: appliedMigrations(storage), tables };
}
