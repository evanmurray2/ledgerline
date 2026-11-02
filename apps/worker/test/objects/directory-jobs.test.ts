// The Directory's daily work and Plaid Item routing after the move (docs/multi-user.md 6.2, 6.4).
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DIRECTORY_NAME, ENSURE_BATCH, type Directory } from '../../src/store/directory.js';
import type { BudgetStore } from '../../src/store/budget-store.js';

const e = env as unknown as {
  DIRECTORY: DurableObjectNamespace<Directory>;
  BUDGET: DurableObjectNamespace<BudgetStore>;
};
const dir = () => e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));
const store = (id: string) => e.BUDGET.get(e.BUDGET.idFromName(id));

/** Runs due alarms until none is due now (each alarm runs one job step). */
async function drain(stub: DurableObjectStub, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    const due = await runInDurableObject(stub, async (_o, st) => {
      const r = st.storage.sql
        .exec(`SELECT count(*) AS n FROM job WHERE failed_at IS NULL AND run_at <= ?`, Date.now())
        .one();
      if (Number(r.n) > 0) await st.storage.setAlarm(Date.now());
      return Number(r.n);
    });
    if (!due) return;
    await runDurableObjectAlarm(stub);
  }
}

async function addBudget(id: string, item?: string): Promise<void> {
  await runInDurableObject(dir(), async (_o, st) => {
    st.storage.sql.exec(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?, 'B', 0, 0)`, id);
  });
  await runInDurableObject(store(id), async (_o, st) => {
    st.storage.sql.exec(
      `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES (?, 'B', '2026-09', 'America/Los_Angeles', 0, 0)`,
      id,
    );
    if (item)
      st.storage.sql.exec(
        `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, linked_at, created_at, updated_at)
         VALUES ('con_' || ?, ?, 'plaid', ?, 'Bank', 0, 0, 0)`,
        id,
        id,
        item,
      );
  });
}

describe('Directory daily work', () => {
  it('walks every budget in batches and leaves each with its recurring jobs and routed Items', async () => {
    const ids = Array.from({ length: ENSURE_BATCH + 3 }, (_, i) => `bud_${String(i).padStart(3, '0')}`);
    for (const id of ids) await addBudget(id, `item_${id}`);
    await dir().daily();
    await drain(dir());
    for (const id of [ids[0]!, ids[ENSURE_BATCH]!, ids.at(-1)!]) {
      const jobs = (await store(id).jobs()).map((j) => j.id);
      expect(jobs).toEqual(
        expect.arrayContaining(['recurring:backstop', 'recurring:daily_scan', 'recurring:maintenance']),
      );
      await drain(store(id));
      expect(await dir().routeFor(`item_${id}`)).toBe(id);
    }
  });

  it('an Item already routed to another budget is flagged, not moved', async () => {
    await addBudget('dup_a', 'item_shared');
    await addBudget('dup_b', 'item_shared');
    for (const id of ['dup_a', 'dup_b']) {
      await store(id).ensureJobs();
      await drain(store(id));
    }
    expect(await dir().routeFor('item_shared')).toBe('dup_a');
    const flagged = await runInDurableObject(
      store('dup_b'),
      async (_o, st) => st.storage.sql.exec(`SELECT error_code FROM connection`).one().error_code,
    );
    expect(flagged).toBe('duplicate_item');
  });
});
