// Phase 0 of docs/multi-user.md: a throwaway Worker (`ledgerline-phase0`, never the live app) that runs the real
// app code inside a SQLite Durable Object through the D1-shaped adapter, one small step per alarm, so Cloudflare's
// analytics report the CPU of each step on its own. Driven by phase0/run.mjs from .github/workflows/phase0.yml, then
// deleted. Every route needs the random key the workflow generates.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { encryptToken, parseKeyring } from '@ledgerline/platform';
import { txn } from '../../../tools/plaid-mock/data.mjs';
import { SqlD1 } from '../src/store/adapter.js';
import { api } from '../src/routes/api.js';
import { dev } from '../src/measure/dev.js';
import { acquire } from '../src/sync/lease.js';
import { CHUNK, applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { markDirty, recompute } from '../src/budget/recompute.js';
import { seedBudget } from '../src/measure/budget-seed.js';
import m1 from '../../../packages/db/migrations/0001_init.sql';
import m2 from '../../../packages/db/migrations/0002_raw_pages_in_d1.sql';
import m3 from '../../../packages/db/migrations/0003_passkeys.sql';
import m4 from '../../../packages/db/migrations/0004_history_needs_nothing.sql';
import m5 from '../../../packages/db/migrations/0005_connection_setup_done.sql';
import m6 from '../../../packages/db/migrations/0006_read_costs.sql';
import m7 from '../../../packages/db/migrations/0007_data_version.sql';
import m8 from '../../../packages/db/migrations/0008_month_totals.sql';
import m9 from '../../../packages/db/migrations/0009_refill_due_month.sql';

const MIGRATIONS = [m1, m2, m3, m4, m5, m6, m7, m8, m9];

// The chunk sizes phase 0 measured locally (docs/measurements.md).
CHUNK.apply = 25;
CHUNK.process = 25;
const MONTHS = 2;

interface Env {
  STORE: DurableObjectNamespace<Phase0Store>;
  PHASE0_KEY: string;
  /** Local runs shorten the analytics gaps and repetitions. */
  GAP_MS?: string;
  REPS?: string;
}

const KEYS = '1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TOTAL = 3000;
const PAGE = 100;
const SCREENS = [
  '/api/session',
  '/api/badges',
  '/api/budget/2026-11',
  '/api/activity',
  '/api/activity?filter=attention',
  '/api/accounts',
  '/api/reports?month=2026-11',
];
let REPS = 30;
let GAP_MS = 70_000; // a full analytics minute between operation groups

type Step = { op: string; group: string; arg?: number; measure: boolean };

/** One Plaid-shaped /transactions/sync page, generated on its own (no full 3,000-row array per call). */
function pageBody(start: number): string {
  const added = Array.from({ length: Math.min(PAGE, TOTAL - start) }, (_, k) => txn(start + k, TOTAL));
  const next = start + added.length;
  return JSON.stringify({
    accounts: [],
    added,
    has_more: next < TOTAL,
    modified: [],
    next_cursor: btoa(String(next)),
    removed: [],
    request_id: 'req_phase0',
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  });
}

const provider = new PlaidProvider({
  clientId: 'c',
  secret: 's',
  env: 'sandbox',
  fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { cursor?: string };
    const start = body.cursor ? Number(atob(body.cursor)) : 0;
    return new Response(pageBody(start), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

function plan(kind: string): Step[] {
  const s: Step[] = [];
  const add = (op: string, group: string, n = 1, measure = false, arg?: (i: number) => number) => {
    for (let i = 0; i < n; i++) s.push({ op, group, measure, ...(arg ? { arg: arg(i) } : {}) });
  };
  if (kind === 'screens' || kind === 'screens-owner') {
    // 'screens-owner': about the owner's size (Nov 2026: 718 transactions over six months), for the Activity gate.
    add('seed-november', 'seed');
    add('history', 'seed', kind === 'screens-owner' ? 11 : 60, false, (i) => i + 1);
    for (const p of SCREENS) {
      add('screen-warm', `screen ${p}`, 2, false, () => SCREENS.indexOf(p));
      add('gap', 'gap');
      add('screen', `screen ${p}`, REPS, true, () => SCREENS.indexOf(p));
    }
  } else if (kind === 'sync') {
    add('sync-setup', 'seed');
    add('fetch', 'gap-fetch'); // fetch steps are measured too, in their own group
    add('gap', 'gap');
    add('fetch', 'sync fetch (100)', TOTAL / PAGE - 1, true);
    add('gap', 'gap');
    add('apply', 'sync apply (25)', (TOTAL / PAGE) * (PAGE / CHUNK.apply), true);
    add('gap', 'gap');
    add('process', 'sync process (25)', TOTAL / CHUNK.process, true);
  } else if (kind === 'recompute') {
    add('rc-seed-meta', 'seed');
    add('rc-seed-lines', 'seed', 120, false, (i) => i);
    add('rc-full', 'seed', 20);
    add('gap', 'gap');
    for (let e = 0; e < REPS; e++) {
      add('rc-edit', 'recompute edit (2 months)', 1, true);
      add('rc-chunk', 'recompute chunk (2 months)', 17, true);
    }
  } else if (kind === 'move') {
    add('gap', 'gap');
    add('move-in', 'move_in step (~150 KB)', REPS, true, (i) => i);
  }
  return s;
}

export class Phase0Store extends DurableObject<Env> {
  private readonly db: SqlD1;
  private app: Hono | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlD1(ctx.storage);
    if (env.GAP_MS) GAP_MS = Number(env.GAP_MS);
    if (env.REPS) REPS = Number(env.REPS);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS _p0 (k TEXT PRIMARY KEY, v TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS _timeline (i INTEGER PRIMARY KEY, op TEXT, grp TEXT, measure INTEGER, start INTEGER, end INTEGER, ok INTEGER, err TEXT);
         CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY);`,
      );
      const done = new Set(
        ctx.storage.sql
          .exec('SELECT n FROM _migrations')
          .toArray()
          .map((r) => Number(r.n)),
      );
      for (let i = 0; i < MIGRATIONS.length; i++) {
        if (done.has(i)) continue;
        await this.db.exec(MIGRATIONS[i]!);
        ctx.storage.sql.exec('INSERT INTO _migrations (n) VALUES (?)', i);
      }
    });
  }

  private get(k: string): string | null {
    const r = this.ctx.storage.sql.exec('SELECT v FROM _p0 WHERE k = ?', k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private set(k: string, v: string): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO _p0 (k, v) VALUES (?, ?)', k, v);
  }

  private hono(): Hono {
    if (this.app) return this.app;
    const app = new Hono();
    app.route('/api', api as never);
    app.route('/__dev', dev as never);
    this.app = app;
    return app;
  }
  private appEnv() {
    return {
      DB: this.db,
      PLAID_ENV: 'sandbox',
      DEV_AUTH_EMAIL: 'owner@example.com',
      DEV_ROUTES: '1',
      FAKE_NOW: '2026-11-14T20:00:00Z',
      TOKEN_KEYS: KEYS,
      TOKEN_KEY_CURRENT: '1',
      RECOMPUTE: { create: async () => ({}), get: async () => ({}) },
      SYNC: { create: async () => ({}), get: async () => ({}) },
    };
  }
  private async call(path: string, method = 'GET'): Promise<void> {
    const r = await this.hono().fetch(
      new Request('https://phase0.test' + path, {
        method,
        headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
        body: method === 'GET' ? undefined : '{}',
      }),
      this.appEnv() as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    const t = await r.text();
    if (r.status >= 400) throw new Error(`${path}: ${r.status} ${t.slice(0, 120)}`);
  }

  // ---- control (RPC from the Worker)

  async start(kind: string): Promise<{ steps: number }> {
    const steps = plan(kind);
    this.set('plan', JSON.stringify(steps));
    this.set('next', '0');
    this.set('kind', kind);
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { steps: steps.length };
  }

  async status(): Promise<unknown> {
    const steps = JSON.parse(this.get('plan') ?? '[]') as Step[];
    const next = Number(this.get('next') ?? 0);
    const tl = this.ctx.storage.sql
      .exec(
        `SELECT grp, measure, count(*) AS n, min(start) AS start, max(end) AS end, sum(ok = 0) AS failed, max(err) AS err
         FROM _timeline GROUP BY grp, measure ORDER BY min(i)`,
      )
      .toArray();
    return {
      kind: this.get('kind'),
      total: steps.length,
      next,
      done: next >= steps.length,
      groups: tl,
      stats: this.db.stats,
    };
  }

  /** Busy loop for the CPU-limit probe: does a Durable Object request on Free get 10 ms or 30 s? */
  async burn(iterations: number): Promise<number> {
    let x = 0;
    for (let i = 0; i < iterations; i++) x += Math.sqrt(i);
    return x;
  }

  async pitr(): Promise<unknown> {
    try {
      const b = await this.ctx.storage.getBookmarkForTime(Date.now() - 60_000);
      return { ok: true, bookmark: String(b).slice(0, 24) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async alarmTest(): Promise<unknown> {
    this.set('kind', 'alarm-test');
    this.set('alarm-attempts', '0');
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { started: true };
  }

  async alarmTestStatus(): Promise<unknown> {
    return { attempts: Number(this.get('alarm-attempts') ?? 0), lastRetryCount: this.get('alarm-retry') };
  }

  // ---- the alarm runner: one step per invocation

  override async alarm(info?: { retryCount: number; isRetry: boolean }): Promise<void> {
    if (this.get('kind') === 'alarm-test') {
      // Count the attempt durably, then exceed any 10 ms limit on purpose.
      this.set('alarm-attempts', String(Number(this.get('alarm-attempts') ?? 0) + 1));
      this.set('alarm-retry', String(info?.retryCount ?? 0));
      await this.ctx.storage.sync();
      await this.burn(40_000_000);
      return;
    }
    const steps = JSON.parse(this.get('plan') ?? '[]') as Step[];
    const i = Number(this.get('next') ?? 0);
    const step = steps[i];
    if (!step) return;
    const start = Date.now();
    let ok = 1;
    let err: string | null = null;
    try {
      if (step.op === 'gap') {
        this.set('next', String(i + 1));
        this.ctx.storage.sql.exec(
          'INSERT INTO _timeline (i, op, grp, measure, start, end, ok) VALUES (?, ?, ?, 0, ?, ?, 1)',
          i,
          step.op,
          step.group,
          start,
          start,
        );
        await this.ctx.storage.setAlarm(Date.now() + GAP_MS);
        return;
      }
      await this.run(step);
    } catch (e) {
      ok = 0;
      err = String(e instanceof Error ? e.message : e).slice(0, 200);
    }
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO _timeline (i, op, grp, measure, start, end, ok, err) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      i,
      step.op,
      step.group,
      step.measure ? 1 : 0,
      start,
      Date.now(),
      ok,
      err,
    );
    this.set('next', String(i + 1));
    if (i + 1 < steps.length) await this.ctx.storage.setAlarm(Date.now() + 300);
  }

  private async run(step: Step): Promise<void> {
    const d1 = this.db as unknown as D1Database;
    const now = Date.UTC(2026, 10, 14, 20);
    switch (step.op) {
      case 'seed-november':
        return this.call('/__dev/seed-november', 'POST');
      case 'history': {
        const i = step.arg!;
        const cols = this.ctx.storage.sql
          .exec('PRAGMA table_info(bank_txn)')
          .toArray()
          .map((c) => String(c.name));
        const sel = cols
          .map((c) =>
            c === 'txn_key'
              ? `txn_key || '-h${i}'`
              : c === 'provider_txn_id'
                ? `provider_txn_id || '-h${i}'`
                : c === 'date' || c === 'authorized_date'
                  ? `date('2026-11-01', '-${i * 18} days')`
                  : c === 'pending'
                    ? '0'
                    : c,
          )
          .join(', ');
        await d1.batch([
          d1.prepare(
            `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
          ),
          d1.prepare(
            `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, created_at, updated_at)
             SELECT txn_key || '-h${i}', budget_id, payee_id, NULL, created_at, updated_at FROM txn_overlay
             WHERE txn_key NOT LIKE '%-h%' AND txn_key IN (SELECT txn_key FROM bank_txn)`,
          ),
        ]);
        return;
      }
      case 'screen-warm':
      case 'screen':
        return this.call(SCREENS[step.arg!]!);
      case 'sync-setup': {
        const t = Date.now();
        const tok = await encryptToken(parseKeyring(KEYS, '1'), 'access-sandbox-x', 'con1');
        await d1.batch([
          d1
            .prepare(
              `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1','B','2023-11',?1,?1)`,
            )
            .bind(t),
          d1
            .prepare(
              `INSERT INTO connection (id, budget_id, provider, institution_name, access_token_enc, key_version, linked_at, created_at, updated_at)
               VALUES ('con1','b1','plaid','Sandbox',?1,1,?2,?2,?2)`,
            )
            .bind(tok.enc, t),
        ]);
        await acquire(d1, 'con1', 'run1', t);
        await beginRun(this.ctx_(), 'measure');
        this.set('page', '0');
        this.set('cursor', '');
        return;
      }
      case 'fetch': {
        const page = Number(this.get('page'));
        const cursor = this.get('cursor') || null;
        const r = await fetchPage(this.ctx_(), provider, 'access-sandbox-x', 'run1', 0, page, cursor, PAGE);
        if (r.kind !== 'page') throw new Error('mutation');
        this.set('page', String(page + 1));
        this.set('cursor', r.nextCursor ?? '');
        this.set('applyPage', '0');
        this.set('applyChunk', '0');
        return;
      }
      case 'apply': {
        const p = Number(this.get('applyPage'));
        const c = Number(this.get('applyChunk'));
        const r = await applyPage(this.ctx_(), provider, 'run1', p, c);
        if (r.pageDone) {
          this.set('applyPage', String(p + 1));
          this.set('applyChunk', '0');
        } else this.set('applyChunk', String(c + 1));
        return;
      }
      case 'process':
        await processPending({ DB: d1 } as never, 'b1');
        return;
      case 'rc-seed-meta': {
        const seed = seedBudget();
        await d1
          .prepare(
            `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES ('r1', 'B', ?1, 'America/Los_Angeles', 0, 0)`,
          )
          .bind(seed.startMonth)
          .run();
        // Accounts the seeded categories and lines point at (foreign keys are enforced, as in D1).
        await d1.batch(
          [
            ['card1', 'credit'],
            ['card2', 'credit'],
            ['chk', 'checking'],
            ['sav1', 'savings'],
            ['sav2', 'savings'],
            ['sav3', 'savings'],
          ].map(([id, kind]) =>
            d1
              .prepare(
                `INSERT INTO account (id, budget_id, name, kind, budget_from, created_at, updated_at) VALUES (?1, 'r1', ?1, ?2, ?3, 0, 0)`,
              )
              .bind(id, kind, `${seed.startMonth}-01`),
          ),
        );
        await d1.batch(
          seed.categories.map((c) =>
            d1
              .prepare(
                `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?1, 'r1', ?1, ?2, ?3, 0, 0)`,
              )
              .bind(c.id, c.kind, c.card_account_id),
          ),
        );
        for (let k = 0; k < seed.assignments.length; k += 200)
          await d1.batch(
            seed.assignments
              .slice(k, k + 200)
              .map((a) =>
                d1
                  .prepare(
                    `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES ('r1', ?1, ?2, ?3, 0)`,
                  )
                  .bind(a.category_id, a.month, a.amount),
              ),
          );
        this.set('rcStart', seed.startMonth);
        return;
      }
      case 'rc-seed-lines': {
        const lines = seedBudget().lines;
        const per = Math.ceil(lines.length / 120);
        const part = lines.slice(step.arg! * per, step.arg! * per + per);
        if (part.length)
          await d1.batch(
            part.map((l) =>
              d1
                .prepare(
                  `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref)
                   VALUES ('r1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
                )
                .bind(...l),
            ),
          );
        return;
      }
      case 'rc-full':
        await recompute(d1, 'r1', now, { force: this.get('rcForced') !== '1', maxMonths: MONTHS });
        this.set('rcForced', '1');
        return;
      case 'rc-edit':
        await d1.batch([
          d1
            .prepare(
              `UPDATE assignment SET amount = amount + 100, updated_at = ?2 WHERE budget_id = 'r1' AND category_id = 'cat00' AND month = ?1`,
            )
            .bind(this.get('rcStart'), now) as never,
          markDirty(d1, 'r1', this.get('rcStart') as never, now),
        ]);
        await recompute(d1, 'r1', now, { maxMonths: MONTHS });
        return;
      case 'rc-chunk':
        await recompute(d1, 'r1', now, { maxMonths: MONTHS });
        return;
      case 'move-in': {
        // A move_in step: parse ~150 KB of rows as they arrive from D1's JSON response, insert them, and fold them
        // into the table's running hash.
        const rows = Array.from({ length: 450 }, (_, k) => ({
          id: step.arg! * 1000 + k,
          a: 'x'.repeat(200),
          b: k * 7,
          c: `2026-11-${String((k % 28) + 1).padStart(2, '0')}`,
          d: null,
        }));
        const text = JSON.stringify({ results: rows });
        const parsed = (JSON.parse(text) as { results: typeof rows }).results;
        this.ctx.storage.sql.exec(
          'CREATE TABLE IF NOT EXISTS move_t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER, c TEXT, d TEXT)',
        );
        const stmts = parsed.map((r) =>
          d1
            .prepare('INSERT OR REPLACE INTO move_t (id, a, b, c, d) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind(r.id, r.a, r.b, r.c, r.d),
        );
        await d1.batch(stmts);
        const canon = parsed.map((r) => `i${r.id}|t${r.a}|i${r.b}|t${r.c}|n`).join('\n');
        const prev = this.get('moveHash') ?? '';
        const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prev + canon));
        this.set('moveHash', [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''));
        return;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }

  private ctx_() {
    return {
      db: this.db as unknown as D1Database,
      connectionId: 'con1',
      budgetId: 'b1',
      holder: 'run1',
      now: Date.now(),
    };
  }
}

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  if (!c.env.PHASE0_KEY || c.req.header('x-phase0-key') !== c.env.PHASE0_KEY) return c.text('not found', 404);
  await next();
});
const stub = (env: Env, name: string) => env.STORE.get(env.STORE.idFromName(name));
app.post('/start/:kind', async (c) =>
  c.json(await stub(c.env, c.req.param('kind')).start(c.req.param('kind'))),
);
app.get('/status/:kind', async (c) => c.json(await stub(c.env, c.req.param('kind')).status()));
app.get('/burn/:n', async (c) => {
  try {
    await stub(c.env, 'probe').burn(Number(c.req.param('n')));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: String(e) });
  }
});
app.get('/pitr', async (c) => c.json(await stub(c.env, 'probe').pitr()));
app.post('/alarm-test', async (c) => c.json(await stub(c.env, 'alarmtest').alarmTest()));
app.get('/alarm-test', async (c) => c.json(await stub(c.env, 'alarmtest').alarmTestStatus()));

export default app;
