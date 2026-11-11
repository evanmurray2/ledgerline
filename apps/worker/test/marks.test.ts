// Sealed and frozen (docs/privacy.md section 8, step 3; store/marks.ts): the old code paths leave a marked budget
// alone. No budget is marked in production yet; this release only knows the marks.
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetStore } from '../src/store/budget-store.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };

describe('a marked budget', () => {
  let budget: string;
  const stub = () => e.BUDGET.get(e.BUDGET.idFromName(budget));
  const mark = (key: 'sealed' | 'frozen', until: number | null) =>
    storeDb(budget)
      .prepare(
        `INSERT INTO store_mark (key, at, until) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET until = excluded.until`,
      )
      .bind(key, Date.now(), until)
      .run();
  const clear = () => storeDb(budget).prepare(`DELETE FROM store_mark`).run();
  const assign = () =>
    SELF.fetch(`${ORIGIN}/api/budget/set`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ month: '2026-11', categoryId: 'rent', assigned: 4242 }),
    });
  const rent = async () =>
    (await storeDb(budget)
      .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = 'rent'`)
      .first<{ amount: number }>())!.amount;

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    const s = (await (await SELF.fetch(`${ORIGIN}/api/session`)).json()) as { budget: { id: string } };
    budget = s.budget.id;
  });

  it('frozen: reads go on, writes and jobs are refused, and it ends by itself', async () => {
    const before = await rent();
    await mark('frozen', Date.now() + 60_000);
    expect((await SELF.fetch(`${ORIGIN}/api/sync?since=0&limit=5`)).status).toBe(200);
    const w = await assign();
    expect(w.status).toBe(503);
    expect(((await w.json()) as { error: string }).error).toBe('frozen');
    expect(await rent()).toBe(before);
    expect(await stub().startSync('no-such-connection', 'test')).toBe(false);
    // A freeze whose time is over, or that has none, holds nothing.
    await mark('frozen', Date.now() - 1);
    expect((await assign()).status).toBe(200);
    await mark('frozen', null);
    expect((await assign()).status).toBe(200);
    await clear();
  });

  it('sealed: routes answer "update", and nothing is read or written', async () => {
    const before = await rent();
    await mark('sealed', null);
    const r = await SELF.fetch(`${ORIGIN}/api/sync?since=0&limit=5`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('sealed');
    expect((await assign()).status).toBe(409);
    expect(await rent()).toBe(before - 0);
    expect(await stub().startSync('no-such-connection', 'test')).toBe(false);
    // An alarm that fires runs no job and sets no new alarm.
    await runInDurableObject(stub(), async (obj, state) => {
      await state.storage.deleteAlarm();
      await obj.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await clear();
    expect((await assign()).status).toBe(200);
  });
});
