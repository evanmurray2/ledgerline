// OwedView.paidBack: Owed to you · Paid back recently lists the money in that paid items back, with what each paid
// back, newest first; Unlink takes it off the list.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MatchView, OwedView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('Owed to you · Paid back recently', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('lists a payback with the items it paid back, and Unlink takes it off', async () => {
    const before = await get<OwedView>('/api/owed');
    expect(before.paidBack.find((p) => p.key === 'n-venmo')).toBeUndefined();
    const v = await get<MatchView>('/api/match/n-venmo');
    const [a, b] = v.open.filter((o) => o.still > 0);
    const items = [
      { itemId: a!.id, amount: Math.min(a!.still, v.left - 100) },
      { itemId: b!.id, amount: 100 },
    ];
    expect((await post('/api/match', { inflowKey: 'n-venmo', items })).status).toBe(200);

    const after = await get<OwedView>('/api/owed');
    const p = after.paidBack.find((x) => x.key === 'n-venmo')!;
    expect(p.date).toBe(v.inflow.date);
    expect(p.payee).toBe(v.inflow.payee);
    expect(p.matched).toBe(items[0]!.amount + 100);
    // Largest first, the same on every device.
    const largest = [...items].sort((x, y) => y.amount - x.amount || x.itemId.localeCompare(y.itemId));
    expect(p.items.map((i) => [i.id, i.amount])).toEqual(largest.map((i) => [i.itemId, i.amount]));
    // Each item by the name Still owed gives it.
    for (const i of p.items) expect(i.label).toBe(after.items.find((x) => x.id === i.id)!.label);
    // Newest first.
    const dates = after.paidBack.map((x) => x.date);
    expect([...dates].sort().reverse()).toEqual(dates);

    expect((await post('/api/match', { inflowKey: 'n-venmo', items: [] })).status).toBe(200);
    expect((await get<OwedView>('/api/owed')).paidBack.find((x) => x.key === 'n-venmo')).toBeUndefined();
  });
});
