// One Durable Object per budget, holding all of that budget's data in its own SQLite database
// (docs/multi-user.md 5.3). It migrates itself at start, runs its background work on alarms (6.1) and keeps its own
// recurring jobs (6.2). The Worker reaches it only after the Directory has said whose budget it is.
import type { Db } from '@ledgerline/db/sql';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import type { Caller } from './directory.js';
import { DIRECTORY_NAME } from './directory.js';
import { budgetApi, serverReadsOnly } from '../routes/api.js';
import { dev } from '../dev-seed.js';
import {
  BUDGET_TABLES,
  DROPPED_TABLES,
  NO_FILTER,
  chain,
  insertStatements,
  narrowMeta,
  readChunk,
  tableMeta,
} from './dump.js';
import type { Env } from '../env.js';
import { DurableDb } from './adapter.js';
import { appliedMigrations, migrate } from './migrate.js';
import { BUDGET_MIGRATIONS } from './migrations.gen.js';
import { JobRunner, type Handler, type Job } from './jobs.js';
import { failSync, syncHandler, type SyncDeps, type SyncState } from './sync-job.js';
import {
  backstopHandler,
  dailyScanHandler,
  ensureRecurring,
  fillPlaidNameHandler,
  maintenanceHandler,
  refilePayeesHandler,
  dropTextAliasesHandler,
  startSyncJob,
  type Enqueue,
} from './budget-jobs.js';
import { connectionToken, makeProvider, pageSize } from '../sync/provider.js';
import { writeBudgetState } from '../sync/breaker.js';
import { answering } from './body.js';
import { UsageCounter } from './shares.js';
import { DISABLED_KEY, budgetInfo, setDisabled, wipeStore } from './account-life.js';
import { QUEUE_REFILE } from '../sync/refile-payees.js';
import { QUEUE_DROP_TEXT_ALIASES } from '../sync/drop-text-aliases.js';
import { markReads, noteHeavyRead, routeName } from './heavy-reads.js';

/** Storage key: the store has checked once whether its payees need the re-file job (sync/refile-payees.ts). */
/** Set while the budget rests (idle, no banks): its daily jobs come back on its next request (ensureJobs). */
const RESTING_KEY = 'resting';
/** Whether this store reports its usage for fair use (store/shares.ts), as the Directory last said. */
const COUNT_KEY = 'count_usage';
const REFILE_CHECKED = 'payee_refile_checked';
/** Storage key: the store has checked once whether its old cleaned-text aliases need deleting (drop-text-aliases.ts). */
const TEXT_ALIASES_CHECKED = 'payee_text_aliases_checked';

export interface StoreHealth {
  ok: boolean;
  kind: 'budget' | 'directory';
  migrations: string[];
  tables: number;
  error?: string;
}

export class BudgetStore extends DurableObject<Env> {
  protected readonly db: DurableDb;
  private startError: string | null = null;
  private armed = false;
  private readonly runner: JobRunner;
  private cachedBudgetId: string | null = null;
  private app: Hono<AppEnv> | null = null;
  private devApp: Hono<AppEnv> | null = null;
  private readonly usage: UsageCounter;
  /** Fair use: whether to report usage; null until read from storage or set by a request. */
  private counting: boolean | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new DurableDb(ctx.storage);
    this.usage = new UsageCounter(this.db.stats);
    this.runner = new JobRunner(ctx.storage, this.handlers(), (job, err) => this.onFailed(job, err));
    void ctx.blockConcurrencyWhile(async () => {
      try {
        const { applied } = migrate(ctx.storage, BUDGET_MIGRATIONS, Date.now());
        // Payees made by the old rules are filed again once (docs/payee-names.md 8), with no migration: checked
        // once per store, and queued only where old payees exist and the job hasn't run.
        const refile = await this.queueOnce(REFILE_CHECKED, QUEUE_REFILE).catch(() => false);
        // After a re-file that finished before this release, the old cleaned-text aliases go (once).
        const drop = await this.queueOnce(TEXT_ALIASES_CHECKED, QUEUE_DROP_TEXT_ALIASES).catch(() => false);
        const queued = refile || drop;
        // A migration may queue a job (0007 queues the plaid_name fill): point the alarm at it now, not at the next
        // job already waiting (up to 4 hours away). A failure here only delays it to that alarm.
        if (applied.length || queued) await this.runner.scheduleNext(Date.now()).catch(() => null);
      } catch (e) {
        // Refuse to serve a half-migrated schema; health() reports why.
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  /** Runs a one-time job's queueing SQL once per store (`flag` remembers it); true when it queued the job. */
  private async queueOnce(flag: string, sql: string): Promise<boolean> {
    if (await this.ctx.storage.get<boolean>(flag)) return false;
    const n = this.ctx.storage.sql.exec(sql, Date.now()).rowsWritten;
    await this.ctx.storage.put(flag, true);
    return n > 0;
  }

  // ---- RPC

  /** The budget's name and linked banks, for deleting an account (routes/people.ts). */
  async info(): Promise<{ name: string; banks: number }> {
    this.ready();
    return budgetInfo(this.ctx.storage);
  }

  /** An admin turned the account off (`true`) or on (store/account-life.ts). */
  async setDisabled(disabled: boolean): Promise<void> {
    this.ready();
    await setDisabled(this.ctx.storage, disabled, this.enqueue, () => this.timeZone());
    await this.runner.scheduleNext(Date.now());
  }

  /** Deletes everything in this store, for its user's own explicit delete (store/account-life.ts). */
  async wipe(budgetId: string): Promise<{ ok: boolean; why?: 'refused' | 'banks' }> {
    this.ready();
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
    const r = await wipeStore(this.ctx.storage, () => dir.isDeleting(budgetId));
    if (r.ok) {
      this.cachedBudgetId = null;
      this.armed = false;
      this.counting = null;
    }
    return r;
  }

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
    // A budget the Directory no longer knows (deleted) is never made again.
    if (!(await this.ensureBudget(caller.budgetId)))
      return new Response(
        JSON.stringify({ error: 'not_member', message: 'You don’t have access to this budget.' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    await this.rearm();
    this.app ??= withCaller((app) => app.use('/api/*', serverReadsOnly).route('/api', budgetApi));
    this.usage.request();
    if (caller.countUsage !== undefined) {
      this.counting ??= (await this.ctx.storage.get<boolean>(COUNT_KEY)) ?? false;
      if (caller.countUsage !== this.counting) {
        this.counting = caller.countUsage;
        await this.ctx.storage.put(COUNT_KEY, caller.countUsage);
      }
    }
    const mark = markReads(this.db.stats);
    try {
      return await this.serve(this.app, request, caller);
    } finally {
      noteHeavyRead(this.db.stats, mark, routeName(request), caller.budgetId);
      this.reportUsage(caller.budgetId);
    }
  }

  /** Local development and e2e only: /__dev (index.ts refuses it in production). */
  async dev(request: Request, caller: Caller): Promise<Response> {
    this.ready();
    if (this.env.PLAID_ENV === 'production' || this.env.SETUP_CODE)
      return new Response('Not found', { status: 404 });
    if (!(await this.ensureBudget(caller.budgetId))) return new Response('Not found', { status: 404 });
    this.devApp ??= withCaller((app) => {
      app.route('/__dev', dev);
    });
    return this.serve(this.devApp, request, caller);
  }

  private serve(app: Hono<AppEnv>, request: Request, caller: Caller): Promise<Response> {
    const env = { ...this.appEnv(), CALLER: caller };
    return answering(request, () =>
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
      // Worked out on the phone, not kept here (migration 0006): the phone works them out again.
      if (o.t && DROPPED_TABLES.includes(o.t)) continue;
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
    // The columns each table had in the backup: restoreVerify fingerprints only those, so a backup from before a
    // migration added a column still verifies.
    const cols = header ? {} : ((await this.ctx.storage.get<Record<string, string[]>>('restore_cols')) ?? {});
    for (const { t, r } of rows) {
      const have = new Set(cols[t] ?? []);
      for (const c of Object.keys(r)) have.add(c);
      cols[t] = [...have];
    }
    await this.ctx.storage.put('restore_cols', cols);
    if (footer !== undefined) await this.ctx.storage.put('restore_footer', footer);
    this.cachedBudgetId = null;
    return { ok: true, rows: rows.length };
  }

  /** Recomputes every table's row count and fingerprint and compares them with the backup's footer. */
  async restoreVerify(): Promise<{ ok: boolean; differences: string[] }> {
    const footer =
      (await this.ctx.storage.get<Record<string, { count: number; hash: string }>>('restore_footer')) ?? {};
    const backupCols = (await this.ctx.storage.get<Record<string, string[]>>('restore_cols')) ?? {};
    const db = this.adapter();
    const differences: string[] = [];
    for (const t of BUDGET_TABLES) {
      const meta = narrowMeta(await tableMeta(db, t), backupCols[t]);
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
    // Phones holding a copy of this budget download it again (D-45, docs/phone-budget.md section 8).
    if (differences.length === 0) await this.newSyncEpoch();
    return { ok: differences.length === 0, differences };
  }

  /** A new sync epoch in the Directory for this budget: phones throw their copies away and download again. */
  private async newSyncEpoch(): Promise<void> {
    const id = await this.budgetId().catch(() => null);
    if (!id || !this.env.DIRECTORY) return;
    await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME)).bumpSyncEpoch(id);
  }

  /**
   * Point-in-time recovery (runbooks/restore.md): rolls this budget's database back to `at` (epoch ms, within the
   * last 30 days). The sync epoch changes first, in the Directory, which the rollback can't reach; then the object
   * restarts on the restored database. Returns the bookmark that undoes the restore.
   */
  async restoreTo(at: number): Promise<{ undo: string }> {
    this.ready();
    await this.newSyncEpoch();
    const bookmark = await this.ctx.storage.getBookmarkForTime(at);
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    // Restart after answering, so the caller gets the undo bookmark.
    this.ctx.waitUntil(
      (async () => {
        await new Promise((r) => setTimeout(r, 100));
        this.ctx.abort('restoring');
      })(),
    );
    return { undo };
  }

  /** The budget's time zone, which sets the daily jobs' local clock times. */
  private timeZone(): string {
    const r = this.ctx.storage.sql.exec(`SELECT time_zone FROM budget LIMIT 1`).toArray()[0];
    return typeof r?.time_zone === 'string' ? r.time_zone : 'America/Los_Angeles';
  }

  /**
   * Daily safety net (6.2): recreate missing recurring jobs and make sure an alarm is set. A budget whose users
   * haven't signed in for 30 days (`idle`) and that has no banks stops its daily jobs instead, until its next request
   * (docs/open-signup.md 9); `resting` says it did.
   */
  async ensureJobs(o: { idle?: boolean } = {}): Promise<{
    ok: boolean;
    jobs: ReturnType<JobRunner['list']>;
    resting?: boolean;
  }> {
    this.ready();
    const now = Date.now();
    const budgetId = await this.budgetId().catch(() => null);
    if (!budgetId) return { ok: false, jobs: [] };
    if (await this.ctx.storage.get<boolean>(DISABLED_KEY)) return { ok: true, jobs: this.runner.list() };
    if (o.idle) {
      const banks = this.ctx.storage.sql
        .exec(`SELECT count(*) AS n FROM connection WHERE removed_at IS NULL`)
        .one() as { n: number };
      if (Number(banks.n) === 0) {
        this.ctx.storage.sql.exec(`DELETE FROM job WHERE recurring = 1`);
        await this.ctx.storage.put(RESTING_KEY, true);
        this.armed = false;
        await this.runner.scheduleNext(now);
        return { ok: true, jobs: this.runner.list(), resting: true };
      }
    }
    await ensureRecurring(this.enqueue, now, this.timeZone());
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
    this.usage.request();
    this.counting ??= (await this.ctx.storage.get<boolean>(COUNT_KEY)) ?? false;
    const mark = markReads(this.db.stats);
    let what = 'job';
    try {
      const r = await this.runner.runNext(Date.now());
      if (r.ran) what = `job:${r.kind}`;
    } finally {
      const id = this.cachedBudgetId ?? (await this.budgetId().catch(() => null));
      noteHeavyRead(this.db.stats, mark, what, id);
      if (id) this.reportUsage(id);
    }
  }

  /** Fair use: this store's rows and requests to the Directory, at most once a minute (store/shares.ts). */
  private reportUsage(budgetId: string): void {
    const u = this.usage.take(this.counting === true, Date.now());
    const dir = this.env.DIRECTORY?.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
    if (!u || !dir) return;
    this.ctx.waitUntil(dir.noteBudgetUsage(budgetId, u.written, u.read, u.requests).catch(() => undefined));
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
    // A resting budget (ensureJobs) gets its daily jobs back on its first request.
    if (await this.ctx.storage.get<boolean>(RESTING_KEY)) {
      await ensureRecurring(this.enqueue, Date.now(), this.timeZone());
      await this.ctx.storage.delete(RESTING_KEY);
    }
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

  private adapter(): Db {
    return this.db;
  }

  /**
   * The env every app function sees inside the store: the same bindings, with DB = this store's database, account
   * usage from the Directory, and JOBS, so the routes that start a sync queue a job
   * here (docs/multi-user.md 6.1).
   */
  private appEnv(): Env {
    const now = () => Date.now();
    const dir = this.env.DIRECTORY?.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
    return {
      ...this.env,
      DB: this.adapter(),
      ...(dir
        ? {
            USAGE: () => dir.usageToday(this.cachedBudgetId ?? undefined),
            NOTE_USAGE: (w: number, r: number) => dir.noteUsage(w, r),
          }
        : {}),
      ROUTE_LINK: async (itemId: string, connectionId: string) => {
        await this.enqueue('register_link', {
          id: `register_link:${connectionId}`,
          state: { itemId, connectionId },
          runAt: now(),
        });
      },
      RESTORE_TO: (at: number) => this.restoreTo(at),
      JOBS: {
        // routes/settings.ts startSync() has already taken the lease with this run id.
        sync: async (runId, connectionId, trigger) => {
          const state: SyncState = { phase: 'begin', holder: runId, trigger };
          await this.enqueue('sync', { id: runId, connectionId, state, runAt: now() });
        },
      },
    };
  }

  /** The store fills in its own budget row on first use (sign-up and setup create it in the Directory). */
  private async ensureBudget(budgetId: string): Promise<boolean> {
    if (this.cachedBudgetId === budgetId) return true;
    const now = Date.now();
    // A new store makes its budget row only for a budget the Directory knows and isn't deleting, so a late call
    // after a wipe can't bring a deleted budget back (docs/open-signup.md 12).
    const dir = this.env.DIRECTORY?.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
    if (
      dir &&
      this.ctx.storage.sql.exec(`SELECT 1 FROM budget WHERE id = ?`, budgetId).toArray().length === 0
    )
      if (!(await dir.budgetExists(budgetId))) return false;
    const created = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO budget (id, name, created_at, updated_at) VALUES (?, 'My budget', ?, ?)`,
      budgetId,
      now,
      now,
    ).rowsWritten;
    // A new budget gets its sync backstop, daily scan and maintenance now, not at the next daily check.
    if (created > 0) await ensureRecurring(this.enqueue, now, this.timeZone());
    this.cachedBudgetId = budgetId;
    return true;
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
      // Queued by the server before D-45; there is nothing to recompute here now.
      recompute: async () => ({ done: true }),
      backstop: (job, now) => backstopHandler(this.adapter(), this.enqueue)(job, now),
      daily_scan: (job, now) => dailyScanHandler(this.appEnv(), budgetId)(job, now),
      maintenance: (job, now) => maintenanceHandler(this.appEnv(), budgetId)(job, now),
      fill_plaid_name: (job, now) => fillPlaidNameHandler(this.adapter(), budgetId)(job, now),
      refile_payees: (job, now) => refilePayeesHandler(this.adapter(), budgetId)(job, now),
      drop_text_aliases: (job, now) => dropTextAliasesHandler(this.adapter())(job, now),
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
    c.set('syncEpoch', who.syncEpoch ?? 'e0');
    c.set('isAdmin', who.isAdmin === true);
    c.set('recoveryNoticeAt', who.recoveryNoticeAt ?? null);
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
