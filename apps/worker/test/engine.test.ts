// The phone's local engine (D-44, src/local/engine.ts): a copy downloaded through /api/sync and worked out on the
// phone shows exactly the screens the server shows for the same data, before and after changes. The "server" here
// runs the same derived code (LOCAL_ENGINE in the test config), so its answers are the reference.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import type { SyncPage } from '../src/routes/sync.js';
import { derived } from '../src/budget/derived.js';
import { storeDb } from './store-db.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const api = async (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);
const json = async (path: string) => {
  const r = await api(path);
  expect(r.status, path).toBe(200);
  return r.json();
};
const post = async (path: string, body: unknown, method = 'POST') => {
  const r = await api(path, { method, headers: H, body: JSON.stringify(body) });
  expect(r.status, `${method} ${path}`).toBeLessThan(300);
  return r.json();
};

async function syncAll(engine: LocalEngine): Promise<number> {
  let pages = 0;
  for (;;) {
    const { since, cursor } = await engine.nextRequest();
    const q = new URLSearchParams({ since: String(since), limit: '50' });
    if (cursor) q.set('cursor', cursor);
    const page = (await json(`/api/sync?${q}`)) as SyncPage;
    const r = await engine.apply(page);
    pages++;
    if (r.caughtUp) return pages;
    if (pages > 500) throw new Error('sync did not finish');
  }
}

const SCREENS = (m: string) => [
  `/api/budget/${m}`,
  `/api/budget/${m}/assign`,
  '/api/activity',
  '/api/activity?filter=attention',
  '/api/activity?filter=pending',
  '/api/accounts',
  `/api/reports?month=${m}`,
  '/api/owed',
  '/api/settings/categories',
  '/api/settings/rules',
  '/api/settings/payees',
];

async function phoneJson(engine: LocalEngine, path: string) {
  const r = await engine.request('GET', path);
  expect(r.status, `phone ${path}`).toBe(200);
  return r.json();
}

describe('the phone works out the same screens as the server', () => {
  let engine: LocalEngine;
  let month: string;

  beforeAll(async () => {
    derived.enabled = true;
    const seed = await api('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(seed.status).toBe(200);
    const session = (await json('/api/session')) as { budget: { id: string; currentMonth: string } };
    month = session.budget.currentMonth;
    const db = storeDb('phone-copy');
    await migrateLocal(db, Date.now());
    engine = new LocalEngine(db, {
      budgetId: session.budget.id,
      userId: 'phone',
      email: 'owner@example.com',
    });
  });

  it('after a full download', async () => {
    const pages = await syncAll(engine);
    expect(pages).toBeGreaterThan(1);
    await engine.derive();
    for (const path of SCREENS(month)) expect(await phoneJson(engine, path), path).toEqual(await json(path));
  });

  it('after changes on the server, from the change log alone', async () => {
    const cats = (await json('/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const spending = cats.groups.flatMap((g) => g.categories).filter((c) => c.kind === 'spending');
    await post('/api/budget/assign', { month, items: [{ categoryId: spending[0]!.id, amount: 1234 }] });
    const act = (await json('/api/activity')) as { posted: { key: string; amount: number }[] };
    const out = act.posted.find((r) => r.amount < 0)!;
    await post(
      `/api/transactions/${encodeURIComponent(out.key)}`,
      { categoryId: spending[1]!.id, memo: 'phone test' },
      'PATCH',
    );
    const before = (await engine.state()).through;
    await syncAll(engine);
    expect((await engine.state()).through).toBeGreaterThan(before);
    await engine.derive();
    for (const path of SCREENS(month)) expect(await phoneJson(engine, path), path).toEqual(await json(path));
  });

  it('a new epoch throws the copy away', async () => {
    const st = await engine.state();
    const r = await engine.apply({
      format: st.format,
      epoch: 'e-restored',
      serverTime: Date.now(),
      through: 1,
      more: false,
      cursor: null,
      rows: [],
    });
    expect(r.reset).toBe(true);
    expect(await engine.nextRequest()).toEqual({ since: 0, cursor: null });
  });
});

describe('the server keeps nothing derived (D-44)', () => {
  it('answers changes without Ready to Assign, refuses screens, and logs every change', async () => {
    const session = (await json('/api/session')) as { budget: { currentMonth: string } };
    const m = session.budget.currentMonth;
    const cats = (await json('/api/settings/categories')) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    const cat = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!;
    const through = ((await json('/api/sync?since=0&limit=500')) as SyncPage).through;
    derived.enabled = false;
    try {
      const ack = await post('/api/budget/set', { month: m, categoryId: cat.id, assigned: 4321 });
      expect(ack).toEqual({ ok: true });
      const screen = await api(`/api/budget/${m}`);
      expect(screen.status).toBe(404);
      expect(((await screen.json()) as { error: string }).error).toBe('on_device');
      const page = (await json(`/api/sync?since=${through}`)) as SyncPage;
      const a = page.rows.find((r) => r.t === 'assignment' && r.k[2] === cat.id && r.k[1] === m);
      expect(a?.d).toMatchObject({ amount: 4321 });
    } finally {
      derived.enabled = true;
    }
  });

  it('every synced table has its change-log triggers', async () => {
    const { SYNC_TABLES, triggerNames } = await import('../src/sync-tables.js');
    const db = storeDb('trigger-check');
    const have = new Set(
      (
        await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all<{ name: string }>()
      ).results.map((r) => r.name),
    );
    for (const t of SYNC_TABLES) for (const n of triggerNames(t.name)) expect(have.has(n), n).toBe(true);
  });
});
