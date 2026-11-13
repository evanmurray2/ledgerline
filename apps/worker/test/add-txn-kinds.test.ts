// Adding a pending transaction that is a transfer, owed to you, or pays back what's owed to you, in the one Add edit.
// The transfer adds the other side as its own pending entry, paired (as D-83 does for a bank row), and each bank row
// takes its own side over. Through the real pipeline and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, OwedView } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { setup, sync, keyOf, overlay, listed, call } = bankSync('add-txn-kinds', 'b_atk', 'con_atk', 2, NOW);
const rta = async () => ((await call('GET', '/api/budget/2026-11')).json as BudgetView).rta;
const owed = async () => (await call('GET', '/api/owed')).json as OwedView;
const entries = async (account: number) => (await listed(account)).filter((r) => r.source === 'manual');
const add = (body: Record<string, unknown>) =>
  call('POST', '/api/transactions', {
    kind: 'pending',
    accountId: 'a_1',
    date: '2026-11-13',
    categoryId: null,
    repeats: 'never',
    ...body,
  });

describe('Add a pending transaction that is more than a purchase', () => {
  beforeAll(async () => {
    await setup();
    await sync([plaidTxn('pay', 1, -500, '2026-11-02', 'PAYROLL')]);
  });

  it('a transfer adds the other side, paired, and Ready to Assign doesn’t change', async () => {
    const before = await rta();
    const r = await add({ amount: -12000, payee: 'Transfer to Card 2', transferAccountId: 'a_2' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [mine] = await entries(1);
    const [other] = await entries(2);
    expect(mine).toMatchObject({ amount: -12000, status: 'pending' });
    expect(other).toMatchObject({ amount: 12000, status: 'pending' });
    expect(await overlay(mine!.key)).toMatchObject({
      transfer_state: 'paired',
      transfer_account_id: 'a_2',
      category_id: null,
    });
    expect(await overlay(other!.key)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    expect(await rta()).toBe(before);

    // Each bank row takes its own side over, and the pair stays.
    await sync([
      plaidTxn('t_out', 1, 120, '2026-11-14', 'ONLINE TRANSFER'),
      plaidTxn('t_in', 2, -120, '2026-11-14', 'PAYMENT THANK YOU'),
    ]);
    expect(await keyOf('t_out')).toBe(mine!.key);
    expect(await keyOf('t_in')).toBe(other!.key);
    expect(await entries(1)).toEqual([]);
    expect(await entries(2)).toEqual([]);
    expect(await overlay(mine!.key)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect(await rta()).toBe(before);
  });

  it('refuses a transfer to the same account', async () => {
    expect((await add({ amount: -100, payee: 'X', transferAccountId: 'a_1' })).status).toBe(422);
  });

  let itemId = '';
  it('owed to you makes the owed item with the purchase', async () => {
    const r = await add({
      amount: -8000,
      payee: 'Dinner with Sam',
      categoryId: 'dining',
      owed: { mode: 'half', expectBy: null },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const item = (await owed()).items.find((i) => i.label.startsWith('Dinner with Sam'));
    expect(item).toMatchObject({ amount: 4000, still: 4000, status: 'open' });
    itemId = item!.id;
  });

  it('refuses owed to you on money in, and paid back on money out', async () => {
    expect((await add({ amount: 100, payee: 'X', owed: { mode: 'all', expectBy: null } })).status).toBe(422);
    expect((await add({ amount: -100, payee: 'X', paysBack: [{ itemId, amount: 100 }] })).status).toBe(422);
  });

  it('refuses paying back more than is still owed, or more than came in', async () => {
    expect((await add({ amount: 9000, payee: 'Sam', paysBack: [{ itemId, amount: 5000 }] })).status).toBe(
      422,
    );
    expect((await add({ amount: 1000, payee: 'Sam', paysBack: [{ itemId, amount: 2000 }] })).status).toBe(
      422,
    );
  });

  it('paid back settles the item and puts the money in Ready to Assign', async () => {
    const before = await rta();
    const r = await add({ amount: 4000, payee: 'Sam', paysBack: [{ itemId, amount: 4000 }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await owed()).items.find((i) => i.id === itemId)).toMatchObject({
      still: 0,
      status: 'paid_back',
    });
    expect(await rta()).toBe(before + 4000);
  });

  it('refuses these on an upcoming entry', async () => {
    const r = await add({
      kind: 'upcoming',
      date: '2026-11-30',
      amount: -100,
      payee: 'X',
      transferAccountId: 'a_2',
    });
    expect(r.status).toBe(422);
  });
});
