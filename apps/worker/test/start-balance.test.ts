// Rows dated before the budget start move the starting balance (D-?): a row pending at link, a posted row the bank
// sent days later, and a link-day row already in the balance at link. Through the real sync, the phone's engine and
// its routes: the starting debt, the bank difference, rule 10, the Starting balance sheet and the read-only sheet.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView, RegisterView, TxnSheet } from '@ledgerline/contracts';
import { bankSync, pend, plaidTxn } from './bank-sync.js';
import { checkIdentityDb } from '../src/maintenance.js';

const B = 'b_start';
const C = 'c_start';
const LINK = Date.UTC(2026, 9, 1, 18, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const h = bankSync('start-balance', B, C, 1, LINK + MIN);

describe('rows before the budget start (D-?)', () => {
  beforeAll(async () => {
    await h.setup();
    // Linked on the budget start (Oct 1) owing $100.00: that balance holds the Sep 28 and Oct 1 purchases, not the
    // pending Sep 30 one or the Sep 29 one the bank sends three days later.
    await h.db.batch([
      h.db.prepare(`UPDATE connection SET linked_at = ?2 WHERE id = ?1`).bind(C, LINK),
      h.db.prepare(`UPDATE account SET starting_balance = -10000 WHERE id = 'a_1'`),
      h.db
        .prepare(
          `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, subtype, current_balance, created_at, updated_at)
           VALUES ('pa_row_1', ?1, ?2, 'pa_1', 'Card 1', 'credit', 'credit card', 10000, 0, 0)`,
        )
        .bind(B, C),
    ]);
    await h.sync([
      plaidTxn('sep28', 1, 20, '2026-09-28', 'OLD PURCHASE'),
      plaidTxn('oct1', 1, 5, '2026-10-01', 'LINK DAY COFFEE'),
      pend('sep30-p', 1, 7, '2026-09-30', 'PENDING AT LINK'),
    ]);
    h.setNow(LINK + 3 * DAY);
    await h.db.prepare(`UPDATE provider_account SET current_balance = 13700 WHERE id = 'pa_row_1'`).run();
    await h.sync([
      plaidTxn('sep29', 1, 30, '2026-09-29', 'LATE PURCHASE'),
      plaidTxn('sep30', 1, 7, '2026-09-30', 'PENDING AT LINK', { pending_transaction_id: 'sep30-p' }),
    ]);
    // The phone's full rebuild, which also writes each account's stored starting-balance line.
    await h.engine.derive();
  });

  it('the starting debt holds the late and pending-at-link rows and leaves out the link-day row', async () => {
    const debt = await h.db
      .prepare(`SELECT coalesce(sum(amount), 0) AS d FROM budget_line WHERE budget_id = ?1 AND kind = 'debt'`)
      .bind(B)
      .first<{ d: number }>();
    expect(debt!.d).toBe(10000 + 3000 + 700 - 500);
    // Only the link-day row is in a month of the budget, uncategorized; nothing from before the start is.
    expect(await h.counted(1)).toMatchObject({ spent: -500 });
  });

  it('there is no bank difference, and rule 10 holds', async () => {
    const r = await h.call('GET', '/api/accounts');
    const a = (r.json as AccountsView).groups.flatMap((g) => g.accounts).find((x) => x.id === 'a_1')!;
    expect(a.drift).toBeNull();
    expect(a.startNote).toBe('Starting debt updated: LATE PURCHASE $30.00');
    const id = await checkIdentityDb(
      { ...env, DB: h.db, FAKE_NOW: new Date(LINK + 3 * DAY).toISOString() } as never,
      B,
    );
    expect(id).toMatchObject({ ok: true });
  });

  it('the Starting debt sheet shows each step and is settling', async () => {
    const r = (await h.call('GET', '/api/accounts/a_1/register')).json as RegisterView;
    expect(r.start).toMatchObject({
      from: '2026-10-01',
      atLink: -10000,
      total: -13200,
      settling: true,
      settlesOn: '2026-10-15',
      recent: { payee: 'LATE PURCHASE', amount: -3000, date: '2026-09-29' },
    });
    expect(r.start!.rows.map((x) => [x.payee, x.amount, x.role])).toEqual([
      ['LATE PURCHASE', -3000, 'before'],
      ['PENDING AT LINK', -700, 'before'],
      ['LINK DAY COFFEE', -500, 'linkDay'],
    ]);
    // The register lists only rows in the budget.
    expect(r.days.flatMap((d) => d.rows).map((x) => x.payee)).toEqual(['LINK DAY COFFEE']);
  });

  it('a row in the starting balance is read-only and says so', async () => {
    const key = await h.keyOf('sep29');
    const sheet = (await h.call('GET', `/api/transactions/${key}`)).json as TxnSheet;
    expect(sheet.kind).toBe('history');
    expect(sheet.inStartingBalance).toBe(true);
    const old = (await h.call('GET', `/api/transactions/${await h.keyOf('sep28')}`)).json as TxnSheet;
    expect(old.inStartingBalance).toBeUndefined();
    const edit = await h.call('PATCH', `/api/transactions/${key}`, { categoryId: 'dining' });
    expect(edit.status).toBe(409);
  });

  it('after settling, a late row is history and the bank difference shows it', async () => {
    h.setNow(LINK + 20 * DAY);
    await h.db.prepare(`UPDATE provider_account SET current_balance = 14700 WHERE id = 'pa_row_1'`).run();
    await h.sync([plaidTxn('sep27', 1, 10, '2026-09-27', 'VERY LATE')]);
    await h.engine.derive();
    const r = await h.call('GET', '/api/accounts');
    const a = (r.json as AccountsView).groups.flatMap((g) => g.accounts).find((x) => x.id === 'a_1')!;
    expect(a.drift).toBe(1000);
    expect(a.startNote ?? null).toBeNull();
  });
});
