// bank_link (docs/privacy.md 5.5, section 8 step 4): the server's own list of a budget's bank links, with a copy of
// each token. Until the cutover it follows `connection` by itself, whatever code writes there.
import type { Db } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurableDb } from '../src/store/adapter.js';
import { budgetInfo } from '../src/store/account-life.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { migrate } from '../src/store/migrate.js';
import { BUDGET_MIGRATIONS, STORE_MIGRATIONS } from '../src/store/migrations.gen.js';

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

describe('bank_link', () => {
  it('follows connection: a link made, its token changed, removed, put back, deleted', async () => {
    await runInDurableObject(fresh(), async (_obj, state) => {
      const db = new DurableDb(state.storage);
      await budget(db);
      await connect(db, 'con_01HZZZZZZZZZZZZZZZZZZZZZZZ');
      await connect(db, 'old-style-id', { provider: 'fake' });
      await connect(db, 'con_GONE', { removed: 9 });
      expect(await links(db)).toEqual([
        {
          id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
          connection_id: 'con_01HZZZZZZZZZZZZZZZZZZZZZZZ',
          provider: 'plaid',
          provider_item_id: 'item-con_01HZZZZZZZZZZZZZZZZZZZZZZZ',
          access_token_enc: 'enc-con_01HZZZZZZZZZZZZZZZZZZZZZZZ',
          key_version: 1,
          mac: null,
          check_result: null,
        },
        expect.objectContaining({ id: 'old-style-id', connection_id: 'old-style-id', provider: 'fake' }),
      ]);
      // The bank count the wipe check and delete account read.
      expect(budgetInfo(state.storage).banks).toBe(1);

      // A stamped and checked link whose token changes loses both: they were for the old token.
      await db.prepare(`UPDATE bank_link SET mac = 'stamp', checked_at = 1, check_result = 'ok'`).run();
      await db
        .prepare(`UPDATE connection SET status = 'login_required', updated_at = 7 WHERE id = 'old-style-id'`)
        .run();
      expect((await links(db))[1]!.mac).toBe('stamp');
      await db
        .prepare(
          `UPDATE connection SET access_token_enc = 'enc-new', key_version = 2 WHERE id = 'old-style-id'`,
        )
        .run();
      expect((await links(db))[1]).toMatchObject({
        access_token_enc: 'enc-new',
        key_version: 2,
        mac: null,
        check_result: null,
      });
      expect((await links(db))[0]!.mac).toBe('stamp');

      await db.prepare(`UPDATE connection SET removed_at = 8 WHERE id = 'old-style-id'`).run();
      expect((await links(db)).map((l) => l.id)).toEqual(['01HZZZZZZZZZZZZZZZZZZZZZZZ']);
      await db.prepare(`UPDATE connection SET removed_at = NULL WHERE id = 'old-style-id'`).run();
      expect((await links(db)).length).toBe(2);
      await db.prepare(`DELETE FROM connection WHERE id = 'con_01HZZZZZZZZZZZZZZZZZZZZZZZ'`).run();
      expect((await links(db)).map((l) => l.id)).toEqual(['old-style-id']);
      expect(budgetInfo(state.storage).banks).toBe(0);
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
