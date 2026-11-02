// The BudgetStore's own scheduling (docs/multi-user.md 6.2): an empty store schedules nothing; a store with a budget
// keeps three recurring jobs; daily maintenance runs through every step on alarms and comes back for tomorrow.
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BudgetStore } from '../src/store/budget-store.js';
import { BACKSTOP_ID, DAILY_SCAN_ID, MAINTENANCE_ID } from '../src/store/budget-jobs.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
const store = (name: string) => e.BUDGET.get(e.BUDGET.idFromName(name));

async function seedBudget(stub: DurableObjectStub<BudgetStore>): Promise<void> {
  await runInDurableObject(stub, async (_o, st) => {
    st.storage.sql.exec(
      `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at)
       VALUES ('b1', 'B', '2026-09', 'America/Los_Angeles', 0, 0)`,
    );
  });
}

describe('BudgetStore scheduling', () => {
  it('an empty store schedules nothing', async () => {
    const s = store('empty');
    expect(await s.ensureJobs()).toEqual({ ok: false, jobs: [] });
    expect(await runInDurableObject(s, async (_o, st) => st.storage.getAlarm())).toBeNull();
  });

  it('a store with a budget keeps its three recurring jobs, and ensureJobs is idempotent', async () => {
    const s = store('recurring');
    await seedBudget(s);
    const a = await s.ensureJobs();
    const b = await s.ensureJobs();
    expect(a.ok).toBe(true);
    expect(b.jobs.map((j) => j.id).sort()).toEqual([BACKSTOP_ID, DAILY_SCAN_ID, MAINTENANCE_ID].sort());
    expect(await runInDurableObject(s, async (_o, st) => st.storage.getAlarm())).not.toBeNull();
  });

  it('daily maintenance runs every step on alarms, records its health and waits for tomorrow', async () => {
    const s = store('maintenance');
    await seedBudget(s);
    await s.ensureJobs();
    // Make maintenance due now; leave the others in the future.
    await runInDurableObject(s, async (_o, st) => {
      st.storage.sql.exec(`UPDATE job SET run_at = ? WHERE id = ?`, Date.now() - 1, MAINTENANCE_ID);
      await st.storage.setAlarm(Date.now());
    });
    for (let i = 0; i < 40; i++) {
      const phase = await runInDurableObject(
        s,
        async (_o, st) =>
          JSON.parse(
            String(st.storage.sql.exec(`SELECT state FROM job WHERE id = ?`, MAINTENANCE_ID).one().state),
          ).phase,
      );
      const due = await runInDurableObject(
        s,
        async (_o, st) =>
          Number(st.storage.sql.exec(`SELECT run_at FROM job WHERE id = ?`, MAINTENANCE_ID).one().run_at) <=
          Date.now(),
      );
      if (i > 0 && phase === 'start' && !due) break;
      await runInDurableObject(s, async (_o, st) => st.storage.setAlarm(Date.now()));
      await runDurableObjectAlarm(s);
    }
    const out = await runInDurableObject(s, async (_o, st) => ({
      job: st.storage.sql
        .exec(`SELECT state, run_at, attempts, last_error FROM job WHERE id = ?`, MAINTENANCE_ID)
        .one(),
      health: st.storage.sql
        .exec(`SELECT key FROM health_status ORDER BY key`)
        .toArray()
        .map((r) => r.key),
    }));
    expect(out.job).toMatchObject({ state: '{"phase":"start"}', attempts: 0, last_error: null });
    expect(Number(out.job.run_at)).toBeGreaterThan(Date.now());
    expect(out.health).toEqual(['last_recompute', 'watchdog_ran_at']);
  });
});
