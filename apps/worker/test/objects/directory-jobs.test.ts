// The Directory's daily work and Plaid Item routing after the move (docs/multi-user.md 6.2, 6.4).
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { SEALED_BACKSTOP_ID } from '../../src/seal/fetch-job.js';
import type { Env } from '../../src/env.js';
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
    st.storage.sql.exec(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?, 'B', 0, 0)`, id);
    if (item)
      st.storage.sql.exec(
        `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, linked_at, created_at)
         VALUES (?, 'con_' || ?, ?, 'plaid', ?, 0, 0)`,
        id,
        id,
        id,
        item,
      );
    // Every budget is locked (D-102).
    st.storage.sql.exec(`INSERT INTO store_mark (key, at) VALUES ('sealed', 0)`);
  });
}

describe('Directory daily work', () => {
  it('walks every budget in batches and leaves each with its backstop and routed Items', async () => {
    const ids = Array.from({ length: ENSURE_BATCH + 3 }, (_, i) => `bud_${String(i).padStart(3, '0')}`);
    for (const id of ids) await addBudget(id, `item_${id}`);
    await dir().daily();
    await drain(dir());
    for (const id of [ids[0]!, ids[ENSURE_BATCH]!, ids.at(-1)!]) {
      const jobs = (await store(id).jobs()).map((j) => j.id);
      expect(jobs).toEqual(expect.arrayContaining([SEALED_BACKSTOP_ID]));
      await drain(store(id));
      expect(await dir().routeFor(`item_${id}`)).toBe(id);
    }
  });

  it('an Item already routed to another budget is not moved', async () => {
    await addBudget('dup_a', 'item_shared');
    await addBudget('dup_b', 'item_shared');
    for (const id of ['dup_a', 'dup_b']) {
      await store(id).ensureJobs();
      await drain(store(id));
    }
    expect(await dir().routeFor('item_shared')).toBe('dup_a');
  });
});

describe('usage refresh', () => {
  // GraphQL answers a used-up rate limit with HTTP 200, errors and no data (Nov 5, 2026).
  it('keeps the last count when GraphQL answers with errors', async () => {
    const { refreshUsage } = await import('../../src/ops/usage.js');
    const { utcDay } = await import('../../src/sync/breaker.js');
    const now = Date.now();
    const day = utcDay(now);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ data: null, errors: [{ message: 'Rate limiter budget depleted.' }] }),
      );
    try {
      const rows = await runInDurableObject(dir(), async (o, st) => {
        st.storage.sql.exec(
          `INSERT INTO usage_day (day, rows_read, rows_written, est_read, est_written, refreshed_at, do_requests, do_gbs, worker_requests)
           VALUES (?, 4000000, 80000, 10, 20, 0, 5000, 100, 3000)
           ON CONFLICT (day) DO UPDATE SET rows_read = 4000000, rows_written = 80000, est_read = 10, est_written = 20,
             refreshed_at = 0, do_requests = 5000, do_gbs = 100, worker_requests = 3000`,
          day,
        );
        const appEnv = (o as unknown as { appEnv(): Env }).appEnv();
        const r = await refreshUsage(
          { ...appEnv, CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'token' },
          now,
          true,
        );
        return {
          r,
          row: st.storage.sql
            .exec(
              `SELECT rows_read, rows_written, est_read, est_written, do_requests, worker_requests FROM usage_day WHERE day = ?`,
              day,
            )
            .one(),
        };
      });
      expect(spy).toHaveBeenCalled();
      expect(rows.r).toBeNull();
      expect(rows.row).toEqual({
        rows_read: 4000000,
        rows_written: 80000,
        est_read: 10,
        est_written: 20,
        do_requests: 5000,
        worker_requests: 3000,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
