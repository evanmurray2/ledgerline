// "It's a transfer…" on a row that filing never asked about: money in whose name doesn't look like a transfer. It can
// still be paired with another account or sent to an account that isn't linked; "It was income" has no question to
// answer there. Through the real pipeline and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TxnSheet } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { setup, sync, keyOf, overlay, listed, call } = bankSync(
  'transfer-by-hand',
  'b_tbh',
  'con_tbh',
  2,
  NOW,
);
const pick = (key: string, body: unknown) =>
  call('POST', `/api/transfers/${encodeURIComponent(key)}/pick`, body);
const sheet = async (key: string) =>
  (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;

describe('Call any row a transfer', () => {
  let key = '';

  beforeAll(async () => {
    await setup();
    await sync([plaidTxn('in', 1, -250, '2026-11-10', 'DEPOSIT 4471')]);
    key = await keyOf('in');
    expect((await overlay(key))?.transfer_state ?? null).toBeNull();
  });

  it('refuses "It was income": nothing was asked', async () => {
    expect((await pick(key, { otherKey: null })).status).toBe(422);
  });

  it('pairs it with an account whose side hasn’t arrived', async () => {
    const r = await pick(key, { otherKey: null, accountId: 'a_2' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await overlay(key)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect((await listed(2)).filter((x) => x.source === 'manual')).toMatchObject([{ amount: -25000 }]);
    expect((await sheet(key)).kind).toBe('transfer');
  });

  it('Undo puts it back', async () => {
    expect((await call('POST', `/api/transfers/${encodeURIComponent(key)}/unpair`)).status).toBe(200);
    expect((await overlay(key))?.transfer_state).toBeNull();
    expect((await listed(2)).filter((x) => x.source === 'manual')).toEqual([]);
  });

  it('marks it as a transfer from an account that isn’t linked', async () => {
    const r = await pick(key, { otherKey: null, unlinked: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await overlay(key))?.transfer_state).toBe('manual');
    expect((await sheet(key)).categoryLabel).toBe('Transfer');
  });

  it('refuses a row that is a transfer already', async () => {
    expect((await pick(key, { otherKey: null, unlinked: true })).status).toBe(422);
  });
});
