// Transfer matching looks back at rows with no partner (D-86 A2, D-90): the two sides of a transfer pair though they
// arrive in different bank updates. Plaid's sign: a positive amount is money out.
import { beforeAll, describe, expect, it } from 'vitest';
import { bankSync, plaidTxn, removal } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, keyOf, overlay, call } = bankSync('transfer-look-back', 'b_tlb', 'con_tlb', 3, NOW);
const state = async (id: string) => {
  const o = await overlay(await keyOf(id));
  return { state: o?.transfer_state ?? null, other: o?.transfer_account_id ?? null };
};

describe('transfer matching looks back', () => {
  beforeAll(setup);

  it('Monday’s outflow and Tuesday’s inflow pair, in either order of arrival', async () => {
    await sync([plaidTxn('mon', 1, 500, '2026-11-09', 'ONLINE PMT TO CARD')]);
    expect(await state('mon')).toEqual({ state: 'unsorted', other: null });
    await sync([plaidTxn('tue', 2, -500, '2026-11-10', 'PAYMENT THANK YOU')]);
    expect(await state('mon')).toEqual({ state: 'paired', other: 'a_2' });
    expect(await state('tue')).toEqual({ state: 'paired', other: 'a_1' });
    expect(await overlay(await keyOf('mon'))).toMatchObject({ categorized_by: 'auto' });

    // The inflow first: it waits with no state, then the outflow finds it.
    await sync([plaidTxn('in-first', 3, -75.5, '2026-11-08', 'DEPOSIT')]);
    expect(await state('in-first')).toEqual({ state: null, other: null });
    await sync([plaidTxn('out-later', 1, 75.5, '2026-11-10', 'ONLINE TRANSFER')]);
    expect(await state('out-later')).toEqual({ state: 'paired', other: 'a_3' });
    expect(await state('in-first')).toEqual({ state: 'paired', other: 'a_1' });
  });

  it('goes by the two dates: 5 days pairs, 6 days does not', async () => {
    await sync([plaidTxn('d0', 1, 81, '2026-11-01', 'ONLINE TRANSFER')]);
    await sync([plaidTxn('d6', 2, -81, '2026-11-07', 'DEPOSIT')]);
    expect(await state('d0')).toEqual({ state: 'unsorted', other: null });
    expect(await state('d6')).toEqual({ state: null, other: null });
    await sync([plaidTxn('d5', 3, -81, '2026-11-06', 'DEPOSIT')]);
    expect(await state('d0')).toEqual({ state: 'paired', other: 'a_3' });
    expect(await state('d5')).toEqual({ state: 'paired', other: 'a_1' });
    expect(await state('d6')).toEqual({ state: null, other: null });
  });

  it('asks when an earlier row and a new row could both be the partner', async () => {
    await sync([plaidTxn('two-a', 2, -200, '2026-11-09', 'DEPOSIT')]);
    await sync([
      plaidTxn('two-out', 1, 200, '2026-11-10', 'ONLINE TRANSFER'),
      plaidTxn('two-b', 3, -200, '2026-11-11', 'DEPOSIT'),
    ]);
    for (const id of ['two-out', 'two-a', 'two-b'])
      expect(await state(id), id).toEqual({ state: 'unsorted', other: null });
  });

  it('a pair that was made stays when a second outflow of the same amount arrives', async () => {
    await sync([plaidTxn('stay-out', 1, 320, '2026-11-09', 'ONLINE TRANSFER')]);
    await sync([plaidTxn('stay-in', 2, -320, '2026-11-10', 'DEPOSIT')]);
    await sync([plaidTxn('stay-late', 3, 320, '2026-11-11', 'ONLINE TRANSFER')]);
    expect(await state('stay-out')).toEqual({ state: 'paired', other: 'a_2' });
    expect(await state('stay-in')).toEqual({ state: 'paired', other: 'a_1' });
    expect(await state('stay-late')).toEqual({ state: 'unsorted', other: null });
  });

  it('never pairs a row the person sorted by hand', async () => {
    // "Neither" on an outflow: it is a payment that needs a category.
    await sync([plaidTxn('hand-out', 1, 45, '2026-11-09', 'ONLINE TRANSFER')]);
    const out = await keyOf('hand-out');
    const r = await call('POST', `/api/transfers/${encodeURIComponent(out)}/pick`, { otherKey: null });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await overlay(out)).toMatchObject({ transfer_state: null, categorized_by: 'user' });
    await sync([plaidTxn('hand-in', 2, -45, '2026-11-10', 'DEPOSIT')]);
    expect(await state('hand-out')).toEqual({ state: null, other: null });
    expect(await state('hand-in')).toEqual({ state: null, other: null });

    // Unpaired by hand: the two rows are not paired again, by a later update or when the bank sends one again.
    await sync([
      plaidTxn('un-out', 1, 46, '2026-11-09', 'ONLINE TRANSFER'),
      plaidTxn('un-in', 2, -46, '2026-11-09', 'DEPOSIT'),
    ]);
    expect((await state('un-out')).state).toBe('paired');
    const un = await call('POST', `/api/transfers/${encodeURIComponent(await keyOf('un-out'))}/unpair`, {});
    expect(un.status, JSON.stringify(un.json)).toBe(200);
    await sync([plaidTxn('un-in', 2, -46, '2026-11-09', 'DEPOSIT FROM CHECKING')]);
    await sync([plaidTxn('other', 3, 9, '2026-11-10', 'COFFEE')]);
    expect(await state('un-out')).toEqual({ state: null, other: null });
    expect(await state('un-in')).toEqual({ state: null, other: null });
  });

  it('does not pair rows from before the rule with each other: a pair needs a row of the new update', async () => {
    await sync([plaidTxn('old-out', 1, 990, '2026-11-03', 'ONLINE TRANSFER')]);
    await sync([plaidTxn('old-in', 2, -990, '2026-11-04', 'DEPOSIT')]);
    // As they were filed before the rule: the outflow asked about, the inflow with no state.
    for (const id of ['old-out', 'old-in'])
      await db
        .prepare(`UPDATE txn_overlay SET transfer_state = ?2, transfer_account_id = NULL WHERE txn_key = ?1`)
        .bind(await keyOf(id), id === 'old-out' ? 'unsorted' : null)
        .run();
    await sync([plaidTxn('unrelated', 3, 12, '2026-11-10', 'GROCERY')]);
    expect(await state('old-out')).toEqual({ state: 'unsorted', other: null });
    expect(await state('old-in')).toEqual({ state: null, other: null });
  });

  it('a person-to-person deposit that waited becomes the transfer’s other side', async () => {
    await sync([plaidTxn('p2p', 2, -60, '2026-11-09', 'ZELLE FROM A FRIEND')]);
    expect((await overlay(await keyOf('p2p')))?.wtm_state).toBe('waiting');
    await sync([plaidTxn('p2p-out', 1, 60, '2026-11-10', 'ONLINE TRANSFER')]);
    expect(await state('p2p')).toEqual({ state: 'paired', other: 'a_1' });
    expect((await overlay(await keyOf('p2p')))?.wtm_state).toBeNull();
  });

  it('a removed row is not a partner', async () => {
    await sync([plaidTxn('gone-out', 1, 131, '2026-11-09', 'ONLINE TRANSFER')]);
    await sync([], [removal('gone-out', 1)]);
    await sync([plaidTxn('gone-in', 2, -131, '2026-11-10', 'DEPOSIT')]);
    expect(await state('gone-in')).toEqual({ state: null, other: null });
  });
});
