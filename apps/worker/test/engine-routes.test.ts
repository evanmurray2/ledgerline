// Every screen route runs on the device (D-45, D-102): the engine answers the app's reads with the budget's routes,
// with only the bindings it has (local/engine.ts env()). A route that reaches for a binding only the Worker has would
// break on the device, so each GET route is called on a copy here, with made-up ids where the path takes one, and
// must answer without a server error.
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { budgetApi } from '../src/routes/api.js';
import { newCopy, seed } from './phone.js';

/** The app's GET routes that the copy answers, with each `:param` filled in. */
const reads = [
  ...new Set(
    budgetApi.routes
      .filter((r) => r.method === 'GET' && r.path.startsWith('/'))
      .map((r) => `/api${r.path}`.replace(/\/+/g, '/'))
      .filter((p) => !p.includes('*')),
  ),
];
/** Routes that need a query to answer: an older register page needs the cursor the page before gave. */
const queries: Record<string, string> = {
  '/api/accounts/:id/register/older': '?before=2026-11-01&balance=0',
};
/** Real ids from the copy, so each route runs its full path; a made-up one for anything else. */
const ids: Record<string, string> = {};
const filled = (path: string, month: string) =>
  path
    .replace(/:month\b/g, month)
    .replace(/\/categories\/:id/g, `/categories/${ids.category}`)
    .replace(/\/accounts\/:id/g, `/accounts/${ids.account}`)
    // A card refund's purchases are asked only of a card refund.
    .replace(/:key\/refund-of$/, `${encodeURIComponent(ids.refund ?? '')}/refund-of`)
    .replace(/:key\b/g, encodeURIComponent(ids.key ?? ''))
    .replace(/:[A-Za-z_]+/g, 'not-an-id');

describe('every screen route runs on the device', () => {
  let engine: LocalEngine;
  let month: string;

  beforeAll(async () => {
    engine = await seed(await newCopy());
    const s = (await (await engine.request('GET', '/api/session')).json()) as {
      budget: { id: string; currentMonth: string };
    };
    month = s.budget.currentMonth;
    const db = engine.db;
    const one = async (sql: string) => (await db.prepare(sql).first<{ v: string }>())!.v;
    ids.category = await one(`SELECT id AS v FROM category WHERE kind = 'spending' ORDER BY id LIMIT 1`);
    ids.account = await one(`SELECT id AS v FROM account ORDER BY id LIMIT 1`);
    ids.key = await one(`SELECT txn_key AS v FROM bank_txn WHERE pending = 0 ORDER BY txn_key LIMIT 1`);
    ids.refund = await one(
      `SELECT from_key AS v FROM txn_link WHERE kind = 'refund_of' AND undone_at IS NULL ORDER BY from_key LIMIT 1`,
    );
  });

  it('finds the routes', () => {
    expect(reads.length).toBeGreaterThan(10);
    expect(reads).toContain('/api/activity');
  });

  it.each(reads.map((p) => [p]))('%s', async (path) => {
    const url = filled(path, month) + (queries[path] ?? '');
    const r = await engine.request('GET', url);
    const text = await r.text();
    expect(r.status, `${path}: ${text}`).toBeLessThan(500);
    // With real ids, each route answers its screen, not "not found".
    if (!url.includes('not-an-id')) expect(r.status, `${path}: ${text}`).toBe(200);
  });
});
