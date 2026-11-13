// The BudgetStore of a locked world (D-102): a store answers only the routes of a locked budget, a new budget's
// session and its start, and schedules only a sealed budget's own jobs. Any old route is told to update, and any
// job of a kind from before is dropped unrun.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SEALED_BACKSTOP_ID } from '../src/seal/fetch-job.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { budgetOf } from './phone.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
const store = (name: string) => e.BUDGET.get(e.BUDGET.idFromName(name));

describe('BudgetStore', () => {
  it('an empty store schedules nothing', async () => {
    const s = store('empty');
    expect(await s.ensureJobs()).toEqual({ ok: false, jobs: [] });
    expect(await runInDurableObject(s, async (_o, st) => st.storage.getAlarm())).toBeNull();
  });

  it('a budget not made yet: its session says so, and every old route is told to update', async () => {
    const { budgetId } = await budgetOf();
    const session = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { 'x-ledgerline-sealed': '1' } });
    expect(await session.json()).toMatchObject({ sealed: true, fresh: true, budgetId });
    // An app from before D-102 (no `x-ledgerline-sealed`), the old sync, a change of the budget, the log: refused.
    for (const [method, path] of [
      ['GET', '/api/session'],
      ['GET', '/api/sync?since=0'],
      ['GET', '/api/budget/2026-11'],
      ['POST', '/api/budget/set'],
      ['GET', '/api/log?after=0'],
    ] as const) {
      const r = await SELF.fetch(`${ORIGIN}${path}`, {
        method,
        headers: H,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(await r.json()).toMatchObject({ error: 'sealed', message: 'Update Ledgerline to continue.' });
    }
    // No job is kept for it.
    expect((await store(budgetId).ensureJobs()).jobs).toEqual([]);
  });

  it('a sealed budget keeps its backstop, and a job of an old kind is dropped unrun', async () => {
    const { budgetId } = await budgetOf();
    await storeDb(budgetId).prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`).run();
    const s = store(budgetId);
    const a = await s.ensureJobs();
    const b = await s.ensureJobs();
    expect(a.ok).toBe(true);
    expect(b.jobs.map((j) => j.id)).toEqual([SEALED_BACKSTOP_ID]);
    await runInDurableObject(s, async (obj, state) => {
      state.storage.sql.exec(
        `INSERT INTO job (id, kind, state, run_at, recurring, created_at, updated_at) VALUES ('due-now', 'daily_scan', '{}', 1, 0, 1, 1)`,
      );
      await obj.alarm();
      expect(state.storage.sql.exec(`SELECT count(*) AS n FROM job WHERE id = 'due-now'`).one().n).toBe(0);
    });
    // The session goes only to an app that can open a locked budget.
    expect((await SELF.fetch(`${ORIGIN}/api/session`)).status).toBe(409);
    const session = await SELF.fetch(`${ORIGIN}/api/session`, { headers: { 'x-ledgerline-sealed': '1' } });
    expect(await session.json()).not.toHaveProperty('fresh');
  });
});
