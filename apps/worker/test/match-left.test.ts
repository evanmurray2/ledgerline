// Match money back counts what the money already pays back (rule 12): it never pays back more than came in, the
// sheet offers only the rest, and "It's income" undoes the old links instead of keeping them.
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

describe('Match money back', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('a second match offers only what is left, and refuses more than came in', async () => {
    const v = await get<MatchView>('/api/match/n-venmo');
    expect(v.left).toBe(v.inflow.amount);
    // Match all but $10 of it.
    const first: { itemId: string; amount: number }[] = [];
    let rest = v.inflow.amount - 1000;
    for (const o of v.open) {
      const a = Math.min(o.still, rest);
      if (a <= 0) break;
      first.push({ itemId: o.id, amount: a });
      rest -= a;
    }
    expect((await post('/api/match', { inflowKey: 'n-venmo', items: first })).status).toBe(200);

    const again = await get<MatchView>('/api/match/n-venmo');
    expect(again.left).toBe(1000);
    expect(again.open.reduce((a, o) => a + o.suggested, 0)).toBeLessThanOrEqual(1000);
    const other = again.open.find((o) => o.still > 1000)!;
    const tooMuch = await post('/api/match', {
      inflowKey: 'n-venmo',
      items: [{ itemId: other.id, amount: 1001 }],
    });
    expect(tooMuch.status).toBe(422);
    expect(
      (await post('/api/match', { inflowKey: 'n-venmo', items: [{ itemId: other.id, amount: 1000 }] }))
        .status,
    ).toBe(200);
    expect((await get<MatchView>('/api/match/n-venmo')).left).toBe(0);
  });

  it('"It\'s income" on matched money undoes what it paid back', async () => {
    const before = await get<OwedView>('/api/owed');
    expect((await post('/api/match', { inflowKey: 'n-venmo', items: [] })).status).toBe(200);
    const v = await get<MatchView>('/api/match/n-venmo');
    expect(v.left).toBe(v.inflow.amount);
    const after = await get<OwedView>('/api/owed');
    expect(after.out).toBeGreaterThan(before.out);
  });

  it('money going out has nothing to match', async () => {
    expect((await app('/api/match/n-tj')).status).toBe(422);
  });
});
