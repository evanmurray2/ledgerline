// Reports on the seeded November budget: the category list adds up to the Spent tile (a category with more refunds
// than spending is listed below $0), and the net worth chart starts no earlier than the budget and ends at the month
// picked.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportsView, Session } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

describe('reports view', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
  });

  it('the list adds up to Spent, with a category of net refunds below $0', async () => {
    // $200 back into Electric: more refunds than spending this month.
    const add = await app('/api/transactions', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        kind: 'pending',
        accountId: 'checking',
        date: '2026-11-10',
        amount: 20000,
        payee: 'Electric refund',
        categoryId: 'electric',
        repeats: 'never',
      }),
    });
    expect(add.status).toBe(200);
    const r = await get<ReportsView>('/api/reports');
    const electric = r.byCategory.find((c) => c.categoryId === 'electric');
    expect(electric?.spent).toBeLessThan(0);
    expect(r.byCategory.reduce((a, c) => a + c.spent, 0)).toBe(r.tiles.spent);
  });

  it('net worth starts at the budget start and ends at the month picked', async () => {
    const session = await get<Session>('/api/session');
    const start = session.budget.startMonth!;
    const now = await get<ReportsView>('/api/reports');
    expect(now.netWorth.length).toBeLessThanOrEqual(12);
    expect(now.netWorth[0]!.month >= start).toBe(true);
    expect(now.netWorth.at(-1)!.month).toBe(session.budget.currentMonth);
    const oct = await get<ReportsView>('/api/reports?month=2026-10');
    expect(oct.netWorth.at(-1)!.month).toBe('2026-10');
    // The same month ends at the same value whichever month is picked.
    expect(oct.netWorth.at(-1)!.value).toBe(now.netWorth.find((p) => p.month === '2026-10')!.value);
    expect(oct.netWorth[0]!.month >= start).toBe(true);
  });
});
