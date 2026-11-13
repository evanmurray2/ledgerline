// Activity's rows carry `categoryId` (desktop's per-row category menu) only when one category is all a row needs:
// money out, not a transfer, a split, an upcoming bill or a won't-clear row.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, TxnSheet } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

describe('Activity rows: categoryId', () => {
  let v: ActivityView;
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    v = await get<ActivityView>('/api/activity?filter=all');
  });

  it('is the sheet’s own category on a picked row', async () => {
    const picked = [...v.posted, ...v.pending].filter((r) => r.categoryId !== undefined);
    expect(picked.length).toBeGreaterThan(0);
    for (const r of picked.slice(0, 10)) {
      const t = await get<TxnSheet>(`/api/transactions/${encodeURIComponent(r.key)}`);
      expect(r.amount, r.payee).toBeLessThan(0);
      expect(t.split ?? [], r.payee).toEqual([]);
      expect(r.categoryId ?? null, r.payee).toBe(t.categoryId);
    }
  });

  it('is left out on money in, transfers, upcoming and won’t-clear rows', () => {
    for (const r of [...v.posted, ...v.pending, ...v.upcoming]) {
      if (r.amount > 0 || r.badge === 'Transfer' || r.status === 'upcoming' || r.wontClear)
        expect(r.categoryId, r.payee).toBeUndefined();
    }
  });
});
