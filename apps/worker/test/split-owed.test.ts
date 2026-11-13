// A split line set to "Owed to you" makes an owed item of that line's amount, as a whole purchase marked owed does.
// The sheet shows the line as owed again, and a split without it (or a category for the whole row) removes the mark.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OwedView, TxnSheet } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const patch = (body: unknown) =>
  app('/api/transactions/n-personal', { method: 'PATCH', headers: H, body: JSON.stringify(body) });
const owedFor = async () =>
  (await get<OwedView>('/api/owed')).items.filter((i) => i.txnKey === 'n-personal' && i.status === 'open');

describe('Split line owed to you', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('makes an owed item for the line, shown on the line when the split opens again', async () => {
    const out0 = (await get<OwedView>('/api/owed')).out;
    const r = await patch({
      split: [
        { categoryId: 'personal', amount: -5000, memo: null, absorbsRemainder: false },
        { categoryId: null, amount: -3500, memo: null, absorbsRemainder: true, owed: true },
      ],
    });
    expect(r.status).toBe(200);
    const items = await owedFor();
    expect(items.map((i) => i.amount)).toEqual([3500]);
    expect((await get<OwedView>('/api/owed')).out).toBe(out0 + 3500);
    const sheet = await get<TxnSheet>('/api/transactions/n-personal');
    expect(sheet.split!.map((l) => !!l.owed)).toEqual([false, true]);
    // The whole purchase isn't marked: Owed to you on the sheet stays off.
    expect(sheet.owed).toEqual([]);

    // Saved again as it is: still one item.
    expect(
      (
        await patch({
          split: sheet.split!.map((l) => ({
            categoryId: l.categoryId,
            amount: l.amount,
            memo: null,
            absorbsRemainder: l.absorbsRemainder,
            ...(l.owed ? { owed: true } : {}),
          })),
        })
      ).status,
    ).toBe(200);
    expect((await owedFor()).map((i) => i.amount)).toEqual([3500]);
  });

  it('a category for the whole row removes the line’s mark', async () => {
    expect((await patch({ categoryId: 'personal' })).status).toBe(200);
    expect(await owedFor()).toEqual([]);
  });

  it('money in can’t have a line owed to you', async () => {
    const r = await app('/api/transactions/n-venmo', {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({
        split: [{ categoryId: null, amount: 101800, memo: null, absorbsRemainder: true, owed: true }],
      }),
    });
    expect(r.status).toBe(422);
  });
});
