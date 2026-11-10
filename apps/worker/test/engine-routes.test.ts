// Every screen route runs on the phone too (D-45): the engine answers the app's reads with the server's own routes,
// with only the bindings it has (local/engine.ts env()). A route that reaches for a binding only the server has would
// break on the phone alone, so each GET route the app reads from the copy is called on a synced copy here, with
// made-up ids where the path takes one, and must answer without a server error.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { budgetApi, SERVER_READS } from '../src/routes/api.js';
import { storeDb } from './store-db.js';
import { syncPhone } from './phone.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const api = async (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);

/** The app's GET routes that the copy answers, with each `:param` filled in. */
const reads = [
  ...new Set(
    budgetApi.routes
      .filter((r) => r.method === 'GET' && r.path.startsWith('/'))
      .map((r) => `/api${r.path}`.replace(/\/+/g, '/'))
      .filter((p) => !p.includes('*'))
      .filter((p) => !SERVER_READS.some((re) => re.test(p.replace(/:[^/]+/g, 'x'))))
      // Settings → Sign-in: the Directory answers it (store/router.ts), never the copy.
      .filter((p) => !p.startsWith('/api/settings/security')),
  ),
];
/** Real ids from the copy, so each route runs its full path; a made-up one for anything else. */
const ids: Record<string, string> = {};
const filled = (path: string, month: string) =>
  path
    .replace(/:month\b/g, month)
    .replace(/\/categories\/:id/g, `/categories/${ids.category}`)
    .replace(/\/accounts\/:id/g, `/accounts/${ids.account}`)
    .replace(/:key\b/g, encodeURIComponent(ids.key ?? ''))
    .replace(/:[A-Za-z_]+/g, 'not-an-id');

describe('every screen route runs on the phone', () => {
  let engine: LocalEngine;
  let month: string;

  beforeAll(async () => {
    expect((await api('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    const s = (await (await api('/api/session')).json()) as {
      budget: { id: string; currentMonth: string };
    };
    month = s.budget.currentMonth;
    const db = storeDb('engine-routes');
    await migrateLocal(db, Date.now());
    engine = await syncPhone(
      new LocalEngine(db, { budgetId: s.budget.id, userId: 'phone', email: 'owner@example.com' }),
    );
    const one = async (sql: string) => (await db.prepare(sql).first<{ v: string }>())!.v;
    ids.category = await one(`SELECT id AS v FROM category WHERE kind = 'spending' ORDER BY id LIMIT 1`);
    ids.account = await one(`SELECT id AS v FROM account ORDER BY id LIMIT 1`);
    ids.key = await one(`SELECT txn_key AS v FROM bank_txn WHERE pending = 0 ORDER BY txn_key LIMIT 1`);
  });

  it('finds the routes', () => {
    expect(reads.length).toBeGreaterThan(10);
    expect(reads).toContain('/api/activity');
  });

  it.each(reads.map((p) => [p]))('%s', async (path) => {
    const url = filled(path, month);
    const r = await engine.request('GET', url);
    const text = await r.text();
    expect(r.status, `${path}: ${text}`).toBeLessThan(500);
    // With real ids, each route answers its screen, not "not found".
    if (!url.includes('not-an-id')) expect(r.status, `${path}: ${text}`).toBe(200);
  });
});
