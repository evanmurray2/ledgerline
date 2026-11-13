// One Durable Object per budget (docs/multi-user.md 5.3). Every budget is locked (D-102): the store holds its
// sealed log, sealed bank runs and snapshots, its bank links and the job that fetches them, and never reads or
// changes the budget itself. A new budget is made on its first device and sent here once (seal/start.ts). The
// store migrates itself at start and runs its background work on alarms (6.1). The Worker reaches it only after
// the Directory has said whose budget it is.
import type { Db } from '@ledgerline/db/sql';
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import type { Caller } from './directory.js';
import { DIRECTORY_NAME } from './directory.js';
import { isSealed, refusal } from './marks.js';
import { logApi } from '../seal/log-routes.js';
import {
  failSealedFetch,
  noteOpened,
  OPENED_EVERY_MS,
  queueSealedFetch,
  SEALED_BACKSTOP,
  SEALED_BACKSTOP_ID,
  SEALED_FETCH,
  sealedBackstopHandler,
  sealedFetchHandler,
  sealedWebhook,
  type FetchDeps,
} from '../seal/fetch-job.js';
import { sealedApi, sealedPath } from '../seal/sealed-routes.js';
import { startApi } from '../seal/start-routes.js';
import { runDeps } from '../seal/runs.js';
import { parseKeyring } from '@ledgerline/platform';
import { SEALED_HEADER } from '@ledgerline/contracts';
import type { Env } from '../env.js';
import { DurableDb } from './adapter.js';
import { appliedMigrations, migrate } from './migrate.js';
import { BUDGET_STORE_MIGRATIONS } from './migrations.gen.js';
import { JobRunner, type Enqueue, type Handler, type Job } from './jobs.js';
import { makeProvider, pageSize } from '../sync/provider.js';
import { writeBudgetState } from '../sync/breaker.js';
import { answering } from './body.js';
import { UsageCounter } from './shares.js';
import { DISABLED_KEY, budgetInfo, removeBanks, setDisabled, wipeStore } from './account-life.js';

const TRY_AGAIN = 'Something went wrong. Try again.';
/** Whether this store reports its usage for fair use (store/shares.ts), as the Directory last said. */
const COUNT_KEY = 'count_usage';

export interface StoreHealth {
  ok: boolean;
  kind: 'budget' | 'directory';
  migrations: string[];
  tables: number;
  error?: string;
}

/** How long a store keeps the Directory's usage answer (usage30). */
const USAGE_CACHE_MS = 30_000;

export class BudgetStore extends DurableObject<Env> {
  protected readonly db: DurableDb;
  private startError: string | null = null;
  private readonly runner: JobRunner;
  private cachedBudgetId: string | null = null;
  private logApp: Hono<AppEnv> | null = null;
  private sealedApp: Hono<AppEnv> | null = null;
  private startApp: Hono<AppEnv> | null = null;
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
        const { applied } = migrate(ctx.storage, BUDGET_STORE_MIGRATIONS, Date.now());
        // A migration may queue a job: point the alarm at it now. A failure here only delays it to the next alarm.
        if (applied.length) await this.runner.scheduleNext(Date.now()).catch(() => null);
      } catch (e) {
        // Refuse to serve a half-migrated schema; health() reports why.
        this.startError = e instanceof Error ? e.message : String(e);
      }
    });
  }

  // ---- RPC

  /** The budget's linked banks, for deleting an account (routes/people.ts). */
  async info(): Promise<ReturnType<typeof budgetInfo>> {
    this.ready();
    return budgetInfo(this.ctx.storage);
  }

  /**
   * Removes every bank link at Plaid, for an account being deleted (store/account-life.ts removeBanks). Refused
   * unless the Directory holds the deletion record for this budget; the Directory never asks for an admin's.
   */
  async removeBanks(budgetId: string): Promise<{ removed: number; left: number; refused?: true }> {
    this.ready();
    if (!(await this.directory().isDeleting(budgetId)))
      return { removed: 0, left: budgetInfo(this.ctx.storage).banks, refused: true };
    const env = this.appEnv();
    // No fetch may start again on a link that is being removed.
    this.ctx.storage.sql.exec(`DELETE FROM job WHERE kind IN (?, ?)`, SEALED_FETCH, SEALED_BACKSTOP);
    return removeBanks(this.ctx.storage, {
      plaidEnv: env.PLAID_ENV,
      otherUsersBanks: env.OTHER_USERS_BANKS,
      keyring: () => parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
      provider: () => makeProvider(env),
    });
  }

  /** An admin turned the account off (`true`) or on (store/account-life.ts). */
  async setDisabled(disabled: boolean): Promise<void> {
    this.ready();
    await setDisabled(this.ctx.storage, disabled, () => this.queueBackstop(Date.now()));
    await this.runner.scheduleNext(Date.now());
  }

  /** Deletes everything in this store, for its user's own explicit delete (store/account-life.ts). */
  async wipe(budgetId: string): Promise<{ ok: boolean; why?: 'refused' | 'banks' }> {
    this.ready();
    const r = await wipeStore(this.ctx.storage, () => this.directory().isDeleting(budgetId));
    if (r.ok) {
      this.cachedBudgetId = null;
      this.counting = null;
    }
    return r;
  }

  /** Called by the deploy smoke test and the daily check; running it applies pending migrations. */
  async health(): Promise<StoreHealth> {
    return storeHealth(this.ctx.storage, 'budget', this.startError);
  }

  /**
   * The budget's routes for a caller the Worker has already authenticated with the Directory. The store can only
   * be reached through its binding, so the caller it is given can be trusted.
   */
  async api(request: Request, caller: Caller): Promise<Response> {
    this.ready();
    // A budget the Directory no longer knows (deleted) is never made again.
    if (!(await this.ensureBudget(caller.budgetId)))
      return new Response(
        JSON.stringify({ error: 'not_member', message: 'You don’t have access to this budget.' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );
    const path = new URL(request.url).pathname;
    const sealed = this.sealed();
    this.usage.request();
    if (caller.countUsage !== undefined) {
      this.counting ??= (await this.ctx.storage.get<boolean>(COUNT_KEY)) ?? false;
      if (caller.countUsage !== this.counting) {
        this.counting = caller.countUsage;
        await this.ctx.storage.put(COUNT_KEY, caller.countUsage);
      }
    }
    try {
      // A new budget starts locked (seal/start.ts, D-102): the device sends its first entry and first snapshot.
      if (path.startsWith('/api/start/')) {
        this.startApp ??= withCaller((app) => app.route('/api', startApi));
        const r = await this.serve(this.startApp, request, caller);
        if (r.ok && request.method === 'POST' && path === '/api/start/seal') {
          await this.queueBackstop(Date.now());
          await this.runner.scheduleNext(Date.now());
        }
        return r;
      }
      // A sealed budget lives in its log (seal/log-routes.ts).
      if (sealed && (path === '/api/log' || path.startsWith('/api/log/'))) {
        this.logApp ??= withCaller((app) => app.route('/api', logApi));
        await this.openedSealed(caller);
        await this.rearm();
        return await this.serve(this.logApp, request, caller);
      }
      // Who is signed in, the bank links by id, and the few account calls (seal/sealed-routes.ts). For a budget
      // that is not sealed yet, the session tells the device to make it; what wants the budget's key is refused
      // there. The session goes only to an app that says it can open a locked budget (`x-ledgerline-sealed`): an
      // older app is told to update.
      if (
        sealedPath(request.method, path) &&
        (path !== '/api/session' || request.headers.get(SEALED_HEADER) === '1')
      ) {
        this.sealedApp ??= withCaller((app) => app.route('/api', sealedApi));
        if (sealed) await this.openedSealed(caller);
        const r = await this.serve(this.sealedApp, request, caller);
        // A fetch the person asked for starts now, one job per link asked (seal/fetch-job.ts); so does a new link's
        // first run, which describes it. The backstop's own job is not moved: a pending job keeps its time when it
        // is queued again.
        if (
          sealed &&
          r.ok &&
          request.method === 'POST' &&
          /\/connections\/(([^/]+\/)?refresh|link-finish)$/.test(path)
        )
          await this.queueAsked();
        return r;
      }
      // The bank's news about a sealed budget's link starts a sealed fetch (seal/fetch-job.ts). The Worker checked
      // the webhook before it came here; it is checked again.
      if (sealed && path === '/api/webhooks/plaid' && request.method === 'POST') {
        const ev = await makeProvider(this.appEnv())
          .verifyWebhook(request)
          .catch(() => null);
        if (!ev) return Response.json({ error: 'unauthorized' }, { status: 401 });
        await sealedWebhook((await this.fetchDeps()).runs, this.enqueue, ev, Date.now());
        await this.rearm();
        return Response.json({ ok: true });
      }
      const no = refusal(request.method, path);
      return new Response(JSON.stringify(no.body), {
        status: no.status,
        headers: { 'content-type': 'application/json' },
      });
    } finally {
      this.reportUsage(caller.budgetId);
    }
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

  private directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(DIRECTORY_NAME));
  }

  /**
   * Daily safety net (6.2): recreate missing recurring jobs and make sure an alarm is set. The only work on the
   * server is fetching a sealed budget's bank runs (seal/fetch-job.ts); a budget that is not sealed yet has none.
   * `idle` is kept for the Directory's call; a budget's jobs are the same whether its users are idle or not.
   */
  async ensureJobs(_o: { idle?: boolean } = {}): Promise<{
    ok: boolean;
    jobs: ReturnType<JobRunner['list']>;
    resting?: boolean;
  }> {
    this.ready();
    const now = Date.now();
    const budgetId = await this.budgetId().catch(() => null);
    if (!budgetId) return { ok: false, jobs: [] };
    if (await this.ctx.storage.get<boolean>(DISABLED_KEY)) return { ok: true, jobs: this.runner.list() };
    if (!this.sealed()) return { ok: true, jobs: this.runner.list() };
    await this.queueBackstop(now);
    // Its Items stay routed to it in the Directory, so the bank's webhooks arrive.
    for (const c of this.ctx.storage.sql
      .exec(`SELECT connection_id AS id, provider_item_id FROM bank_link WHERE provider_item_id IS NOT NULL`)
      .toArray())
      await this.enqueue('register_link', {
        id: `register_link:${String(c.id)}`,
        state: { itemId: String(c.provider_item_id), connectionId: String(c.id) },
        runAt: now,
      });
    await this.runner.scheduleNext(now);
    return { ok: true, jobs: this.runner.list() };
  }

  async jobs(): Promise<ReturnType<JobRunner['list']>> {
    return this.runner.list();
  }

  // ---- alarms: one job step per invocation

  override async alarm(): Promise<void> {
    this.ready();
    this.usage.request();
    this.counting ??= (await this.ctx.storage.get<boolean>(COUNT_KEY)) ?? false;
    try {
      await this.runner.runNext(Date.now());
    } finally {
      const id = this.cachedBudgetId ?? (await this.budgetId().catch(() => null));
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

  /** The budget lives in its sealed log (store/marks.ts). */
  private sealed(): boolean {
    return isSealed(this.ctx.storage.sql);
  }

  /** The sealed budget's recurring check: the backstop of its fetches (seal/fetch-job.ts). */
  private async queueBackstop(now: number): Promise<void> {
    if (this.sealed())
      await this.enqueue(SEALED_BACKSTOP, { id: SEALED_BACKSTOP_ID, runAt: now, recurring: true });
  }

  /** A fetch for each link that asked for one (seal/fetch-job.ts), now. */
  private async queueAsked(): Promise<void> {
    const asked = await this.db
      .prepare(
        `SELECT id FROM bank_link WHERE fetch_requested = 1 AND mac IS NOT NULL AND provider = 'plaid' AND status = 'ok' ORDER BY id`,
      )
      .all<{ id: string }>();
    const runs = (await this.fetchDeps()).runs;
    for (const l of asked.results) await queueSealedFetch(runs, this.enqueue, l.id, Date.now());
    await this.runner.scheduleNext(Date.now());
  }

  /** When this instance last noted that a person opened the sealed budget (seal/fetch-job.ts noteOpened). */
  private openedNoted = 0;

  /**
   * A person's request reached a sealed budget: it is noted as opened (A3), and when fetching had rested for 90
   * days, it starts again at once.
   */
  private async openedSealed(caller: Caller): Promise<void> {
    if (caller.userId === 'system' || caller.userId === 'service') return;
    const now = Date.now();
    if (now - this.openedNoted < OPENED_EVERY_MS) return;
    this.openedNoted = now;
    if (await noteOpened(this.db, now)) await this.queueAsked();
  }

  /**
   * Cloudflare drops an alarm that keeps failing (for example all day while writes are refused). A sealed budget
   * whose alarm was lost gets it back on its next request.
   */
  private async rearm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.runner.scheduleNext(Date.now());
  }

  protected ready(): void {
    if (!this.startError) return;
    // A failed start (for example Cloudflare refusing writes for the rest of the day) is retried on the next call,
    // so the object recovers by itself once writes are allowed again instead of waiting to be evicted.
    try {
      migrate(this.ctx.storage, BUDGET_STORE_MIGRATIONS, Date.now());
      this.startError = null;
    } catch (e) {
      this.startError = e instanceof Error ? e.message : String(e);
      throw new Error(`store_unavailable: ${this.startError}`);
    }
  }

  /** The Directory's answer on today's usage, kept a short while for the write checks. */
  private usageCache: { at: number; value: Awaited<ReturnType<NonNullable<Env['USAGE']>>> } | null = null;

  /**
   * Today's usage, asked of the Directory at most every USAGE_CACHE_MS: each ask is a Durable Object request of its
   * own. The Directory works its own state out at most once a minute too (STATE_MS), so this adds at most that much
   * to how late a limit is noticed.
   */
  private async usage30(ask: () => ReturnType<NonNullable<Env['USAGE']>>) {
    const now = Date.now();
    if (this.usageCache && now - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.value;
    const value = await ask();
    this.usageCache = { at: now, value };
    return value;
  }

  private adapter(): Db {
    return this.db;
  }

  /**
   * The env every route sees inside the store: the same bindings, with DB = this store's database and account
   * usage from the Directory (docs/multi-user.md 6.1).
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
            USAGE_FOR_WRITE: () => this.usage30(() => dir.usageToday(this.cachedBudgetId ?? undefined)),
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
      DROP_ROUTE: async (itemId: string) => {
        const id = this.cachedBudgetId ?? (await this.budgetId().catch(() => null));
        if (dir && id) await dir.dropRoute(itemId, id);
      },
    };
  }

  /**
   * The store fills in its own budget row on first use (sign-up and setup create the budget in the Directory). The
   * row says only which budget this is: the budget itself is made on the device (seal/start.ts).
   */
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
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO budget (id, name, created_at, updated_at) VALUES (?, 'My budget', ?, ?)`,
      budgetId,
      now,
      now,
    );
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

  private async fetchDeps(): Promise<FetchDeps> {
    const env = this.appEnv();
    return {
      runs: runDeps(
        this.adapter(),
        await this.budgetId(),
        parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
      ),
      provider: () => makeProvider(env),
      pageSize: pageSize(env),
      budgetState: async () => ((await writeBudgetState(env)) === 'normal' ? 'normal' : 'pause'),
    };
  }

  /**
   * The job handlers. The sealed kinds run only in a sealed budget. Any other job found in a store (a kind from
   * before D-102, or the old purge and link check, D-106) is dropped unrun.
   */
  private handlers(): Record<string, Handler> {
    const sealedOnly =
      (h: Handler): Handler =>
      (job, now) =>
        this.sealed() ? h(job, now) : Promise.resolve({ done: true });
    const known: Record<string, Handler> = {
      [SEALED_FETCH]: sealedOnly(async (job, now) => sealedFetchHandler(await this.fetchDeps())(job, now)),
      [SEALED_BACKSTOP]: sealedOnly(async (job, now) =>
        sealedBackstopHandler((await this.fetchDeps()).runs, this.enqueue)(job, now),
      ),
      register_link: async (job) => {
        // Retried until the Directory answers (6.4).
        const { itemId, connectionId } = job.state as { itemId: string; connectionId: string };
        await this.directory().registerRoute(itemId, await this.budgetId(), connectionId);
        return { done: true };
      },
    };
    const drop: Handler = () => Promise.resolve({ done: true });
    return new Proxy(known, { get: (t, kind: string) => t[kind] ?? drop });
  }

  private async onFailed(job: Job, error: string): Promise<void> {
    console.log(JSON.stringify({ event: 'job_failed', kind: job.kind, id: job.id, error }));
    if (job.kind === SEALED_FETCH) await failSealedFetch((await this.fetchDeps()).runs, job, error);
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
    c.set('isAdmin', who.isAdmin === true);
    c.set('wayIn', who.wayIn ?? null);
    c.set('signed', who.signed ?? null);
    c.set('recoveryKeyUsedAt', who.recoveryKeyUsedAt ?? null);
    return next();
  });
  mount(app);
  // A path or method the API doesn't have answers JSON too, so the app can read it.
  app.notFound((c) => c.json({ error: 'not_found', message: TRY_AGAIN }, 404));
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
