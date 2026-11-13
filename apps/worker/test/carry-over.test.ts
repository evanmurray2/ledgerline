// BudgetView.carryOver: how this month's Ready to Assign came about (the "has started" card). It only shows totals the
// Money rules already keep, so its parts always add up to Ready to Assign, and an edit moves money between parts
// only as the rules move it: a payback is money in either way (D-98), Close out gives Ready to Assign the amount back.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, MatchView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const budget = () => get<BudgetView>('/api/budget/2026-11');

type Carry = NonNullable<BudgetView['carryOver']>;
const total = (c: Carry) => c.left - c.overspent + c.income + c.paidBack + c.closedOut - c.owed - c.assigned;

describe('carry-over summary', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('this month: from last month, and its parts add up to Ready to Assign', async () => {
    const b = await budget();
    const c = b.carryOver!;
    expect(c.from).toBe('2026-10');
    expect(total(c)).toBe(b.rta);
    // Assigned is this month's and later months' assignments, as Budget shows them.
    const shown = b.groups.flatMap((g) => g.categories).reduce((a, x) => a + x.assigned, 0);
    expect(c.assigned).toBeGreaterThanOrEqual(shown);
    // Last month's own numbers: Ready to Assign at its end is what October's carry-over started this month with.
    expect(c.left).toBeGreaterThan(0);
  });

  it('none for a past month or a later one', async () => {
    expect((await get<BudgetView>('/api/budget/2026-12')).carryOver).toBeNull();
    const oct = await get<BudgetView>('/api/budget/2026-10');
    expect(oct.carryOver).toBeNull();
  });

  it('a payback moves money from income to paid back, and Ready to Assign stays the same', async () => {
    const before = await budget();
    const v = await get<MatchView>('/api/match/n-venmo');
    const o = v.open.find((x) => x.still > 0)!;
    const amount = Math.min(o.still, v.left);
    expect(
      (await post('/api/match', { inflowKey: 'n-venmo', items: [{ itemId: o.id, amount }] })).status,
    ).toBe(200);
    const after = await budget();
    expect(after.rta).toBe(before.rta);
    expect(after.carryOver!.paidBack - before.carryOver!.paidBack).toBe(amount);
    expect(before.carryOver!.income - after.carryOver!.income).toBe(amount);
    expect(total(after.carryOver!)).toBe(after.rta);
  });

  it('Close out shows as closed out, and the parts still add up', async () => {
    const owed = await get<{ items: { id: string; status: string; still: number }[] }>('/api/owed');
    const open = owed.items.find((i) => i.status === 'open' || i.status === 'late')!;
    const before = await budget();
    expect((await post(`/api/owed/${open.id}`, { action: 'close' })).status).toBe(200);
    const after = await budget();
    expect(after.carryOver!.closedOut - before.carryOver!.closedOut).toBe(open.still);
    expect(after.carryOver!.income).toBe(before.carryOver!.income);
    expect(total(after.carryOver!)).toBe(after.rta);
  });

  it('assigning moves only the assigned part', async () => {
    const before = await budget();
    expect(
      (
        await post('/api/budget/assign', {
          month: '2026-12',
          items: [{ categoryId: 'groceries', amount: 1234 }],
        })
      ).status,
    ).toBe(200);
    const after = await budget();
    expect(after.carryOver!.assigned - before.carryOver!.assigned).toBe(1234);
    expect(after.carryOver!.left).toBe(before.carryOver!.left);
    expect(total(after.carryOver!)).toBe(after.rta);
  });
});
