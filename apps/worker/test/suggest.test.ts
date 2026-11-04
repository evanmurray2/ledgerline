// Suggested categories in Activity's Needs category (docs/payees.md 2.1) and the categorize route's checks.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, MergeResult } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

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

  it('a payee you never categorized is new; one named like yours offers Same as, and Join takes it in', async () => {
    let v = await get<ActivityView>('/api/activity');
    const cvs = v.needsCategory.find((r) => r.payee === 'CVS Pharmacy')!;
    expect(cvs.newPayee).toBe(true);
    expect(cvs.sameAs).toBeNull();
    expect(v.needsCategory.find((r) => r.payee === 'Amazon')!.newPayee).toBe(false);
    // The bank names CVS's payee like your Amazon (any case, spaces).
    await ownerDb().prepare(`UPDATE payee SET name = ' amazon' WHERE id = ?1`).bind(cvs.payeeId!).run();
    v = await get<ActivityView>('/api/activity');
    const row = v.needsCategory.find((r) => r.key === cvs.key)!;
    const amazon = v.needsCategory.find((r) => r.payee === 'Amazon' && r.key !== cvs.key)!;
    expect(row.sameAs).toEqual({ id: amazon.payeeId, name: 'Amazon' });
    // It suggests what you use for your Amazon.
    expect(row.suggestion?.categoryId).toBe(amazon.suggestion?.categoryId);
    const r = await post('/api/settings/payees/merge', {
      keep: amazon.payeeId,
      ids: [amazon.payeeId, cvs.payeeId],
    });
    expect(r.status).toBe(200);
    v = await get<ActivityView>('/api/activity');
    const joined = v.needsCategory.find((x) => x.key === cvs.key)!;
    expect(joined).toMatchObject({ payee: 'Amazon', payeeId: amazon.payeeId, newPayee: false, sameAs: null });
    // Undo puts the new payee back.
    const { undoId } = (await r.json()) as MergeResult;
    expect((await post(`/api/settings/payees/merge/${undoId}/undo`, {})).status).toBe(200);
    v = await get<ActivityView>('/api/activity');
    expect(v.needsCategory.find((x) => x.key === cvs.key)!.payeeId).toBe(cvs.payeeId);
  });

  it('refuses Ready to Assign for money going out', async () => {
    const v = await get<ActivityView>('/api/activity');
    const out = v.needsCategory.find((r) => r.amount < 0)!;
    const r = await post('/api/transactions/categorize', { keys: [out.key], categoryId: null, toRta: true });
    expect(r.status).toBe(422);
  });
});
