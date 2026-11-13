// A copy an older app version left on the device, opened by this version (docs/phone-budget.md, D-45). The copy
// runs the budget migrations itself (migrateLocal), against rows it took at the older schema, and then reads on from
// where it was. For each recent migration, a copy built and filled at the schema before it is upgraded and must show
// exactly the screens of a new device that takes every row. When a migration can't give an old copy what a new one
// has (it backfills from rows a copy doesn't keep, say), this fails: bump SYNC_FORMAT or DERIVE_VERSION, so old
// copies work everything out again.
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalEngine, migrateLocal, PHONE_TABLES } from '../src/local/engine.js';
import { splitStatements } from '../src/store/adapter.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';
import { SYNC_FORMAT, SYNC_TABLES, triggerNames, type SyncPage, type SyncRow } from '../src/sync-tables.js';
import { newCopy, seed } from './phone.js';
import type { Db } from '@ledgerline/db/sql';
import { copyDb } from './store-db.js';

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

/**
 * The schema an older app version left on the device: the older budget migrations (less the one a copy skips), the
 * tables only a copy keeps, and no change-log triggers. Not this version's `migrateLocal`, which also makes the
 * recording triggers of every table this version knows, the newer ones too.
 */
async function olderSchema(db: Db, migrations: readonly { name: string; sql: string }[]): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    .run();
  for (const m of migrations) {
    if (m.name === '0006_drop_phone_tables_on_server.sql') continue;
    await db.batch([
      ...splitStatements(m.sql).map((s) => db.prepare(s)),
      db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)`).bind(m.name, Date.now()),
    ]);
  }
  await db.batch([
    ...SYNC_TABLES.flatMap((t) => triggerNames(t.name)).map((n) => db.prepare(`DROP TRIGGER IF EXISTS ${n}`)),
    ...PHONE_TABLES.map((sql) => db.prepare(sql)),
    db.prepare(`CREATE TABLE IF NOT EXISTS local_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
  ]);
}

let copies = 0;
const who = (budgetId: string) => ({ budgetId, userId: 'phone', email: 'owner@example.com' });

describe('a copy left by an older app version upgrades to the screens a new phone shows', () => {
  let month: string;
  let budgetId: string;
  let pages: SyncPage[];
  let reference: Record<string, unknown>;
  /** The new device's copy: the rows an older copy holds are taken from it. */
  let ref: Db;

  beforeAll(async () => {
    pages = await download();
    budgetId = String(pages[0]!.rows.find((r) => r.t === 'budget')!.d!.id);
    ref = copyDb(`upgrade-ref-${++copies}`);
    await migrateLocal(ref, Date.now());
    const e = new LocalEngine(ref, who(budgetId));
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
    // An empty SQLite with only the older migrations, as the older app left it: its tables have only the columns
    // they had then, and no later migration has run on it.
    const db = copyDb(`upgrade-${++copies}`);
    await olderSchema(db, before);
    // Filled with rows, as plain inserts: every row a copy keeps (the synced tables, what it worked out, and its
    // place in the sync), with only the columns the older tables have. This version's engine never writes to it
    // before the upgrade, so it can't write a table or column the older copy didn't have.
    const tables = (
      await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT IN ('_migrations', 'edit_change')`,
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toContain('local_state');
    for (const t of tables) {
      const cols = (
        await db.prepare(`SELECT name FROM pragma_table_info(?1)`).bind(t).all<{ name: string }>()
      ).results.map((x) => x.name);
      const rows = (await ref.prepare(`SELECT * FROM ${t}`).all<Record<string, unknown>>()).results;
      const insert = `INSERT OR REPLACE INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
        .map((_, i) => `?${i + 1}`)
        .join(', ')})`;
      for (let i = 0; i < rows.length; i += 200)
        await db.batch([
          db.prepare(`PRAGMA defer_foreign_keys = ON`),
          ...rows.slice(i, i + 200).map((r) => db.prepare(insert).bind(...cols.map((c) => r[c] ?? null))),
        ]);
    }
    // Nothing the later migrations make is there yet.
    const later = BUDGET_MIGRATIONS.slice(before.length).map((m) => m.name);
    const done = (await db.prepare(`SELECT name FROM _migrations`).all<{ name: string }>()).results.map(
      (r) => r.name,
    );
    expect(done.filter((n) => later.includes(n) && n !== '0006_drop_phone_tables_on_server.sql')).toEqual([]);
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
