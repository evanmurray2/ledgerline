// An edit never lands in the middle of a bank update (D-86 A4): it waits until the update is filed, with a limit.
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { HELD, waitForUpdates } from '../src/http/after-update.js';
import { DurableDb } from '../src/store/adapter.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import type { Env } from '../src/env.js';
import { ownerDb } from './store-db.js';

const e = env as unknown as Env & { BUDGET: DurableObjectNamespace<BudgetStore> };
const T = Date.parse('2026-11-14T20:00:00Z');

describe('an edit waits for a bank update', () => {
  it('holds the requests that change what the budget counts, and no others', () => {
    for (const path of [
      '/api/transactions',
      '/api/transactions/p:abc',
      '/api/transactions/categorize',
      '/api/budget/assign',
      '/api/categories/c1/target',
      '/api/match/k/unlink',
      '/api/transfers/k/pick',
      '/api/same-purchase/a1',
      '/api/owed/o1',
      '/api/accounts/a1/close',
      '/api/setup/starting-balances',
      '/api/settings/categories/c1/archive',
      '/api/settings/groups/reorder',
      '/api/settings/payees/merge',
    ])
      expect(HELD.test(path), path).toBe(true);
    for (const path of [
      '/api/settings/connections/refresh',
      '/api/settings/connections/link-finish',
      '/api/settings/security/sign-out',
      '/api/settings',
      '/api/usage',
      '/api/notes',
      '/api/copy-status',
      '/api/webhooks/plaid',
      '/api/sync',
      '/api/budgetary',
    ])
      expect(HELD.test(path), path).toBe(false);
  });

  it('waits while an update is fetched and not yet filed, and goes on when it is done or its job is gone', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('after-update')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await db.batch([
        db.prepare(
          `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1', 'B', '2023-11', 0, 0)`,
        ),
        db.prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at, sync_lock, lock_expires)
           VALUES ('c1', 'b1', 'plaid', 'Bank', 0, 0, 0, 'r1', ${T + 3_600_000})`,
        ),
      ]);
      const run = (phase: string, seq: number | null) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO sync_run (id, budget_id, connection_id, phase, started_at, created_at, updated_at, fetched_at, fetch_seq)
             VALUES ('r1', 'b1', 'c1', ?1, ?2, ?2, ?2, ?3, ?4)`,
          )
          .bind(phase, T, seq === null ? null : T, seq)
          .run();
      let clock = T;
      const sleeps: number[] = [];
      const opts = (onSleep?: (n: number) => Promise<void>) => ({
        maxMs: 2000,
        now: () => clock,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
          await onSleep?.(sleeps.length);
        },
      });

      // Still fetching (no place yet): nothing to wait for.
      await run('fetching', null);
      expect(await waitForUpdates(db, opts())).toBe(true);
      expect(sleeps).toEqual([]);

      // Fetched, and filed after three looks: the edit waited, then went on.
      await run('fetching', 1);
      const done = async (n: number) => {
        if (n === 3) await db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = 'r1'`).run();
      };
      expect(await waitForUpdates(db, opts(done))).toBe(true);
      expect(sleeps.length).toBe(3);

      // Being applied, and never done: the edit waits to its limit and no longer.
      sleeps.length = 0;
      await run('applying', 2);
      expect(await waitForUpdates(db, opts())).toBe(false);
      expect(sleeps.reduce((a, b) => a + b, 0)).toBe(2000);

      // The update's job is gone (its lease ran out): nothing waits for it.
      sleeps.length = 0;
      await db
        .prepare(`UPDATE connection SET lock_expires = ?1 WHERE id = 'c1'`)
        .bind(clock - 1)
        .run();
      expect(await waitForUpdates(db, opts())).toBe(true);
      expect(sleeps).toEqual([]);
    });
  });

  it('through the Worker: an edit during an update that never ends still gets its answer', async () => {
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await worker.fetch(
        new Request(`https://ledgerline.test${path}`, {
          method,
          headers:
            method === 'GET'
              ? { origin: 'https://ledgerline.test' }
              : {
                  origin: 'https://ledgerline.test',
                  'content-type': 'application/json',
                  'x-ledgerline': '1',
                },
          body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        }),
        env as never,
        createExecutionContext(),
      );
      return res.status;
    };
    expect(await call('GET', '/api/session')).toBe(200);
    const db = ownerDb();
    const budget = (await db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    const far = Date.parse('2099-01-01T00:00:00Z');
    await db.batch([
      db
        .prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at, sync_lock, lock_expires)
           VALUES ('c_wait', ?1, 'plaid', 'Bank', 0, 0, 0, 'r_wait', ?2)`,
        )
        .bind(budget, far),
      db
        .prepare(
          `INSERT INTO sync_run (id, budget_id, connection_id, phase, started_at, created_at, updated_at, fetched_at, fetch_seq)
           VALUES ('r_wait', ?1, 'c_wait', 'applying', 1, 1, 1, 1, 1)`,
        )
        .bind(budget),
    ]);
    // The test limit is 400 ms (vitest.config.ts): the request waits about that long, then is handled as usual.
    const t0 = Date.now();
    const status = await call('POST', '/api/settings/groups', { name: 'Held group' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(status).toBeLessThan(500);
    expect(
      await db.prepare(`SELECT count(*) AS n FROM category_group WHERE name = 'Held group'`).first('n'),
    ).toBe(status === 200 ? 1 : 0);
    await db.prepare(`UPDATE sync_run SET phase = 'done' WHERE id = 'r_wait'`).run();
  });
});
