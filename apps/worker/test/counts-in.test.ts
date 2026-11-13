// "Counts in" a later month: a November purchase set to December leaves November and counts as December spending.
// It must never vanish from every month (the budget then fails rule 10).
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
/** The Personal care row of a month's budget. */
const personal = async (m: string) => {
  const b = await get<BudgetView>(`/api/budget/${m}`);
  let found: { activity: number; spent: number } | undefined;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if ((x as { id?: string }).id === 'personal' && 'activity' in x) found = x as never;
    for (const v of Object.values(x)) walk(v);
  };
  walk(b);
  return found!;
};

describe('Counts in a later month', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('a November purchase set to December counts in December only', async () => {
    const nov = await personal('2026-11');
    const dec = await personal('2026-12');
    expect(nov.activity).toBe(-8500);
    expect(dec.activity).toBe(0);
    const r = await app('/api/transactions/n-personal', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ budgetMonth: '2026-12' }),
    });
    expect(r.status).toBe(200);
    expect((await personal('2026-11')).activity).toBe(0);
    expect((await personal('2026-12')).activity).toBe(-8500);
  });
});
