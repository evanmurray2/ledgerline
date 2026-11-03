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

  it('the first API call puts back an alarm Cloudflare dropped while jobs wait', async () => {
    const s = store('rearm');
    await seedBudget(s);
    await s.ensureJobs();
    await runInDurableObject(s, async (_o, st) => st.storage.deleteAlarm());
    const caller = { userId: 'u1', budgetId: 'b1', email: '', sessionId: '', verifiedAt: 0 };
    await s.api(new Request('https://app.test/api/none'), caller);
    expect(await runInDurableObject(s, async (_o, st) => st.storage.getAlarm())).not.toBeNull();
  });

  it('daily maintenance runs every step on alarms, records its health and waits for tomorrow', async () => {
    const s = store('maintenance');
    await seedBudget(s);
    await s.ensureJobs();
    // Make maintenance due now; leave the others in the future. Give the prune something to keep and to remove.
    await runInDurableObject(s, async (_o, st) => {
      const day = 86_400_000;
      const sql = st.storage.sql;
      sql.exec(
        `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
         VALUES ('c1', 'b1', 'plaid', 'Bank', 0, 0, 0)`,
      );
      for (const [run, phase] of [
        ['run-done', 'done'],
        ['run-live', 'applying'],
      ])
        sql.exec(
          `INSERT INTO sync_run (id, budget_id, connection_id, phase, started_at, created_at, updated_at) VALUES (?, 'b1', 'c1', ?, 0, 0, 0)`,
          run,
          phase,
        );
      for (const run of ['run-done', 'run-live'])
        sql.exec(
          `INSERT INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at)
           VALUES (?, 0, 'b1', 0, 'k', 'none', 1, 'c', 0, 0)`,
          run,
        );
      for (const [id, failedAt] of [
        ['old-failure', Date.now() - 31 * day],
        ['new-failure', Date.now() - day],
      ])
        sql.exec(
          `INSERT INTO job (id, kind, state, run_at, failed_at, created_at, updated_at) VALUES (?, 'x', '{}', 0, ?, 0, 0)`,
          id,
          failedAt,
        );
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
      stagedRuns: st.storage.sql
        .exec(`SELECT sync_run_id FROM sync_page ORDER BY 1`)
        .toArray()
        .map((r) => r.sync_run_id),
      failures: st.storage.sql
        .exec(`SELECT id FROM job WHERE failed_at IS NOT NULL ORDER BY 1`)
        .toArray()
        .map((r) => r.id),
    }));
    expect(out.stagedRuns).toEqual(['run-live']);
    expect(out.failures).toEqual(['new-failure']);
    expect(out.job).toMatchObject({ state: '{"phase":"start"}', attempts: 0, last_error: null });
    expect(Number(out.job.run_at)).toBeGreaterThan(Date.now());
    expect(out.health).toEqual(['watchdog_ran_at']);
  });
});
