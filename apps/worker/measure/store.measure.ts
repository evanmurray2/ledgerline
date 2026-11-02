// Phase 0 of docs/multi-user.md (v2): would the hot paths fit 10 ms of CPU if each budget's SQLite ran in-process
// (a Durable Object) instead of inside D1? For each path this reports the Worker CPU today (`jsMs`: SQLite
// excluded, as in production) and the CPU spent executing SQLite and building result rows (`execMs`). In a
// Durable Object both run on the same thread, so `jsMs + execMs` is the estimate. It is slightly high, because
// `jsMs` still includes the D1 client's JSON round trip, which a Durable Object doesn't do.
// Writes .measure/store.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, test } from 'vitest';
import { Hono } from 'hono';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { encryptToken, parseKeyring } from '@ledgerline/platform';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { api } from '../src/routes/api.js';
import { dev } from '../src/measure/dev.js';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { markDirty, recompute } from '../src/budget/recompute.js';
import { seedBudget } from '../src/measure/budget-seed.js';
import type { AppEnv } from '../src/http/context.js';
import { cpu, freshDb, stats } from './harness.js';

type Run = { jsMs: number; execMs: number; storeMs: number };
const summary = (rs: Run[]) => ({
  jsMs: stats(rs.map((r) => r.jsMs)),
  execMs: stats(rs.map((r) => r.execMs)),
  storeMs: stats(rs.map((r) => r.storeMs)),
});
const run = (r: { ms: number; execMs: number }): Run => ({
  jsMs: +r.ms.toFixed(2),
  execMs: +r.execMs.toFixed(2),
  storeMs: +(r.ms + r.execMs).toFixed(2),
});

const out: Record<string, unknown> = {};

/** SQLite time per statement over the runs since profiling started, top first (ms per run). */
function topSql(db: { bySql: Map<string, { micros: number; calls: number }> | null }, runs: number) {
  const m = db.bySql!;
  db.bySql = null;
  return [...m.entries()]
    .sort((a, b) => b[1].micros - a[1].micros)
    .slice(0, 6)
    .map(([sql, e]) => ({
      msPerRun: +(e.micros / 1000 / runs).toFixed(2),
      calls: e.calls,
      sql: sql.slice(0, 220),
    }));
}

test('screens with three years of history', async () => {
  const db = freshDb();
  const d1 = db as unknown as D1Database;
  const app = new Hono<AppEnv>();
  app.route('/api', api);
  app.route('/__dev', dev);
  const env = {
    DB: d1,
    PLAID_ENV: 'sandbox',
    DEV_AUTH_EMAIL: 'owner@example.com',
    DEV_ROUTES: '1',
    FAKE_NOW: '2026-11-14T20:00:00Z',
    TOKEN_KEYS: '1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    TOKEN_KEY_CURRENT: '1',
    RECOMPUTE: { create: async () => ({}), get: async () => ({}) },
    SYNC: { create: async () => ({}), get: async () => ({}) },
  };
  const call = async (p: string, method = 'GET') => {
    const r = await app.fetch(
      new Request('https://ledgerline.test' + p, {
        method,
        headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
        body: method === 'GET' ? undefined : '{}',
      }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    const text = await r.text();
    if (r.status >= 400) throw new Error(`${p}: ${r.status} ${text.slice(0, 200)}`);
    return r.status;
  };
  await call('/__dev/seed-november', 'POST');
  // History: copies of the seeded bank rows, one copy per 18 days going back about three years.
  const cols = (await d1.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
    (c) => c.name,
  );
  for (let i = 1; i <= 60; i++) {
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
    await d1
      .prepare(
        `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
      )
      .run();
    await d1
      .prepare(
        `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, created_at, updated_at)
         SELECT txn_key || '-h${i}', budget_id, payee_id, NULL, created_at, updated_at FROM txn_overlay
         WHERE txn_key NOT LIKE '%-h%' AND txn_key IN (SELECT txn_key FROM bank_txn)`,
      )
      .run();
  }
  const txns = (await d1.prepare(`SELECT count(*) AS n FROM bank_txn`).first<{ n: number }>())!.n;
  const screens = [
    '/api/session',
    '/api/badges',
    '/api/budget/2026-11',
    '/api/activity',
    '/api/activity?filter=attention',
    '/api/accounts',
    '/api/owed',
    '/api/reports?month=2026-11',
    '/api/settings/categories',
  ];
  const res: Record<string, unknown> = {};
  for (const p of screens) {
    await call(p);
    await call(p); // warm: stored totals written, JIT warm
    const rs: Run[] = [];
    db.bySql = new Map();
    for (let i = 0; i < 7; i++) rs.push(run(await cpu(db, () => call(p))));
    res[p] = { ...summary(rs), topSql: topSql(db, 7) };
  }
  out.screens = { bankTxns: txns, byPath: res };
});

test('sync apply and process steps, 3,000 transactions, 100 per page', async () => {
  const TOTAL = 3000;
  const count = 100;
  const DATA = generate(TOTAL, 1);
  const bodies = new Map<number, string>();
  for (let s = 0; s < TOTAL; s += count) bodies.set(s, syncBody(DATA, s, count));
  const p = new PlaidProvider({
    clientId: 'c',
    secret: 's',
    env: 'sandbox',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      const start = body.cursor ? Number(Buffer.from(body.cursor, 'base64').toString()) : 0;
      return new Response(bodies.get(start)!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const db = freshDb();
  const d1 = db as unknown as D1Database;
  const now = Date.now();
  const ring = parseKeyring('1:' + Buffer.alloc(32, 7).toString('base64'), '1');
  const tok = await encryptToken(ring, 'access-sandbox-x', 'con1');
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1','B','2023-11',?1,?1)`,
      )
      .bind(now),
    d1
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, institution_name, access_token_enc, key_version, linked_at, created_at, updated_at)
         VALUES ('con1','b1','plaid','Sandbox',?1,1,?2,?2,?2)`,
      )
      .bind(tok.enc, now),
  ]);
  const holder = 'run1';
  await acquire(d1, 'con1', holder, now);
  const ctx = () => ({ db: d1, connectionId: 'con1', budgetId: 'b1', holder, now: Date.now() });
  await beginRun(ctx(), 'measure');
  const fetches: Run[] = [];
  let cursor: string | null = null;
  let page = 0;
  for (;;) {
    const r = await cpu(db, () => fetchPage(ctx(), p, 'access-sandbox-x', holder, 0, page, cursor, count));
    fetches.push(run(r));
    if (r.result.kind !== 'page') throw new Error('mutation');
    cursor = r.result.nextCursor;
    page++;
    if (!r.result.hasMore) break;
  }
  const applies: Run[] = [];
  db.bySql = new Map();
  // Each page is applied in 50-event chunks, one Workflow step each.
  for (let i = 0; i < page; i++)
    for (let ch = 0; ; ch++) {
      const r = await cpu(db, () => applyPage(ctx(), p, holder, i, ch));
      applies.push(run(r));
      if (r.result.pageDone) break;
    }
  const applySql = topSql(db, applies.length);
  const processes: Run[] = [];
  db.bySql = new Map();
  for (;;) {
    const r = await cpu(db, () => processPending({ DB: d1 } as never, 'b1'));
    processes.push(run(r));
    if (r.result.caughtUp) break;
  }
  const processSql = topSql(db, processes.length);
  out.sync = {
    pages: page,
    fetch: summary(fetches),
    apply: { ...summary(applies), topSql: applySql },
    process: { ...summary(processes), topSql: processSql },
  };
});

test('budget edit in the first of 36 months (recompute, 6 months per invocation)', async () => {
  const db = freshDb();
  const d1 = db as unknown as D1Database;
  const seed = seedBudget();
  const now = Date.UTC(2026, 10, 14, 20);
  const B = 'b1';
  await d1
    .prepare(
      `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES (?1, 'B', ?2, 'America/Los_Angeles', 0, 0)`,
    )
    .bind(B, seed.startMonth)
    .run();
  const chunks = <T>(xs: T[], n: number) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  for (const c of seed.categories)
    await d1
      .prepare(
        `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?4, 0, 0)`,
      )
      .bind(c.id, B, c.kind, c.card_account_id)
      .run();
  for (const ch of chunks(seed.assignments, 20))
    await d1.batch(
      ch.map((a) =>
        d1
          .prepare(
            `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, 0)`,
          )
          .bind(B, a.category_id, a.month, a.amount),
      ),
    );
  for (const ch of chunks(seed.lines, 50))
    await d1.batch(
      ch.map((l) =>
        d1
          .prepare(
            `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(B, ...l),
      ),
    );
  for (let r = await recompute(d1, B, now, { force: true }); !r.done; r = await recompute(d1, B, now));
  const edits: Run[] = [];
  const chunkRuns: Run[] = [];
  db.bySql = new Map();
  for (let i = 0; i < 6; i++) {
    const r = await cpu(db, async () => {
      await d1.batch([
        d1
          .prepare(
            `UPDATE assignment SET amount = amount + 100, updated_at = ?3 WHERE budget_id = ?1 AND category_id = 'cat00' AND month = ?2`,
          )
          .bind(B, seed.startMonth, now),
        markDirty(d1, B, seed.startMonth as never, now),
      ]);
      return recompute(d1, B, now);
    });
    edits.push(run(r));
    let last = r.result;
    while (!last.done) {
      const c = await cpu(db, () => recompute(d1, B, now));
      chunkRuns.push(run(c));
      last = c.result;
    }
  }
  out.recompute = {
    editRequest: summary(edits),
    workflowChunk: summary(chunkRuns),
    topSql: topSql(db, edits.length + chunkRuns.length),
  };
});

// Written after any subset of the tests (e.g. -t "screens"), so results are never stale.
afterAll(() => {
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/store.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
