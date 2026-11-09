// A transfer out with no deposit in any linked account (to Venmo, say): "Which account got this money?" can say "An
// account that isn't linked", which takes the money out of Ready to Assign with no category (D-20). Through the real
// pipeline and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, BudgetView, TxnSheet } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { setup, sync, keyOf, overlay, call } = bankSync('transfer-unlinked', 'b_tu', 'con_tu', 2, NOW);
const rta = async () => ((await call('GET', '/api/budget/2026-11')).json as BudgetView).rta;
const toSort = async () =>
  ((await call('GET', '/api/activity?month=2026-11')).json as ActivityView).transfersToSort.map((r) => r.key);

describe('Transfer to an account that isn’t linked', () => {
  let key = '';
  let before = 0;

  beforeAll(async () => {
    await setup();
    await sync([plaidTxn('in', 1, -500, '2026-11-02', 'PAYROLL')]);
    before = await rta();
    // No linked account got $250 within 5 days, so you're asked.
    await sync([plaidTxn('v', 1, 250, '2026-11-10', 'ONLINE TRANSFER TO VENMO')]);
    key = await keyOf('v');
    expect((await overlay(key))?.transfer_state).toBe('unsorted');
  });

  it('is held aside until you pick', async () => {
    expect(await toSort()).toContain(key);
    expect(await rta()).toBe(before);
  });

  it('marks it as a transfer out of Ready to Assign', async () => {
    const r = await call('POST', `/api/transfers/${encodeURIComponent(key)}/pick`, {
      otherKey: null,
      unlinked: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await overlay(key))?.transfer_state).toBe('manual');
    expect(await rta()).toBe(before - 25000);
    expect(await toSort()).not.toContain(key);
    const t = (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;
    expect(t.categoryLabel).toBe('Transfer');
  });

  it('Undo puts it back as spending that needs a category', async () => {
    expect((await call('POST', `/api/transfers/${encodeURIComponent(key)}/unpair`)).status).toBe(200);
    expect((await overlay(key))?.transfer_state).toBeNull();
    const t = (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;
    expect(t.categoryLabel).toBeNull();
  });
});
