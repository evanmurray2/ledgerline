// Suggested categories in Activity's Needs category (docs/payees.md 2.1) and the categorize route's checks.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('suggested categories', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('suggests what you used before for the same payee, and lists it in the picker', async () => {
    const v = await get<ActivityView>('/api/activity');
    const amazon = v.needsCategory.filter((r) => r.payee === 'Amazon');
    expect(amazon).toHaveLength(2);
    expect(amazon.every((r) => r.suggestion === null && r.history === null)).toBe(true);
    const cat = v.categoryPicker[0]!.categories[0]!;
    expect(
      (await post('/api/transactions/categorize', { keys: [amazon[0]!.key], categoryId: cat.id })).status,
    ).toBe(200);
    const after = await get<ActivityView>('/api/activity');
    const other = after.needsCategory.find((r) => r.key === amazon[1]!.key)!;
    expect(other.suggestion).toEqual({ categoryId: cat.id, toRta: false, name: cat.name, strong: false });
    expect(other.history).toEqual({
      title: 'You’ve used for Amazon',
      categories: [{ id: cat.id, name: cat.name, count: 1 }],
    });
    // Another payee has no suggestion.
    expect(after.needsCategory.find((r) => r.payee === 'CVS Pharmacy')!.suggestion).toBeNull();
  });

  it('refuses Ready to Assign for money going out', async () => {
    const v = await get<ActivityView>('/api/activity');
    const out = v.needsCategory.find((r) => r.amount < 0)!;
    const r = await post('/api/transactions/categorize', { keys: [out.key], categoryId: null, toRta: true });
    expect(r.status).toBe(422);
  });
});
