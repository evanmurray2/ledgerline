// "Which account got this money?" for an account whose side hasn't arrived yet (D-83): the pick adds a pending entry
// of the opposite amount there, paired with the row, and the bank's row takes it over when it comes, at the exact
// amount on a later day. Undo removes the entry. Through the real pipeline and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, keyOf, overlay, listed, call } = bankSync(
  'transfer-pending',
  'b_tpe',
  'con_tpe',
  3,
  NOW,
);
const pick = (key: string, body: unknown) =>
  call('POST', `/api/transfers/${encodeURIComponent(key)}/pick`, body);
const rta = async () => ((await call('GET', '/api/budget/2026-11')).json as BudgetView).rta;
const entries = async (account: number) => (await listed(account)).filter((r) => r.source === 'manual');

describe('Pick an account whose side hasn’t arrived yet', () => {
  let out = '';
  let entry = '';
  let before = 0;

  beforeAll(async () => {
    await setup();
    await sync([plaidTxn('pay', 1, -500, '2026-11-02', 'PAYROLL')]);
    await sync([plaidTxn('out', 1, 250, '2026-11-10', 'ONLINE TRANSFER TO SAVINGS')]);
    out = await keyOf('out');
    expect((await overlay(out))?.transfer_state).toBe('unsorted');
    before = await rta();
  });

  it('refuses the same account', async () => {
    expect((await pick(out, { otherKey: null, accountId: 'a_1' })).status).toBe(404);
  });

  it('adds a pending entry there, paired with the row', async () => {
    const r = await pick(out, { otherKey: null, accountId: 'a_2' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [e] = await entries(2);
    expect(e).toMatchObject({ status: 'pending', amount: 25000 });
    entry = e!.key;
    expect(await overlay(out)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_2' });
    expect(await overlay(entry)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    // Money moved between your accounts: no category, and Ready to Assign doesn't change.
    expect(await rta()).toBe(before);
  });

  it('the bank’s row takes the entry over, a day later', async () => {
    await sync([plaidTxn('in', 2, -250, '2026-11-11', 'DEPOSIT')]);
    expect(await keyOf('in')).toBe(entry);
    expect(await entries(2)).toEqual([]);
    expect(await overlay(entry)).toMatchObject({ transfer_state: 'paired', transfer_account_id: 'a_1' });
    expect(await rta()).toBe(before);
    // Taken over, Undo no longer removes it: both halves stay as bank rows.
  });

  it('Undo removes an entry the bank hasn’t sent yet', async () => {
    await sync([plaidTxn('out2', 1, 70, '2026-11-12', 'ONLINE TRANSFER TO SAVINGS')]);
    const k = await keyOf('out2');
    expect((await pick(k, { otherKey: null, accountId: 'a_3' })).status).toBe(200);
    const [e] = await entries(3);
    expect(e).toBeDefined();
    expect((await call('POST', `/api/transfers/${encodeURIComponent(k)}/unpair`)).status).toBe(200);
    expect(await entries(3)).toEqual([]);
    expect((await overlay(k))?.transfer_state).toBeNull();
    const deleted = await db
      .prepare(`SELECT deleted_at FROM manual_pending WHERE txn_key = ?1`)
      .bind(e!.key)
      .first<{ deleted_at: number | null }>();
    expect(deleted?.deleted_at).not.toBeNull();
  });
});
