// Phase 1 of docs/multi-user.md: the Durable Objects migrate themselves, and the database interface does everything
// the sync leases and fences rely on (changes === 1, a failed fence rolling back the whole batch, RETURNING rows,
// bind coercion).
import type { Db } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DurableDb } from '../src/store/adapter.js';
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

async function inStore<T>(fn: (db: Db, storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(budget(), async (_obj, state) => fn(new DurableDb(state.storage), state.storage));
}

async function seed(db: Db): Promise<void> {
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
    expect(h).toMatchObject({
      ok: true,
      kind: 'budget',
      migrations: [
        '0001_baseline.sql',
        '0002_jobs.sql',
        '0003_sync.sql',
        '0004_claimed_pending.sql',
        '0005_orphaned_overlay.sql',
        '0006_drop_phone_tables_on_server.sql',
        '0007_payee_names_storage.sql',
        '0008_start_part_rows.sql',
        '0009_drift_since.sql',
      ],
    });
    expect(h.tables).toBe(38); // the four the phone keeps were dropped (migration 0006); not_same added (0007)
    const d = await e.DIRECTORY.get(e.DIRECTORY.idFromName('directory-test')).health();
    expect(d).toMatchObject({
      ok: true,
      kind: 'directory',
      migrations: [
        '0001_baseline.sql',
        '0002_jobs.sql',
        '0003_users.sql',
        '0004_do_usage.sql',
        '0005_worker_requests.sql',
        '0006_devices.sql',
        '0007_device_session.sql',
        '0008_signup.sql',
      ],
      tables: 19,
    });
  });

  it('running the migrations again does nothing', async () => {
    await inStore(async (_db, storage) => {
      expect(migrate(storage, BUDGET_MIGRATIONS, NOW).applied).toEqual([]);
    });
  });
});

describe('the Durable Object database', () => {
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

  it('returns RETURNING rows, changes and rows read', async () => {
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
      expect(ins!.changes).toBe(1);
      const r = await db.prepare(`UPDATE budget SET rta = 5 WHERE id = 'b1'`).run();
      expect(r.changes).toBe(1);
      const none = await db.prepare(`UPDATE budget SET rta = 5 WHERE id = 'nope'`).run();
      expect(none.changes).toBe(0);
      const sel = await db.prepare(`SELECT id FROM budget`).all();
      expect(sel.changes).toBe(0);
      expect(sel.rowsRead).toBeGreaterThan(0);
    });
  });

  it('stores booleans as 0 or 1 and refuses undefined', async () => {
    await inStore(async (db) => {
      await seed(db);
      await db.prepare(`UPDATE connection SET setup_done = ?1 WHERE id = 'c1'`).bind(true).run();
      expect(await db.prepare(`SELECT setup_done FROM connection`).first('setup_done')).toBe(1);
      expect(() => db.prepare(`SELECT ?1`).bind(undefined)).toThrow(/undefined/);
    });
  });
});
