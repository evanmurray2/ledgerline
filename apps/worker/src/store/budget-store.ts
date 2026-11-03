// One Durable Object per budget, holding all of that budget's data in its own SQLite database
// (docs/multi-user.md 5.3). It migrates itself at start, runs its background work on alarms (6.1) and keeps its own
// recurring jobs (6.2). The Worker reaches it only after the Directory has said whose budget it is.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import type { Caller } from './directory.js';
import { DIRECTORY_NAME } from './directory.js';
import { budgetApi } from '../routes/api.js';
import { dev } from '../measure/dev.js';
import { measure } from '../measure/routes.js';
import { BUDGET_TABLES, NO_FILTER, chain, insertStatements, readChunk, tableMeta } from './dump.js';
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
  private armed = false;
  private readonly runner: JobRunner;
  private cachedBudgetId: string | null = null;
  private app: Hono<AppEnv> | null = null;
  private devApp: Hono<AppEnv> | null = null;

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
    await this.ensureBudget(caller.budgetId);
    await this.rearm();
    this.app ??= withCaller((app) => app.route('/api', budgetApi));
    return this.serve(this.app, request, caller);
  }

  /** Local development, e2e and measuring only: /__dev and /__measure (index.ts refuses them in production). */
  async dev(request: Request, caller: Caller): Promise<Response> {
    this.ready();
    if (this.env.PLAID_ENV === 'production' || this.env.SETUP_CODE)
      return new Response('Not found', { status: 404 });
    await this.ensureBudget(caller.budgetId);
    this.devApp ??= withCaller((app) => {
      app.route('/__dev', dev);
      app.use('/__measure/*', async (c, next) => (this.env.MEASURE === '1' ? next() : c.notFound()));
      app.route('/__measure', measure);
    });
    return this.serve(this.devApp, request, caller);
  }

  private serve(app: Hono<AppEnv>, request: Request, caller: Caller): Promise<Response> {
    const env = { ...this.appEnv(), CALLER: caller };
    return Promise.resolve(
      app.fetch(
        request,
        env as never,
        {
          waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
          passThroughOnException() {},
        } as never,
      ),
    );
  }

  // ---- restoring a full backup (docs/multi-user.md 8.7; a runbook step, never a button)

  /**
   * Loads backup lines (header, rows, footer) into this store. Refused unless the store holds no budget yet, so a
   * live budget can't be overwritten. Call with consecutive pieces of the file; then restoreVerify().
   */
  async restoreDump(lines: string): Promise<{ ok: true; rows: number } | { ok: false; reason: string }> {
    const db = this.adapter();
    // Each piece is checked in full, then written in one transaction: a piece that fails anywhere adds nothing,
    // so the same piece can simply be sent again.
    const rows: { t: string; r: Record<string, unknown> }[] = [];
    let header = false;
    let footer: unknown = undefined;
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      let o: { format?: string; t?: string; r?: Record<string, unknown>; end?: boolean; tables?: unknown };
      try {
        o = JSON.parse(line) as typeof o;
      } catch {
        return { ok: false, reason: 'unreadable line' };
      }
      if (o.format) {
        if (o.format !== 'ledgerline-dump') return { ok: false, reason: 'not a Ledgerline backup' };
        header = true;
        continue;
      }
      if (o.end) {
        footer = o.tables;
        continue;
      }
      if (!o.t || !o.r || !(BUDGET_TABLES as readonly string[]).includes(o.t))
        return { ok: false, reason: `unknown line` };
      rows.push({ t: o.t, r: o.r });
    }
    if (header) {
      const has = this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM budget`).one().n;
      if (Number(has) > 0) return { ok: false, reason: 'refused: this database already holds a budget' };
    }
    const metas = new Map<string, Awaited<ReturnType<typeof tableMeta>>>();
    for (const { t } of rows) if (!metas.has(t)) metas.set(t, await tableMeta(db, t));
    const stmts = [
      ...(header ? [db.prepare(`DELETE FROM apply_counter`)] : []),
      ...rows.flatMap(({ t, r }) => insertStatements(db, t, metas.get(t)!, [r])),
    ];
    try {
      await db.batch(stmts);
    } catch (e) {
      return {
        ok: false,
        reason: `nothing from this piece was written: ${e instanceof Error ? e.message : e}`,
      };
    }
    if (footer !== undefined) await this.ctx.storage.put('restore_footer', footer);
    this.cachedBudgetId = null;
    return { ok: true, rows: rows.length };
  }

  /** Recomputes every table's row count and fingerprint and compares them with the backup's footer. */
  async restoreVerify(): Promise<{ ok: boolean; differences: string[] }> {
    const footer =
      (await this.ctx.storage.get<Record<string, { count: number; hash: string }>>('restore_footer')) ?? {};
    const db = this.adapter();
    const differences: string[] = [];
    for (const t of BUDGET_TABLES) {
      const meta = await tableMeta(db, t);
      let count = 0;
      let hash = '';
      let cursor: unknown[] | null = null;
      do {
        const c = await readChunk(db, t, meta, NO_FILTER, cursor);
        count += c.rows.length;
        hash = c.rows.length ? await chain(hash, c.text) : hash;
        cursor = c.cursor;
      } while (cursor);
      const want = footer[t] ?? { count: 0, hash: '' };
      if (want.count !== count || want.hash !== hash)
        differences.push(`${t}: ${count} row(s), backup has ${want.count}`);
    }
    return { ok: differences.length === 0, differences };
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

  /**
   * Cloudflare drops an alarm that keeps failing (for example all day while writes are refused), which would leave
   * the bank syncs and daily jobs waiting for the next daily ensureJobs. The first call after the object starts
   * puts the alarm back if jobs are waiting and none is set.
   */
  private async rearm(): Promise<void> {
    if (this.armed) return;
    this.armed = true;
    if ((await this.ctx.storage.getAlarm()) === null) await this.runner.scheduleNext(Date.now());
  }

  protected ready(): void {
    if (!this.startError) return;
    // A failed start (for example Cloudflare refusing writes for the rest of the day) is retried on the next call,
    // so the object recovers by itself once writes are allowed again instead of waiting to be evicted.
    try {
      migrate(this.ctx.storage, BUDGET_MIGRATIONS, Date.now());
      this.startError = null;
    } catch (e) {
      this.startError = e instanceof Error ? e.message : String(e);
      throw new Error(`store_unavailable: ${this.startError}`);
    }
  }

  private adapter(): D1Database {
    return this.db as unknown as D1Database;
  }

  /**
   * The env every app function sees inside the store: the same bindings, with DB = this store's database, account
   * usage from the Directory, and JOBS, so the routes that start a sync or an older-month recompute queue a job
   * here (docs/multi-user.md 6.1).
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
      JOBS: {
        // routes/settings.ts startSync() has already taken the lease with this run id.
        sync: async (runId, connectionId, trigger) => {
          const state: SyncState = { phase: 'begin', holder: runId, trigger };
          await this.enqueue('sync', { id: runId, connectionId, state, runAt: now() });
        },
        recompute: async () => {
          await this.enqueue('recompute', { id: 'recompute', runAt: now() });
        },
      },
    };
  }

  /** The store fills in its own budget row on first use (sign-up and setup create it in the Directory). */
  private async ensureBudget(budgetId: string): Promise<void> {
    if (this.cachedBudgetId === budgetId) return;
    const now = Date.now();
    const created = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO budget (id, name, created_at, updated_at) VALUES (?, 'My budget', ?, ?)`,
      budgetId,
      now,
      now,
    ).rowsWritten;
    // A new budget gets its sync backstop, daily scan and maintenance now, not at the next daily check.
    if (created > 0) await ensureRecurring(this.enqueue, now);
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
      // Account usage from the Directory (env.USAGE).
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

/** A Hono app whose requests carry the caller the Worker authenticated with the Directory. */
function withCaller(mount: (app: Hono<AppEnv>) => void): Hono<AppEnv> {
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
  mount(app);
  return app;
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
