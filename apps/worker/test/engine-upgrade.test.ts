// A copy an older app version left on the device, opened by this version (docs/phone-budget.md, D-45). The copy
// runs the budget migrations itself (migrateLocal), against rows it took at the older schema, and then reads on from
// where it was. For each recent migration, a copy built and filled at the schema before it is upgraded and must show
// exactly the screens of a new device that takes every row. When a migration can't give an old copy what a new one
// has (it backfills from rows a copy doesn't keep, say), this fails: bump SYNC_FORMAT or DERIVE_VERSION, so old
// copies work everything out again.
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';
import { SYNC_FORMAT, SYNC_TABLES, type SyncPage, type SyncRow } from '../src/sync-tables.js';
import { newCopy, seed } from './phone.js';
import { storeDb } from './store-db.js';

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

/** Every row of the November copy, as one page a new device takes. */
async function download(): Promise<SyncPage[]> {
  const src = await seed(await newCopy());
  const rows: SyncRow[] = [];
  for (const t of SYNC_TABLES)
    for (const r of (await src.db.prepare(`SELECT * FROM ${t.name}`).all<Record<string, unknown>>()).results)
      rows.push({
        t: t.name,
        k: t.pk.map((c) => r[c]),
        d: Object.fromEntries(Object.entries(r).filter(([c]) => !t.omit?.includes(c))),
      });
  return [
    {
      format: SYNC_FORMAT,
      epoch: 'log',
      serverTime: Date.now(),
      through: 1,
      more: false,
      cursor: null,
      rows,
    },
  ];
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
    pages = await download();
    budgetId = String(pages[0]!.rows.find((r) => r.t === 'budget')!.d!.id);
    const db = storeDb(`upgrade-ref-${++copies}`);
    await migrateLocal(db, Date.now());
    const e = new LocalEngine(db, who(budgetId));
    for (const p of pages) await e.apply(p);
    await e.derive();
    const s = (await (await e.request('GET', '/api/session')).json()) as { budget: { currentMonth: string } };
    month = s.budget.currentMonth;
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
        rows.push(
          r.d ? { ...r, d: Object.fromEntries(Object.entries(r.d).filter(([k]) => cols.has(k))) } : r,
        );
      }
      await old.apply({ ...p, rows });
    }
    await old.derive();
    // This version opens it: the rest of the migrations, then a read on from where it was (nothing new).
    await migrateLocal(db, Date.now());
    const e = new LocalEngine(db, who(budgetId));
    const st = await e.state();
    await e.apply({ ...pages[0]!, through: st.through, rows: [] });
    if (await e.needsDerive()) await e.derive();
    const got = await screens(e, month);
    for (const path of SCREENS(month)) expect(got[path], `${path} after ${name}`).toEqual(reference[path]);
  });
});
