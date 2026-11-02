// Phase 1 of docs/multi-user.md: the Durable Objects migrate themselves, and the D1-shaped adapter behaves like D1
// in everything the sync leases and fences rely on (changes === 1, a failed fence rolling back the whole batch,
// RETURNING rows, bind coercion, D1 error wording).
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SqlD1 } from '../src/store/adapter.js';
import { migrate } from '../src/store/migrate.js';
import { BUDGET_MIGRATIONS } from '../src/store/migrations.gen.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import type { Directory } from '../src/store/directory.js';
import { acquire, isFenceAbort, leaseFence, renew } from '../src/sync/lease.js';

const e = env as unknown as {
  BUDGET: DurableObjectNamespace<BudgetStore>;
  DIRECTORY: DurableObjectNamespace<Directory>;
};
const NOW = 1_800_000_000_000;
let n = 0;
const budget = () => e.BUDGET.get(e.BUDGET.idFromName(`t-${++n}-${Math.random()}`));

async function inStore<T>(fn: (db: D1Database, storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(budget(), async (_obj, state) =>
    fn(new SqlD1(state.storage) as unknown as D1Database, state.storage),
  );
}

async function seed(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO budget (id, name, processed_through, created_at, updated_at) VALUES ('b1', 'B', 10, 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
       VALUES ('c1', 'b1', 'fake', 'Bank', 0, 0, 0)`,
    ),
  ]);
}

describe('object migrations', () => {
  it('a budget store and the directory create their schemas at start', async () => {
    const h = await budget().health();
    expect(h).toMatchObject({ ok: true, kind: 'budget', migrations: ['0001_baseline.sql', '0002_jobs.sql'] });
    expect(h.tables).toBe(38);
    const d = await e.DIRECTORY.get(e.DIRECTORY.idFromName('directory-test')).health();
    expect(d).toMatchObject({
      ok: true,
      kind: 'directory',
      migrations: ['0001_baseline.sql', '0002_jobs.sql', '0003_users.sql'],
      tables: 15,
    });
  });

  it('running the migrations again does nothing', async () => {
    await inStore(async (_db, storage) => {
      expect(migrate(storage, BUDGET_MIGRATIONS, NOW).applied).toEqual([]);
    });
  });
});

describe('D1-shaped adapter', () => {
  it('reports changes === 1 only for the holder, as the leases need', async () => {
    await inStore(async (db) => {
      await seed(db);
      expect(await acquire(db, 'c1', 'run-a', NOW)).toBe(true);
      expect(await acquire(db, 'c1', 'run-b', NOW)).toBe(false);
      expect(await renew(db, 'c1', 'run-a', NOW + 1000)).toBe(true);
      expect(await renew(db, 'c1', 'run-b', NOW + 1000)).toBe(false);
    });
  });

  it('rolls back the whole batch when a fence fails, with an error isFenceAbort recognizes', async () => {
    await inStore(async (db) => {
      await seed(db);
      await acquire(db, 'c1', 'run-a', NOW);
      const err = await db
        .batch([
          leaseFence(db, 'c1', 'run-b', NOW),
          db.prepare(
            `INSERT INTO setting (budget_id, key, value, updated_at) VALUES ('b1', 'probe', '1', 0)`,
          ),
        ])
        .catch((x: unknown) => x);
      expect(isFenceAbort(err)).toBe(true);
      expect(await db.prepare(`SELECT count(*) AS n FROM setting`).first('n')).toBe(0);
      await db.batch([
        leaseFence(db, 'c1', 'run-a', NOW),
        db.prepare(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES ('b1', 'probe', '1', 0)`),
      ]);
      expect(await db.prepare(`SELECT count(*) AS n FROM setting`).first('n')).toBe(1);
    });
  });

  it('returns RETURNING rows, last_row_id and D1-style meta', async () => {
    await inStore(async (db) => {
      await seed(db);
      const [ins] = await db.batch([
        db
          .prepare(
            `INSERT INTO usage_event (budget_id, at, session_id, app_version, screen, event) VALUES ('b1', 0, 's', 'v', ?1, 'open') RETURNING id, screen`,
          )
          .bind('budget'),
      ]);
      expect(ins!.results).toEqual([{ id: expect.any(Number), screen: 'budget' }]);
      const plain = await db
        .prepare(
          `INSERT INTO usage_event (budget_id, at, session_id, app_version, screen, event) VALUES ('b1', 0, 's', 'v', 'x', 'open')`,
        )
        .run();
      expect(plain.meta.last_row_id).toBe((ins!.results[0] as { id: number }).id + 1);
      const r = await db.prepare(`UPDATE budget SET rta = 5 WHERE id = 'b1'`).run();
      expect(r.meta.changes).toBe(1);
      const none = await db.prepare(`UPDATE budget SET rta = 5 WHERE id = 'nope'`).run();
      expect(none.meta.changes).toBe(0);
      const sel = await db.prepare(`SELECT id FROM budget`).all();
      expect(sel.meta.changes).toBe(0);
      expect(sel.meta.rows_read).toBeGreaterThan(0);
    });
  });

  it('coerces bind values like D1 and refuses undefined', async () => {
    await inStore(async (db) => {
      await seed(db);
      await db.prepare(`UPDATE connection SET setup_done = ?1 WHERE id = 'c1'`).bind(true).run();
      expect(await db.prepare(`SELECT setup_done FROM connection`).first('setup_done')).toBe(1);
      expect(() => db.prepare(`SELECT ?1`).bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    });
  });

  it('a frozen object refuses writes but serves reads', async () => {
    await runInDurableObject(budget(), async (_obj, state) => {
      const a = new SqlD1(state.storage);
      const db = a as unknown as D1Database;
      await seed(db);
      a.frozen = true;
      await expect(db.prepare(`UPDATE budget SET rta = 1`).run()).rejects.toThrow(/frozen/);
      await expect(db.batch([db.prepare(`DELETE FROM setting`)])).rejects.toThrow(/frozen/);
      expect(await db.prepare(`SELECT count(*) AS n FROM budget`).first('n')).toBe(1);
    });
  });
});
