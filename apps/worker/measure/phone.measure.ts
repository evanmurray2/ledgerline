// The server's side of the phone copy (D-45): CPU of GET /api/sync pages on a 3,000-transaction budget, for the full
// download and for change pages. Writes .measure/phone.json for docs/measurements.md. Node CPU, SQLite included, as a
// Durable Object pays it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { Hono } from 'hono';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { encryptToken, parseKeyring } from '@ledgerline/platform';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { syncRoutes, SYNC_PAGE_ROWS, type SyncPage } from '../src/routes/sync.js';
import type { AppEnv } from '../src/http/context.js';
import { cpu, freshDb, stats } from './harness.js';

const TOTAL = 3000;
const DATA = generate(TOTAL, 1);

function provider(count: number): PlaidProvider {
  const bodies = new Map<number, string>();
  for (let s = 0; s < TOTAL; s += count) bodies.set(s, syncBody(DATA, s, count));
  return new PlaidProvider({
    clientId: 'c',
    secret: 's',
    env: 'sandbox',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string; count: number };
      const start = body.cursor ? Number(Buffer.from(body.cursor, 'base64').toString()) : 0;
      return new Response(bodies.get(start)!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('sync pages CPU', async () => {
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
  await acquire(d1, 'con1', 'run1', now);
  const ctx = () => ({ db: d1, connectionId: 'con1', budgetId: 'b1', holder: 'run1', now: Date.now() });
  await beginRun(ctx(), 'measure');
  const p = provider(500);
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const r = await fetchPage(ctx(), p, 'access-sandbox-x', 'run1', 0, pages, cursor, 500);
    if (r.kind !== 'page') throw new Error('mutation');
    cursor = r.nextCursor;
    pages++;
    if (!r.hasMore) break;
  }
  for (let i = 0; i < pages; i++)
    for (let ch = 0; ; ch++) if ((await applyPage(ctx(), p, 'run1', i, ch)).pageDone) break;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('budgetId', 'b1');
    c.set('userId', 'u');
    c.set('syncEpoch', 'e0');
    return next();
  });
  app.route('/api', syncRoutes);
  const get = async (q: string) =>
    (await app.request(`/api/sync?${q}`, {}, { DB: d1, PLAID_ENV: 'sandbox' })).json() as Promise<SyncPage>;

  const out: Record<string, unknown> = { pageRows: SYNC_PAGE_ROWS };
  const full: number[] = [];
  let c: string | null = null;
  let through = 0;
  let rows = 0;
  for (;;) {
    const r = await cpu(db, () => get(`since=0${c ? `&cursor=${encodeURIComponent(c)}` : ''}`));
    full.push(r.ms);
    rows += r.result.rows.length;
    through = r.result.through;
    if (!r.result.cursor) break;
    c = r.result.cursor;
  }
  out.fullDownload = { requests: full.length, rows, ms: stats(full) };
  // 600 transactions changed (categorized, say), then change pages.
  await d1
    .prepare(
      `UPDATE bank_txn SET updated_at = updated_at + 1 WHERE provider_txn_id IN (SELECT provider_txn_id FROM bank_txn LIMIT 600)`,
    )
    .run();
  const changes: number[] = [];
  let since = through;
  for (;;) {
    const r = await cpu(db, () => get(`since=${since}`));
    changes.push(r.ms);
    since = r.result.through;
    if (!r.result.more) break;
  }
  out.changePages = { requests: changes.length, ms: stats(changes) };
  const idle: number[] = [];
  for (let i = 0; i < 20; i++) idle.push((await cpu(db, () => get(`since=${since}`))).ms);
  out.nothingNew = { ms: stats(idle) };
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/phone.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
