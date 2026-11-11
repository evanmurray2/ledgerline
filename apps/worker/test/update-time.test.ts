// One time for each bank update (D-86 A1): what an update brings carries the moment its fetch finished, not the
// clock of whichever step happened to run. Plaid's sign: a positive amount is money out.
import { beforeAll, describe, expect, it } from 'vitest';
import { bankSync, pend, plaidTxn, removal } from './bank-sync.js';

// The steps run on Nov 1 in the budget's time zone; the fetches finished hours earlier, on Oct 31.
const STEP = Date.parse('2026-11-01T18:00:00Z');
const FETCHED = Date.parse('2026-11-01T05:30:00Z'); // Oct 31, 22:30 in Los Angeles
const { db, setup, sync, keyOf, overlay } = bankSync('update-time', 'b_ut', 'con_ut', 2, STEP);
const txn = (id: string) =>
  db
    .prepare(`SELECT created_at, removed_at FROM bank_txn WHERE provider_txn_id = ?1`)
    .bind(id)
    .first<{ created_at: number; removed_at: number | null }>();
const alerts = (type: string) =>
  db.prepare(`SELECT count(*) AS n FROM alert WHERE type = ?1`).bind(type).first('n');

describe('one time for each bank update', () => {
  beforeAll(setup);

  it('a row arrives at the time its update finished fetching', async () => {
    await sync(
      [plaidTxn('a1', 1, 20, '2026-10-30', 'GROCERY'), plaidTxn('a2', 2, 30, '2026-10-30', 'CAFE')],
      [],
      FETCHED,
    );
    expect((await txn('a1'))!.created_at).toBe(FETCHED);
    expect((await txn('a2'))!.created_at).toBe(FETCHED);
    // An update with no such time (from before it was recorded) uses the step's clock, as before.
    await sync([plaidTxn('old', 1, 5, '2026-10-30', 'KIOSK')]);
    expect((await txn('old'))!.created_at).toBe(STEP);
  });

  it('a row is removed at the time of the update that removed it, and its arrival stays', async () => {
    await sync([], [removal('a2', 2)], FETCHED + 60_000);
    expect(await txn('a2')).toEqual({ created_at: FETCHED, removed_at: FETCHED + 60_000 });
  });

  it('a pending row vanished at the time of the update that dropped it', async () => {
    await sync([pend('p1', 1, 12, '2026-10-31', 'DINER')], [], FETCHED + 120_000);
    const key = await keyOf('p1');
    await sync([], [removal('p1', 1)], FETCHED + 180_000);
    expect((await overlay(key))?.orphaned_at).toBe(FETCHED + 180_000);
  });

  it('"history changed" goes by the month where the budget is at the update’s time', async () => {
    // The bank re-issues a posted October row: removed, and sent again under a new id. The update was fetched on
    // Oct 31 where the budget is. October is the current month then, so no earlier month changed, though the steps
    // ran on Nov 1.
    const before = Number(await alerts('history_changed'));
    await sync([plaidTxn('a1-again', 1, 20, '2026-10-30', 'GROCERY')], [removal('a1', 1)], FETCHED + 240_000);
    expect(Number(await alerts('history_changed'))).toBe(before);
    // The same in an update fetched on Nov 1 there: October is an earlier month now.
    await sync([plaidTxn('a3', 1, 44, '2026-10-29', 'HARDWARE')], [], FETCHED + 300_000);
    await sync(
      [plaidTxn('a3-again', 1, 44, '2026-10-29', 'HARDWARE')],
      [removal('a3', 1)],
      Date.parse('2026-11-01T16:00:00Z'),
    );
    expect(Number(await alerts('history_changed'))).toBe(before + 1);
  });
});
