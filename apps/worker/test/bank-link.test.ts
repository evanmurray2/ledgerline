// bank_link (docs/privacy.md 5.5, section 8 step 4): the server's own list of a budget's bank links, with a copy of
// each token. It was first copied from `connection`; the old tables are dropped since (D-105), and the links stay.
import type { Db } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurableDb } from '../src/store/adapter.js';
import { budgetInfo } from '../src/store/account-life.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { migrate } from '../src/store/migrate.js';
import { BUDGET_MIGRATIONS, BUDGET_STORE_MIGRATIONS, STORE_MIGRATIONS } from '../src/store/migrations.gen.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
let n = 0;
const fresh = () => e.BUDGET.get(e.BUDGET.idFromName(`bank-link-${++n}-${Math.random()}`));
const links = async (db: Db) =>
  (
    await db
      .prepare(
        `SELECT id, connection_id, provider, provider_item_id, access_token_enc, key_version, mac, check_result FROM bank_link ORDER BY id`,
      )
      .all<Record<string, unknown>>()
  ).results;
const connect = (db: Db, id: string, o: { provider?: string; removed?: number | null } = {}) =>
  db
    .prepare(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, linked_at, removed_at, created_at, updated_at)
       VALUES (?1, 'b1', ?2, ?3, 'Bank', ?4, 1, 5, ?5, 6, 6)`,
    )
    .bind(id, o.provider ?? 'plaid', `item-${id}`, `enc-${id}`, o.removed ?? null)
    .run();
const budget = (db: Db) =>
  db
    .prepare(
      `INSERT INTO budget (id, name, processed_through, created_at, updated_at) VALUES ('b1', 'B', 0, 0, 0)`,
    )
    .run();

/** A store's tables after the drop (D-105). */
const KEPT = [
  'bank_link',
  'budget',
  'job',
  'key_stamp',
  'lease_guard',
  'link_cursor',
  'log_entry',
  'log_state',
  'run_stage',
  'run_state',
  'sealed_page',
  'sealed_run',
  'snapshot',
  'snapshot_chunk',
  'store_mark',
  'store_note',
];

describe('bank_link', () => {
  it('dropping the old tables (store migration 0010) keeps every bank link, the jobs and the log', async () => {
    await runInDurableObject(fresh(), async (_obj, state) => {
      // A store as the owner's was before the drop: its budget tables, links copied from `connection` by the
      // triggers, a queued purge, its notes, and a sealed mark.
      await state.storage.deleteAll();
      const at = BUDGET_STORE_MIGRATIONS.findIndex((m) => m.name === 'store/0010_drop_old_tables.sql');
      migrate(state.storage, BUDGET_STORE_MIGRATIONS.slice(0, at), 1);
      const db = new DurableDb(state.storage);
      await budget(db);
      await connect(db, 'con_01HZZZZZZZZZZZZZZZZZZZZZZZ');
      await connect(db, 'con_01HYYYYYYYYYYYYYYYYYYYYYYY');
      await connect(db, 'con_GONE', { removed: 9 });
      await db.batch([
        db.prepare(`UPDATE bank_link SET mac = 'stamp', check_result = 'ok'`),
        db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`),
        db.prepare(
          `INSERT INTO store_note (key, value) VALUES ('cutover_at', 1), ('purge_rows', 40), ('opened_at', 2)`,
        ),
        db.prepare(
          `INSERT INTO job (id, kind, state, run_at, created_at, updated_at) VALUES
             ('purge_old', 'purge_old', '{}', 1, 1, 1), ('stamp_links', 'stamp_links', '{}', 1, 1, 1),
             ('sealed_backstop', 'sealed_backstop', '{}', 1, 1, 1)`,
        ),
      ]);
      const before = await links(db);
      expect(before).toHaveLength(2);

      expect(migrate(state.storage, BUDGET_STORE_MIGRATIONS, 2).applied).toEqual([
        'store/0010_drop_old_tables.sql',
      ]);
      // Every link as it was: the drop of `connection` deleted none of them.
      expect(await links(db)).toEqual(before);
      expect(budgetInfo(state.storage).banks).toBe(2);
      const names = async (type: string) =>
        (
          await db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type = ?1 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
                 AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`,
            )
            .bind(type)
            .all<{ name: string }>()
        ).results.map((r) => r.name);
      expect(await names('table')).toEqual(KEPT);
      expect(await names('view')).toEqual([]);
      expect(await names('trigger')).toEqual([]);
      // The budget row says only which budget this is.
      expect((await db.prepare(`SELECT * FROM budget`).all()).results).toEqual([
        { id: 'b1', name: '', created_at: 0, updated_at: 0 },
      ]);
      expect((await db.prepare(`SELECT id FROM job ORDER BY id`).all()).results).toEqual([
        { id: 'sealed_backstop' },
      ]);
      expect((await db.prepare(`SELECT key FROM store_note ORDER BY key`).all()).results).toEqual([
        { key: 'cutover_at' },
        { key: 'opened_at' },
      ]);
    });
  });

  it('a new store ends with the same tables, and starts a budget', async () => {
    await runInDurableObject(fresh(), async (_obj, state) => {
      const db = new DurableDb(state.storage);
      const tables = (
        await db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
               AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name`,
          )
          .all<{ name: string }>()
      ).results.map((r) => r.name);
      expect(tables).toEqual(KEPT);
      await db
        .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES ('b2', 'My budget', 1, 1)`)
        .run();
      expect(budgetInfo(state.storage)).toMatchObject({ name: 'My budget', banks: 0, sealed: false });
    });
  });

  it('the migration copies the links a budget already has', async () => {
    await runInDurableObject(fresh(), async (_obj, state) => {
      // A store as it was before bank_link: the budget's tables and the marks, with two live links and one removed.
      await state.storage.deleteAll();
      const at = STORE_MIGRATIONS.findIndex((m) => m.name.includes('bank_link'));
      const before = STORE_MIGRATIONS.slice(0, at);
      migrate(state.storage, [...BUDGET_MIGRATIONS, ...before], 1);
      const db = new DurableDb(state.storage);
      await budget(db);
      await connect(db, 'con_01HAAAAAAAAAAAAAAAAAAAAAAA');
      await connect(db, 'con_01HBBBBBBBBBBBBBBBBBBBBBBB');
      await connect(db, 'con_01HCCCCCCCCCCCCCCCCCCCCCCC', { removed: 3 });
      expect(
        migrate(state.storage, [...BUDGET_MIGRATIONS, ...STORE_MIGRATIONS.slice(0, at + 1)], 2).applied,
      ).toEqual(['store/0002_bank_link.sql']);
      expect((await links(db)).map((l) => [l.id, l.connection_id, l.access_token_enc, l.mac])).toEqual([
        [
          '01HAAAAAAAAAAAAAAAAAAAAAAA',
          'con_01HAAAAAAAAAAAAAAAAAAAAAAA',
          'enc-con_01HAAAAAAAAAAAAAAAAAAAAAAA',
          null,
        ],
        [
          '01HBBBBBBBBBBBBBBBBBBBBBBB',
          'con_01HBBBBBBBBBBBBBBBBBBBBBBB',
          'enc-con_01HBBBBBBBBBBBBBBBBBBBBBBB',
          null,
        ],
      ]);
    });
  });
});
