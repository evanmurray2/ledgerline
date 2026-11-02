// One Durable Object per budget, holding all of that budget's data in its own SQLite database
// (docs/multi-user.md 5.3). It migrates itself at start, runs its background work on alarms (6.1) and keeps its own
// recurring jobs (6.2). Nothing routes requests to it yet: until the move, the app runs entirely on D1.
import { DurableObject } from 'cloudflare:workers';
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

  /** Daily safety net (6.2): recreate missing recurring jobs and make sure an alarm is set. */
  async ensureJobs(): Promise<{ ok: boolean; jobs: ReturnType<JobRunner['list']> }> {
    this.ready();
    const now = Date.now();
    if (!(await this.budgetId().catch(() => null))) return { ok: false, jobs: [] };
    await ensureRecurring(this.enqueue, now);
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

  /** The env every app function sees inside the store: the same bindings, with DB = this store's database. */
  private appEnv(): Env {
    return { ...this.env, DB: this.adapter() };
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
      // Account usage still lives in D1 until the Directory takes it over (docs/multi-user.md 5.6, phase 3).
      budgetState: async () => ((await writeBudgetState(this.env)) === 'normal' ? 'normal' : 'pause'),
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
    };
  }

  private async onFailed(job: Job, error: string): Promise<void> {
    console.log(JSON.stringify({ event: 'job_failed', kind: job.kind, id: job.id, error }));
    if (job.kind === 'sync' && job.connectionId)
      await failSync(await this.syncDeps(), job.connectionId, job.state as SyncState, error);
  }
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
