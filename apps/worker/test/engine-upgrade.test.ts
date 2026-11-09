// A copy an older app version left on the phone, opened by this version (docs/phone-budget.md, D-45). The copy runs
// the server's budget migrations itself (migrateLocal), against data it synced at the older schema, and then syncs
// on from where it was. For each recent migration, a copy built and filled at the schema before it is upgraded and
// must show exactly the screens of a new phone that downloads everything. When a migration can't give the copy what
// the server has (it backfills from rows the phone doesn't keep, say), this fails: bump SYNC_FORMAT, so old copies
// download again, or DERIVE_VERSION, so they work everything out again.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import type { SyncPage } from '../src/routes/sync.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';
import { storeDb } from './store-db.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const api = async (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);
const json = async (path: string) => {
  const r = await api(path);
  expect(r.status, path).toBe(200);
  return r.json();
};

/** How many of the latest migrations to check: each is one older copy. */
const RECENT = 4;

const SCREENS = (m: string) => [
  `/api/budget/${m}`,
  `/api/budget/${m}/assign`,
  '/api/activity',
  '/api/activity?filter=attention',
  '/api/accounts',
  `/api/reports?month=${m}`,
  '/api/owed',
  '/api/settings/categories',
  '/api/settings/payees',
];

/** Every sync page from the start, as a new phone downloads them. */
async function download(): Promise<SyncPage[]> {
  const pages: SyncPage[] = [];
  let cursor: string | null = null;
  for (;;) {
    const q = new URLSearchParams({ since: '0', limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const page = (await json(`/api/sync?${q}`)) as SyncPage;
    pages.push(page);
    cursor = page.cursor;
    if (!page.cursor && !page.more) return pages;
    if (pages.length > 500) throw new Error('sync did not finish');
  }
}

async function screens(e: LocalEngine, month: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const path of SCREENS(month)) {
    const r = await e.request('GET', path);
    expect(r.status, path).toBe(200);
    out[path] = await r.json();
  }
  return out;
}

let copies = 0;
const who = (budgetId: string) => ({ budgetId, userId: 'phone', email: 'owner@example.com' });

describe('a copy left by an older app version upgrades to the screens a new phone shows', () => {
  let month: string;
  let budgetId: string;
  let pages: SyncPage[];
  let reference: Record<string, unknown>;

  beforeAll(async () => {
    const seed = await api('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(seed.status).toBe(200);
    const s = (await json('/api/session')) as { budget: { id: string; currentMonth: string } };
    month = s.budget.currentMonth;
    budgetId = s.budget.id;
    pages = await download();
    const db = storeDb(`upgrade-ref-${++copies}`);
    await migrateLocal(db, Date.now());
    const e = new LocalEngine(db, who(budgetId));
    for (const p of pages) await e.apply(p);
    await e.derive();
    reference = await screens(e, month);
  });

  const recent = BUDGET_MIGRATIONS.slice(-RECENT);
  it.each(recent.map((m) => [m.name]))('from the schema before %s', async (name) => {
    const before = BUDGET_MIGRATIONS.slice(
      0,
      BUDGET_MIGRATIONS.findIndex((m) => m.name === name),
    );
    const db = storeDb(`upgrade-${++copies}`);
    await migrateLocal(db, Date.now(), before);
    // What the older copy held: the same rows, with only the columns its tables had then.
    const columns = new Map<string, Set<string>>();
    const has = async (t: string) => {
      let c = columns.get(t);
      if (!c) {
        const r = await db.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(t).all<{ name: string }>();
        c = new Set(r.results.map((x) => x.name));
        columns.set(t, c);
      }
      return c;
    };
    const old = new LocalEngine(db, who(budgetId));
    for (const p of pages) {
      const rows = [];
      for (const r of p.rows) {
        const cols = await has(r.t);
        if (cols.size === 0) continue; // a table the older copy didn't have
        rows.push(r.d ? { ...r, d: Object.fromEntries(Object.entries(r.d).filter(([k]) => cols.has(k))) } : r);
      }
      await old.apply({ ...p, rows });
    }
    await old.derive();
    // This version opens it: the rest of the migrations, then a sync from where it was, as the app does.
    await migrateLocal(db, Date.now());
    const e = new LocalEngine(db, who(budgetId));
    const { since } = await e.nextRequest();
    const page = (await json(`/api/sync?since=${since}&limit=200`)) as SyncPage;
    await e.apply(page);
    if (await e.needsDerive()) await e.derive();
    const got = await screens(e, month);
    for (const path of SCREENS(month)) expect(got[path], `${path} after ${name}`).toEqual(reference[path]);
  });
});
