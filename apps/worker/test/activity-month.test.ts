// Activity's month bar (docs/month-header.md): `?month=` lists the posted rows Budget counts in that month, a
// search looks through every month, and pending and upcoming rows show on this month only.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, TxnSheet } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const keys = (v: ActivityView) => v.posted.map((r) => r.key).sort();
const sheetMonth = async (key: string) =>
  (await get<TxnSheet>(`/api/transactions/${encodeURIComponent(key)}`)).budgetMonth;

describe('Activity by month', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('a month lists exactly the posted rows whose budget month it is', async () => {
    // Every posted row, page by page (a page holds 50).
    const all: ActivityView = await get<ActivityView>('/api/activity');
    for (let c = all.nextCursor; c;) {
      const page = await get<ActivityView>(`/api/activity?cursor=${encodeURIComponent(c)}`);
      all.posted.push(...page.posted);
      c = page.nextCursor;
    }
    const nov = await get<ActivityView>('/api/activity?month=2026-11');
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    expect(nov.posted.length).toBeGreaterThan(0);
    expect(oct.posted.length).toBeGreaterThan(0);
    const months = new Map<string, string>();
    for (const r of all.posted) months.set(r.key, await sheetMonth(r.key));
    expect(keys(nov)).toEqual(
      [...months]
        .filter(([, m]) => m === '2026-11')
        .map(([k]) => k)
        .sort(),
    );
    expect(keys(oct)).toEqual(
      [...months]
        .filter(([, m]) => m === '2026-10')
        .map(([k]) => k)
        .sort(),
    );
  });

  it('a row moved to another budget month is listed there', async () => {
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    const row = oct.posted.find((r) => r.amount > 0) ?? oct.posted[0]!;
    const res = await app(`/api/transactions/${encodeURIComponent(row.key)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ budgetMonth: '2026-11' }),
    });
    expect(res.status).toBe(200);
    expect(keys(await get<ActivityView>('/api/activity?month=2026-11'))).toContain(row.key);
    expect(keys(await get<ActivityView>('/api/activity?month=2026-10'))).not.toContain(row.key);
    await app(`/api/transactions/${encodeURIComponent(row.key)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ budgetMonth: null }),
    });
  });

  it('this month shows every pending and upcoming row; a past month none', async () => {
    const plain = await get<ActivityView>('/api/activity');
    const nov = await get<ActivityView>('/api/activity?month=2026-11');
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    expect(plain.pending.length).toBeGreaterThan(0);
    expect(nov.pending.map((r) => r.key)).toEqual(plain.pending.map((r) => r.key));
    expect(nov.upcoming.map((r) => r.key)).toEqual(plain.upcoming.map((r) => r.key));
    expect(oct.pending).toEqual([]);
    expect(oct.upcoming).toEqual([]);
    // To-dos are waiting now, whatever the month.
    expect(oct.attentionCount).toBe(nov.attentionCount);
    expect(oct.needsCategory.map((r) => r.key)).toEqual(nov.needsCategory.map((r) => r.key));
  });

  it('a search looks through every month; a month before the budget shows its first month', async () => {
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    const payee = oct.posted[0]!.payee;
    const found = await get<ActivityView>(`/api/activity?month=2026-11&q=${encodeURIComponent(payee)}`);
    expect(found.posted.map((r) => r.key)).toContain(oct.posted[0]!.key);
    expect(keys(await get<ActivityView>('/api/activity?month=2025-01'))).toEqual(keys(oct));
  });

  it('refuses a malformed month', async () => {
    expect((await app('/api/activity?month=2026-13')).status).toBe(400);
    expect((await app('/api/activity?month=oct')).status).toBe(400);
  });
});
