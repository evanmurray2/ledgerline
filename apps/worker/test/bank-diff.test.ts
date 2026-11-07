// Pending the bank already counts, and the bank difference that waits a day (D-68): the bank's balance can move
// before Plaid sends the row. Through the real sync, the sync's finalize mark and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountRow, AccountsView } from '@ledgerline/contracts';
import { bankDiff } from '../src/ledger/bank-diff.js';
import { markDrift } from '../src/sync/process.js';
import { cards } from '../src/views/common.js';
import { Scoped } from '../src/db/scoped.js';
import { workOut } from './work-out.js';
import { bankSync, plaidTxn } from './bank-sync.js';

describe('bankDiff', () => {
  it('no difference: nothing in the bank, nothing left', () => {
    expect(bankDiff(-5000, -5000, -1500)).toEqual({ inBank: 0, left: 0 });
  });
  it('the bank took in all of the pending: it counts once, nothing left', () => {
    expect(bankDiff(-6500, -5000, -1500)).toEqual({ inBank: -1500, left: 0 });
  });
  it('several pending rows, the bank took in one of them', () => {
    expect(bankDiff(-5500, -5000, -1500)).toEqual({ inBank: -500, left: 0 });
  });
  it('more than the pending: the rest is the difference', () => {
    expect(bankDiff(-7000, -5000, -1500)).toEqual({ inBank: -1500, left: -500 });
  });
  it('a difference the other way is never explained by pending charges', () => {
    expect(bankDiff(-4000, -5000, -1500)).toEqual({ inBank: 0, left: 1000 });
    expect(bankDiff(-6000, -5000, 0)).toEqual({ inBank: 0, left: -1000 });
  });
  it('a pending deposit the bank already counts', () => {
    expect(bankDiff(12000, 10000, 2000)).toEqual({ inBank: 2000, left: 0 });
  });
});

const NOW = Date.parse('2026-11-14T20:00:00Z');
const HOUR = 3_600_000;
const B = 'b_bd';
const C = 'con_bd';
const h = bankSync('bank-diff', B, C, 1, NOW);

const card = async (): Promise<AccountRow> =>
  ((await h.call('GET', '/api/accounts')).json as AccountsView).groups
    .flatMap((g) => g.accounts)
    .find((x) => x.id === 'a_1')!;
/** The card's working debt, as its payment category reads it (rule 7). */
const cardDebt = async () =>
  (await cards(new Scoped(h.db, B, 'system'), '2026-11-15', undefined, NOW + 25 * HOUR))[0]!.working;
const since = async () =>
  (await h.db.prepare(`SELECT drift_since FROM provider_account WHERE id = 'pa_row_bd'`).first<{
    drift_since: number | null;
  }>())!.drift_since;

describe('the bank balance moves before the row arrives (D-68)', () => {
  beforeAll(async () => {
    await h.setup();
    await h.db
      .prepare(
        `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, subtype, current_balance, created_at, updated_at)
         VALUES ('pa_row_bd', ?1, ?2, 'pa_1', 'Card 1', 'credit', 'credit card', 2000, 0, 0)`,
      )
      .bind(B, C)
      .run();
    await h.sync([plaidTxn('t1', 1, 20, '2026-11-10', 'BOOKS')]);
  });

  it('no difference: nothing shows and nothing is marked', async () => {
    await markDrift(h.db, B, C, NOW);
    expect(await since()).toBeNull();
    expect(await card()).toMatchObject({ bank: 2000, working: 2000, drift: null, pendingInBank: 0 });
  });

  it('the bank owes $15 more before the row arrives: marked, but not shown for a day', async () => {
    await h.db.prepare(`UPDATE provider_account SET current_balance = 3500 WHERE id = 'pa_row_bd'`).run();
    await markDrift(h.db, B, C, NOW);
    expect(await since()).toBe(NOW);
    expect(await card()).toMatchObject({ bank: 3500, working: 3500, drift: null, pendingInBank: 0 });
    // A later sync keeps when it began.
    await markDrift(h.db, B, C, NOW + 2 * HOUR);
    expect(await since()).toBe(NOW);
  });

  it('after a day the difference shows', async () => {
    h.setNow(NOW + 25 * HOUR);
    expect((await card()).drift).toBe(1500);
  });

  it('your entry for it counts once: working stays the bank figure and the difference goes', async () => {
    await h.db.batch([
      h.db
        .prepare(
          `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
           VALUES ('m:gas', ?1, 'm:gas', 'a_1', 'pending', '2026-11-14', -1500, 'Gas', 0, 0)`,
        )
        .bind(B),
    ]);
    await workOut(h.db, B, NOW + 25 * HOUR);
    expect(await card()).toMatchObject({
      bank: 3500,
      pending: 1500,
      working: 3500,
      drift: null,
      pendingInBank: 1500,
    });
    // The payment category counts it once too.
    expect(await cardDebt()).toBe(3500);
    await markDrift(h.db, B, C, NOW + 25 * HOUR);
    expect(await since()).toBeNull();
  });

  it('a second entry the bank has not taken in yet counts on top', async () => {
    await h.db
      .prepare(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
         VALUES ('m:cafe', ?1, 'm:cafe', 'a_1', 'pending', '2026-11-14', -400, 'Cafe', 0, 0)`,
      )
      .bind(B)
      .run();
    await workOut(h.db, B, NOW + 25 * HOUR);
    expect(await card()).toMatchObject({ pending: 1900, working: 3900, drift: null, pendingInBank: 1500 });
    expect(await cardDebt()).toBe(3900);
  });
});
