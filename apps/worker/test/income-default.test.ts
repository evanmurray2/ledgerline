// Money into checking or savings goes to Ready to Assign with nothing chosen (D-85): it never waits in Needs category.
// A credit on a card still does, and so does a deposit that looks like a transfer with no other side yet. Through
// the real pipeline and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, BudgetView, TxnSheet } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, keyOf, overlay, call } = bankSync('income-default', 'b_id', 'con_id', 2, NOW);
const rta = async () => ((await call('GET', '/api/budget/2026-11')).json as BudgetView).rta;
const needs = async () =>
  ((await call('GET', '/api/activity?month=2026-11')).json as ActivityView).needsCategory.map((r) => r.key);
const sheet = async (key: string) =>
  (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;

describe('A deposit with no category', () => {
  let pay = '';
  let credit = '';
  let xfer = '';
  let before = 0;

  beforeAll(async () => {
    await setup();
    await db.prepare(`UPDATE account SET kind = 'checking', name = 'Checking' WHERE id = 'a_1'`).run();
    before = await rta();
    await sync([
      plaidTxn('pay', 1, -500, '2026-11-02', 'ACME PAYROLL'),
      plaidTxn('cr', 2, -40, '2026-11-03', 'STATEMENT CREDIT'),
      plaidTxn('xf', 1, -300, '2026-11-04', 'ONLINE TRANSFER FROM SAVINGS'),
    ]);
    xfer = await keyOf('xf');
    pay = await keyOf('pay');
    credit = await keyOf('cr');
  });

  it('is in Ready to Assign and nothing asks for a category', async () => {
    expect((await overlay(pay))?.to_rta ?? 0).toBe(0);
    expect(await rta()).toBe(before + 50000);
    expect(await needs()).not.toContain(pay);
    const s = await sheet(pay);
    expect(s.kind).toBe('income');
    expect(s.categoryLabel).toBe('Ready to Assign');
    const reg = (await call('GET', '/api/accounts/a_1/register?show=needs')).json as {
      days: { rows: { key: string }[] }[];
    };
    expect(reg.days.flatMap((d) => d.rows.map((r) => r.key))).not.toContain(pay);
  });

  it('a credit on a card still needs a category', async () => {
    expect(await needs()).toContain(credit);
    expect((await sheet(credit)).categoryLabel).toBeNull();
  });

  it('a deposit that looks like a transfer, with no other side yet, waits in Needs category', async () => {
    expect((await overlay(xfer))?.transfer_state ?? null).toBeNull();
    expect(await needs()).toContain(xfer);
    expect((await sheet(xfer)).categoryLabel).toBeNull();
    // Not in Ready to Assign: only the payroll is.
    expect(await rta()).toBe(before + 50000);
  });

  it('takes a category you choose, and goes back to Ready to Assign when you clear it', async () => {
    const patch = (body: unknown) => call('PATCH', `/api/transactions/${encodeURIComponent(pay)}`, body);
    expect((await patch({ categoryId: 'dining' })).status).toBe(200);
    expect(await rta()).toBe(before);
    expect((await sheet(pay)).categoryLabel).toBe('Dining out');
    expect((await patch({ categoryId: null })).status).toBe(200);
    expect(await rta()).toBe(before + 50000);
    expect(await needs()).not.toContain(pay);
  });
});
