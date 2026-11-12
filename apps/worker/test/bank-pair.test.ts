// Not the same on a posted row and the bank's pending row whose key it took (docs/payee-names.md 9.1, 9.3), through
// the real pipeline and the routes the phone runs: a pair the app made (D-65) or your Yes made can be undone, a pair
// the provider linked can't (D-47), and afterwards each row counts on its own and is never paired again.
import { beforeAll, describe, expect, it } from 'vitest';
import type { TxnSheet } from '@ledgerline/contracts';
import { bankSync, pend, plaidTxn, removal } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, heal, keyOf, overlay, listed, counted, asks, call } = bankSync(
  'bank-pair',
  'b_bp',
  'con_bp',
  5,
  NOW,
);
const sheet = async (key: string) =>
  (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;
const notSame = (key: string) => call('POST', `/api/transactions/${encodeURIComponent(key)}/not-same`);
const undo = (key: string) => call('POST', `/api/transactions/${encodeURIComponent(key)}/not-same/undo`);
const link = (from: string) =>
  db
    .prepare(`SELECT created_by, undone_at FROM txn_link WHERE from_key = ?1 AND kind = 'pending_match'`)
    .bind(from)
    .first<{ created_by: string; undone_at: number | null }>();

describe('Not the same on two bank rows', () => {
  beforeAll(setup);

  it('a pair the app made: undone, the pending row counts again, then goes when the bank removes it', async () => {
    await sync([pend('bb-p', 1, 12.5, '2026-11-08', 'BLUE BOTTLE', { merchant: 'Blue Bottle Coffee' })]);
    await db
      .prepare(
        `UPDATE txn_overlay SET category_id = 'dining', categorized_by = 'user', memo = 'coffee' WHERE txn_key = 'p:bb-p'`,
      )
      .run();
    // A tip, no link: the same merchant pairs them (D-65).
    await sync([
      plaidTxn('bb', 1, 14.5, '2026-11-09', 'BLUE BOTTLE COFFEE SF', {
        merchant: 'Blue Bottle Coffee',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('bb')).toBe('p:bb-p');
    expect(await link('p:bb')).toEqual({ created_by: 'auto', undone_at: null });
    expect(await counted(1)).toEqual({ spent: -1450, pending: 0 });
    expect((await sheet('p:bb-p')).pairedWith).toEqual({ label: 'Bank pending: Blue Bottle Coffee · Nov 8' });

    expect((await notSame('p:bb-p')).status).toBe(200);
    expect(await keyOf('bb')).toBe('p:bb');
    expect(await keyOf('bb-p')).toBe('p:bb-p');
    expect((await link('p:bb'))!.undone_at).toBe(NOW);
    // The pending row keeps the key and what you set on it; it shows and counts again as pending.
    expect(await overlay('p:bb-p')).toMatchObject({ category_id: 'dining', memo: 'coffee', alert: null });
    expect(await listed(1)).toEqual([
      { key: 'p:bb', source: 'bank', status: 'posted', amount: -1450 },
      { key: 'p:bb-p', source: 'bank', status: 'pending', amount: -1250 },
    ]);
    expect(await counted(1)).toEqual({ spent: -1450 - 1250, pending: -1250 });
    // The posted row is filed as a new posted row: it has a payee, and no category you didn't choose.
    const own = await overlay('p:bb');
    expect(own?.payee_id).toBeTruthy();
    expect(own?.category_id ?? null).toBeNull();
    expect((await sheet('p:bb')).pairedWith).toBeNull();
    expect(await db.prepare(`SELECT a_key, b_key FROM not_same WHERE a_key = 'p:bb'`).first()).toEqual({
      a_key: 'p:bb',
      b_key: 'p:bb-p',
    });

    // The heal step and the next syncs of either row never pair them again.
    await heal();
    await sync([pend('bb-p', 1, 12.5, '2026-11-08', 'BLUE BOTTLE', { merchant: 'Blue Bottle Coffee' })]);
    await sync([
      plaidTxn('bb', 1, 14.5, '2026-11-09', 'BLUE BOTTLE COFFEE SF', {
        merchant: 'Blue Bottle Coffee',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('bb')).toBe('p:bb');
    expect((await asks()).find((a) => a.ref_key === 'p:bb')).toBeUndefined();
    // The bank removes its pending row: only the posted charge counts.
    await sync([], [removal('bb-p', 1)]);
    expect(await listed(1)).toEqual([{ key: 'p:bb', source: 'bank', status: 'posted', amount: -1450 }]);
    expect(await counted(1)).toEqual({ spent: -1450, pending: 0 });
    await heal();
    expect(await keyOf('bb')).toBe('p:bb');
  });

  it('a pair your Yes made, after the bank removed the pending row: only the posted row counts', async () => {
    await sync([pend('su-p', 2, 40, '2026-11-10', 'SQ *SUSHI')]);
    // A tip and another Plaid name: nothing exact, so "Same purchase?" asks.
    await sync([plaidTxn('su', 2, 48, '2026-11-11', 'SUSHI BAR SF', { authorized_date: '2026-11-10' })]);
    const a = (await asks()).find((x) => x.ref_key === 'p:su')!;
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'p:su-p' })).status).toBe(
      200,
    );
    expect(await keyOf('su')).toBe('p:su-p');
    expect(await link('p:su')).toEqual({ created_by: 'user', undone_at: null });
    await sync([], [removal('su-p', 2)]);
    expect(await counted(2)).toEqual({ spent: -4800, pending: 0 });
    expect((await sheet('p:su-p')).pairedWith).toEqual({ label: 'Bank pending: SQ *SUSHI · Nov 10' });

    expect((await notSame('p:su-p')).status).toBe(200);
    expect(await keyOf('su')).toBe('p:su');
    expect(await listed(2)).toEqual([{ key: 'p:su', source: 'bank', status: 'posted', amount: -4800 }]);
    expect(await counted(2)).toEqual({ spent: -4800, pending: 0 });
    expect((await overlay('p:su'))?.payee_id).toBeTruthy();
    // The removed pending row isn't flagged as vanished: you said it was another purchase.
    expect((await overlay('p:su-p'))?.orphaned_at ?? null).toBeNull();
    await heal();
    expect(await keyOf('su')).toBe('p:su');
    expect((await asks()).find((x) => x.ref_key === 'p:su')).toBeUndefined();
  });

  it('a pair the provider linked isn’t offered, and the route refuses it', async () => {
    await sync([pend('ln-p', 3, 20, '2026-11-10', 'TAQUERIA')]);
    await sync([plaidTxn('ln', 3, 20, '2026-11-11', 'TAQUERIA SF', { pending_transaction_id: 'ln-p' })]);
    expect(await keyOf('ln')).toBe('p:ln-p');
    expect(await link('p:ln')).toEqual({ created_by: 'provider', undone_at: null });
    expect((await sheet('p:ln-p')).pairedWith).toBeNull();
    const r = await notSame('p:ln-p');
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({
      message: 'Your bank paired these two itself, so they stay one purchase.',
    });
    expect(await keyOf('ln')).toBe('p:ln-p');
    // A row on its own key isn't paired.
    expect((await notSame('p:bb')).status).toBe(422);
  });

  it('Undo pairs them again as Yes would, and forgets the No', async () => {
    await sync([pend('ud-p', 4, 30, '2026-11-08', 'RAMEN', { merchant: 'Ramen Bar' })]);
    await db
      .prepare(
        `UPDATE txn_overlay SET category_id = 'dining', categorized_by = 'user' WHERE txn_key = 'p:ud-p'`,
      )
      .run();
    await sync([
      plaidTxn('ud', 4, 35, '2026-11-09', 'RAMEN BAR SF', {
        merchant: 'Ramen Bar',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('ud')).toBe('p:ud-p');
    expect((await notSame('p:ud-p')).status).toBe(200);
    expect(await counted(4)).toEqual({ spent: -3500 - 3000, pending: -3000 });

    expect((await undo('p:ud-p')).status).toBe(200);
    expect(await keyOf('ud')).toBe('p:ud-p');
    expect(await counted(4)).toEqual({ spent: -3500, pending: 0 });
    expect(await overlay('p:ud-p')).toMatchObject({ category_id: 'dining' });
    expect(
      await db
        .prepare(
          `SELECT created_by FROM txn_link WHERE from_key = 'p:ud' AND kind = 'pending_match' AND undone_at IS NULL`,
        )
        .all(),
    ).toMatchObject({ results: [{ created_by: 'user' }] });
    expect(await db.prepare(`SELECT 1 FROM not_same WHERE a_key = 'p:ud'`).first()).toBeNull();
    expect((await sheet('p:ud-p')).pairedWith).toEqual({ label: 'Bank pending: Ramen Bar · Nov 8' });
    // A second Undo changes nothing; the heal step and the next sync keep the pair.
    expect((await undo('p:ud-p')).status).toBe(200);
    await heal();
    await sync([
      plaidTxn('ud', 4, 35, '2026-11-09', 'RAMEN BAR SF', {
        merchant: 'Ramen Bar',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('ud')).toBe('p:ud-p');
    expect(await counted(4)).toEqual({ spent: -3500, pending: 0 });
    // Not the same works again after an Undo.
    expect((await notSame('p:ud-p')).status).toBe(200);
    expect(await keyOf('ud')).toBe('p:ud');
  });

  it('Undo after the bank removed the pending row: the posted row takes its key again', async () => {
    await sync([pend('ur-p', 5, 40, '2026-11-10', 'SQ *POKE')]);
    await sync([plaidTxn('ur', 5, 48, '2026-11-11', 'POKE BOWL SF', { authorized_date: '2026-11-10' })]);
    const a = (await asks()).find((x) => x.ref_key === 'p:ur')!;
    await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'p:ur-p' });
    await sync([], [removal('ur-p', 5)]);
    expect((await notSame('p:ur-p')).status).toBe(200);
    expect(await keyOf('ur')).toBe('p:ur');
    expect((await undo('p:ur-p')).status).toBe(200);
    expect(await keyOf('ur')).toBe('p:ur-p');
    expect(await counted(5)).toEqual({ spent: -4800, pending: 0 });
    expect((await overlay('p:ur-p'))?.orphaned_at ?? null).toBeNull();
  });

  it('Undo refuses a row that was never said Not the same', async () => {
    expect((await undo('p:ln-p')).status).toBe(404);
  });
});
