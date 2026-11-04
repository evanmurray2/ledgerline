// Settings → Payees: the list, rename = merge (joining) with Undo, and the rename checks (docs/payees.md 5, 6).
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MergeResult, PayeesView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const view = async () => (await (await app('/api/settings/payees')).json()) as PayeesView;
const post = (p: string, body: unknown) => app(p, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('payees', () => {
  let a: PayeesView['payees'][number];
  let b: PayeesView['payees'][number];

  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
    const v = await view();
    a = v.payees[0]!;
    b = v.payees[1]!;
  });

  it('lists payees with budget transactions, their bank names, and counts', async () => {
    const v = await view();
    expect(v.payees.length).toBeGreaterThan(2);
    for (const p of v.payees) {
      expect(p.transactions).toBeGreaterThan(0);
      expect(p.bankNames.length).toBeGreaterThan(0);
      // Bank names count budget transactions only, not history before the budget start.
      if (p.bankNames.length < 10) expect(p.bankNames.reduce((t, x) => t + x.count, 0)).toBe(p.transactions);
    }
    expect(Array.isArray(v.others)).toBe(true);
  });

  it('refuses a join that isn’t two different payees', async () => {
    expect((await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, a!.id] })).status).toBe(422);
    expect((await post('/api/settings/payees/merge', { keep: 'nope', ids: ['nope', a!.id] })).status).toBe(
      409,
    );
  });

  it('refuses a rename to another payee’s name: that is a join', async () => {
    const r = await post(`/api/settings/payees/${b!.id}`, { name: ` ${a!.name.toUpperCase()} ` });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('name_taken');
  });

  it('joins two payees and Undo puts them back', async () => {
    const r = await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, b!.id] });
    expect(r.status).toBe(200);
    const { undoId } = (await r.json()) as MergeResult;
    let v = await view();
    expect(v.payees.find((p) => p.id === b!.id)).toBeUndefined();
    expect(v.payees.find((p) => p.id === a!.id)!.transactions).toBe(a!.transactions + b!.transactions);
    // A rename queued for the joined payee is refused instead of renaming the one it joined.
    expect((await post(`/api/settings/payees/${b!.id}`, { name: 'Late rename' })).status).toBe(409);

    expect((await post(`/api/settings/payees/merge/${undoId}/undo`, {})).status).toBe(200);
    v = await view();
    expect(v.payees.find((p) => p.id === a!.id)).toMatchObject({
      name: a!.name,
      transactions: a!.transactions,
    });
    expect(v.payees.find((p) => p.id === b!.id)).toMatchObject({
      name: b!.name,
      transactions: b!.transactions,
    });
  });

  it('can’t undo a join once the payee changed since', async () => {
    const r = await post('/api/settings/payees/merge', { keep: a!.id, ids: [a!.id, b!.id] });
    const { undoId } = (await r.json()) as MergeResult;
    expect((await post(`/api/settings/payees/${a!.id}`, { name: 'Renamed after the join' })).status).toBe(
      200,
    );
    expect((await post(`/api/settings/payees/merge/${undoId}/undo`, {})).status).toBe(409);
  });
});
