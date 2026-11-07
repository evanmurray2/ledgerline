// Your entry and the bank's rows (docs/payee-names.md 9.1, 9.2), through the real pipeline in every order a bank
// sends them: your entry covers the bank's pending row, the posted charge takes the entry's key, and each charge
// counts once at every step. "Same purchase?" with Yes and No, and Not the same, through the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, TxnSheet } from '@ledgerline/contracts';
import { workOut } from './work-out.js';
import { bankSync, pend, plaidTxn, removal } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const B = 'b_ec';
const { db, setup, sync, heal, keyOf, overlay, listed, counted, asks, call } = bankSync(
  'entry-covers',
  B,
  'con_ec',
  14,
  NOW,
);

/** Your entry (Add pending), with a category you chose. */
async function entry(key: string, account: number, amount: number, date: string, name: string) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
         VALUES (?1, ?2, ?1, ?3, 'pending', ?4, ?5, ?6, 0, 0)`,
      )
      .bind(key, B, `a_${account}`, date, amount, name),
    db
      .prepare(
        `INSERT INTO txn_overlay (txn_key, budget_id, category_id, categorized_by, memo, created_at, updated_at) VALUES (?1, ?2, 'dining', 'user', 'mine', 0, 0)`,
      )
      .bind(key, B),
  ]);
  await workOut(db, B, NOW);
}

const mp = (key: string) =>
  db
    .prepare(`SELECT matched_txn_key, covers_provider_txn_id FROM manual_pending WHERE txn_key = ?1`)
    .bind(key)
    .first<{ matched_txn_key: string | null; covers_provider_txn_id: string | null }>();

describe('your entry and the bank’s rows', () => {
  beforeAll(setup);

  it('entry, then the bank’s pending row, then the posted row with the link: counted once at every step', async () => {
    await entry('m:jb', 1, -4000, '2026-11-08', 'Junebug');
    expect(await counted(1)).toEqual({ spent: -4000, pending: -4000 });
    // The bank's pending row has your typed name as Plaid's name: exact evidence, so the entry covers it.
    await sync([pend('jb-p', 1, 35.75, '2026-11-08', 'Junebug')]);
    expect((await mp('m:jb'))!.covers_provider_txn_id).toBe('jb-p');
    expect(await listed(1)).toEqual([{ key: 'm:jb', source: 'manual', status: 'pending', amount: -4000 }]);
    expect(await counted(1)).toEqual({ spent: -4000, pending: -4000 });
    // The covered row's overlay is untouched (no key moved, no estimate, nothing inherited).
    expect((await overlay('p:jb-p'))?.estimated_amount ?? null).toBeNull();
    await sync([plaidTxn('jb', 1, 42.75, '2026-11-10', 'TST*JUNEBUG', { pending_transaction_id: 'jb-p' })]);
    expect(await keyOf('jb')).toBe('m:jb');
    expect(await keyOf('jb-p')).toBe('m:jb');
    expect((await mp('m:jb'))!.matched_txn_key).toBe('m:jb');
    expect(await listed(1)).toEqual([{ key: 'm:jb', source: 'bank', status: 'posted', amount: -4275 }]);
    expect(await counted(1)).toEqual({ spent: -4275, pending: 0 });
    // Your category and memo on the entry carry over to the posted charge.
    expect(await overlay('m:jb')).toMatchObject({ category_id: 'dining', memo: 'mine' });
  });

  it('entry, pending row on the same amount and day, posted row without a link', async () => {
    await entry('m:cafe', 2, -1250, '2026-11-09', 'Coffee with Sam');
    await sync([pend('cafe-p', 2, 12.5, '2026-11-09', 'SQ *BLUE BOTTLE')]);
    expect((await mp('m:cafe'))!.covers_provider_txn_id).toBe('cafe-p');
    expect(await counted(2)).toEqual({ spent: -1250, pending: -1250 });
    // The posted row claims the pending row (D-47) and so takes the covering entry's key.
    await sync([
      plaidTxn('cafe', 2, 12.5, '2026-11-10', 'SQ *BLUE BOTTLE', { authorized_date: '2026-11-09' }),
    ]);
    expect(await keyOf('cafe')).toBe('m:cafe');
    expect(await listed(2)).toEqual([{ key: 'm:cafe', source: 'bank', status: 'posted', amount: -1250 }]);
    expect(await counted(2)).toEqual({ spent: -1250, pending: 0 });
  });

  it('entry, then a posted row with no pending row: pairs on your typed name', async () => {
    await entry('m:tj', 3, -6000, '2026-11-12', 'Trader Joe’s');
    await sync([plaidTxn('tj', 3, 64.22, '2026-11-13', 'TRADER JOE S #123', { merchant: "Trader Joe's" })]);
    expect(await keyOf('tj')).toBe('m:tj');
    expect(await counted(3)).toEqual({ spent: -6422, pending: 0 });
  });

  it('a bill you add after its posted row arrived, dated two days later: the heal step asks (D-72)', async () => {
    await sync([
      plaidTxn('cw', 14, 44.99, '2026-11-04', 'CALWATER SERVICE 866-734-0743 CA', {
        merchant: 'Calwater Service',
        payment_channel: 'other',
      }),
    ]);
    await entry('m:cw', 14, -4499, '2026-11-06', 'Calwater');
    // Nothing new from the bank: the heal step after the next sync meets the posted row with your entry.
    expect((await heal()).changed).toBe(true);
    const a = (await asks()).find((x) => x.ref_key === 'p:cw')!;
    expect(JSON.parse(a.data)).toEqual({ candidates: ['m:cw'] });
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'm:cw' })).status).toBe(
      200,
    );
    expect(await keyOf('cw')).toBe('m:cw');
    expect(await counted(14)).toEqual({ spent: -4499, pending: 0 });
    // Asked once: healing again writes nothing.
    expect((await heal()).changed).toBe(false);
  });

  it('a close amount alone no longer pairs an entry with a posted row: "Same purchase?" asks', async () => {
    await entry('m:close', 4, -3000, '2026-11-11', 'Lunch');
    await sync([plaidTxn('close', 4, 31, '2026-11-12', 'SQ *PANINI PLACE')]);
    expect(await keyOf('close')).toBe('p:close');
    // Until you answer, both count.
    expect(await counted(4)).toEqual({ spent: -6100, pending: -3000 });
    const a = (await asks()).find((x) => x.ref_key === 'p:close')!;
    expect(JSON.parse(a.data)).toEqual({ candidates: ['m:close'] });
    const view = (await call('GET', '/api/activity?filter=attention')).json as ActivityView;
    const card = view.samePurchase.find((x) => x.id === a.id)!;
    expect(card.row.key).toBe('p:close');
    expect(card.candidates.map((x) => x.key)).toEqual(['m:close']);
    // Yes pairs them as an automatic pair would: the posted row takes the entry's key.
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'm:close' })).status).toBe(
      200,
    );
    expect(await keyOf('close')).toBe('m:close');
    expect(await counted(4)).toEqual({ spent: -3100, pending: 0 });
    expect(((await call('GET', '/api/activity?filter=attention')).json as ActivityView).samePurchase).toEqual(
      [],
    );
    // Not the same undoes it: each row has its own key again, both count, and it's never asked again.
    const sheet = (await call('GET', '/api/transactions/m%3Aclose')).json as TxnSheet;
    expect(sheet.pairedWith).toEqual({ label: 'Your entry: Lunch · Nov 11' });
    expect((await call('POST', '/api/transactions/m%3Aclose/not-same')).status).toBe(200);
    expect(await keyOf('close')).toBe('p:close');
    expect((await mp('m:close'))!.matched_txn_key).toBeNull();
    expect(await counted(4)).toEqual({ spent: -6100, pending: -3000 });
    expect(await db.prepare(`SELECT a_key, b_key FROM not_same WHERE a_key = 'm:close'`).all()).toMatchObject(
      { results: [{ a_key: 'm:close', b_key: 'p:close' }] },
    );
  });

  it('the bank removes the covered row before posting: the entry still counts; the posted row still pairs', async () => {
    await entry('m:rm', 5, -2000, '2026-11-08', 'Shop B');
    await sync([pend('rm-p', 5, 20, '2026-11-08', 'Shop B')]);
    expect((await mp('m:rm'))!.covers_provider_txn_id).toBe('rm-p');
    await sync([], [removal('rm-p', 5)]);
    expect(await listed(5)).toEqual([{ key: 'm:rm', source: 'manual', status: 'pending', amount: -2000 }]);
    expect(await counted(5)).toEqual({ spent: -2000, pending: -2000 });
    // Nothing vanished: the entry still counts for it.
    expect((await overlay('p:rm-p'))?.orphaned_at ?? null).toBeNull();
    await sync([plaidTxn('rm', 5, 20, '2026-11-10', 'Shop B', { authorized_date: '2026-11-08' })]);
    expect(await keyOf('rm')).toBe('m:rm');
    expect(await counted(5)).toEqual({ spent: -2000, pending: 0 });
  });

  it('a new pending id after an amount change: the entry covers the new one', async () => {
    await entry('m:tip', 6, -5000, '2026-11-08', 'Cafe Lafitte');
    await sync([pend('tip-p1', 6, 50, '2026-11-08', 'CAFE LAFITTE')]);
    expect((await mp('m:tip'))!.covers_provider_txn_id).toBe('tip-p1');
    await sync([pend('tip-p2', 6, 58, '2026-11-09', 'CAFE LAFITTE')], [removal('tip-p1', 6)]);
    expect((await mp('m:tip'))!.covers_provider_txn_id).toBe('tip-p2');
    expect(await listed(6)).toEqual([{ key: 'm:tip', source: 'manual', status: 'pending', amount: -5000 }]);
    expect(await counted(6)).toEqual({ spent: -5000, pending: -5000 });
  });

  it('a leftover entry never takes a posted row whose pending row still counts', async () => {
    // A second entry for the same charge, with nothing exact: it's asked about, not paired.
    await entry('m:left', 7, -2300, '2026-11-09', 'Bar tab');
    await sync([pend('bar-p', 7, 23.5, '2026-11-08', 'CAFE DU MONDE', { merchant: 'Cafe du Monde' })]);
    expect((await mp('m:left'))!.covers_provider_txn_id).toBeNull();
    expect((await asks()).find((x) => x.ref_key === 'p:bar-p')).toBeTruthy();
    // The posted row tries the bank pending row first.
    await sync([
      plaidTxn('bar', 7, 28.5, '2026-11-10', 'CAFE DU MONDE NEW ORLEANS', {
        merchant: 'Cafe du Monde',
        authorized_date: '2026-11-08',
      }),
    ]);
    expect(await keyOf('bar')).toBe('p:bar-p');
    expect((await mp('m:left'))!.matched_txn_key).toBeNull();
    // The leftover entry counts on its own (you can delete it); the charge counts once.
    expect(await counted(7)).toEqual({ spent: -2850 - 2300, pending: -2300 });
  });

  it('what you set on the bank’s pending row before your entry covered it is never lost', async () => {
    await sync([pend('ed-p', 8, 19, '2026-11-09', 'HEARD DAT')]);
    await db
      .prepare(
        `UPDATE txn_overlay SET budget_month = '2026-12', memo = 'set on the bank row' WHERE txn_key = 'p:ed-p'`,
      )
      .run();
    // The entry comes later (no category on it): the next sync's heal step covers the row.
    await db.batch([
      db
        .prepare(
          `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
           VALUES ('m:ed', ?1, 'm:ed', 'a_8', 'pending', '2026-11-09', -1900, 'Dinner', 0, 0)`,
        )
        .bind(B),
    ]);
    expect(await heal()).toEqual({ changed: true });
    expect((await mp('m:ed'))!.covers_provider_txn_id).toBe('ed-p');
    expect(await counted(8)).toEqual({ spent: -1900, pending: -1900 });
    await db
      .prepare(
        `UPDATE txn_overlay SET category_id = 'dining', categorized_by = 'user' WHERE txn_key = 'p:ed-p'`,
      )
      .run();
    await sync([plaidTxn('ed', 8, 19, '2026-11-11', 'HEARD DAT', { pending_transaction_id: 'ed-p' })]);
    expect(await keyOf('ed')).toBe('m:ed');
    // The entry had none of these: the bank row's category and memo fill in.
    expect(await overlay('m:ed')).toMatchObject({
      category_id: 'dining',
      memo: 'set on the bank row',
      budget_month: '2026-12',
    });
    // Not the same gives each row its own key back; the bank row's own overlay is still there.
    expect((await call('POST', '/api/transactions/m%3Aed/not-same')).status).toBe(200);
    expect(await keyOf('ed-p')).toBe('p:ed-p');
    expect(await overlay('p:ed-p')).toMatchObject({ category_id: 'dining', memo: 'set on the bank row' });
  });

  it('No remembers the pair: never asked again, never covered', async () => {
    await entry('m:no', 9, -1800, '2026-11-10', 'Pizza');
    await sync([pend('no-p', 9, 19.5, '2026-11-10', 'SLICE PLACE')]);
    const a = (await asks()).find((x) => x.ref_key === 'p:no-p')!;
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'no', key: 'm:no' })).status).toBe(
      200,
    );
    expect((await asks()).find((x) => x.ref_key === 'p:no-p')).toBeUndefined();
    expect(await heal()).toBeTruthy();
    expect((await asks()).find((x) => x.ref_key === 'p:no-p')).toBeUndefined();
    expect((await mp('m:no'))!.covers_provider_txn_id).toBeNull();
    expect(await counted(9)).toEqual({ spent: -1800 - 1950, pending: -1800 - 1950 });
  });

  it('Yes covers the pending row; Not the same on your entry ends the cover and remembers No', async () => {
    await entry('m:yes', 10, -2500, '2026-11-11', 'Groceries run');
    await sync([pend('yes-p', 10, 27.1, '2026-11-11', 'WHOLEFDS MKT')]);
    const a = (await asks()).find((x) => x.ref_key === 'p:yes-p')!;
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'm:yes' })).status).toBe(
      200,
    );
    expect((await mp('m:yes'))!.covers_provider_txn_id).toBe('yes-p');
    expect(await counted(10)).toEqual({ spent: -2500, pending: -2500 });
    const sheet = (await call('GET', '/api/transactions/m%3Ayes')).json as TxnSheet;
    expect(sheet.pairedWith?.label).toMatch(/^Bank pending: WHOLEFDS MKT/);
    expect((await call('POST', '/api/transactions/m%3Ayes/not-same')).status).toBe(200);
    expect((await mp('m:yes'))!.covers_provider_txn_id).toBeNull();
    expect(await counted(10)).toEqual({ spent: -2500 - 2710, pending: -2500 - 2710 });
    await heal();
    expect((await mp('m:yes'))!.covers_provider_txn_id).toBeNull();
    expect((await asks()).find((x) => x.ref_key === 'p:yes-p')).toBeUndefined();
  });

  it('an entry deleted, or edited so it no longer fits, ends its cover', async () => {
    await entry('m:del', 11, -1000, '2026-11-12', 'Tacos');
    await entry('m:amt', 12, -1500, '2026-11-12', 'Burgers');
    await sync([
      pend('del-p', 11, 10, '2026-11-12', 'Tacos'),
      pend('amt-p', 12, 15, '2026-11-12', 'Burgers'),
    ]);
    expect((await mp('m:del'))!.covers_provider_txn_id).toBe('del-p');
    expect((await mp('m:amt'))!.covers_provider_txn_id).toBe('amt-p');
    expect((await call('DELETE', '/api/transactions/m%3Adel')).status).toBe(200);
    expect((await mp('m:del'))!.covers_provider_txn_id).toBeNull();
    expect(await counted(11)).toEqual({ spent: -1000, pending: -1000 });
    // Within tolerance it still fits; far off, the bank row counts again.
    await call('PATCH', '/api/transactions/m%3Aamt', { amount: -1700 });
    expect((await mp('m:amt'))!.covers_provider_txn_id).toBe('amt-p');
    await call('PATCH', '/api/transactions/m%3Aamt', { amount: -9000 });
    expect((await mp('m:amt'))!.covers_provider_txn_id).toBeNull();
    expect(await counted(12)).toEqual({ spent: -9000 - 1500, pending: -9000 - 1500 });
  });
  it('a posted row without exact evidence for the covered pending row: asked about your entry; Yes pairs, once', async () => {
    await entry('m:sq', 13, -4000, '2026-11-10', 'Sushi');
    await sync([pend('sq-p', 13, 40, '2026-11-10', 'Sushi')]);
    expect((await mp('m:sq'))!.covers_provider_txn_id).toBe('sq-p');
    // A tip, and another Plaid name on the posted row: nothing exact with the pending row or with your entry.
    await sync([plaidTxn('sq', 13, 48, '2026-11-11', 'SQ *SUSHI BAR', { authorized_date: '2026-11-10' })]);
    expect(await keyOf('sq')).toBe('p:sq');
    expect(await counted(13)).toEqual({ spent: -4000 - 4800, pending: -4000 });
    // The covered pending row is hidden, so the question names your entry instead.
    const a = (await asks()).find((x) => x.ref_key === 'p:sq')!;
    expect(JSON.parse(a.data)).toEqual({ candidates: ['m:sq'] });
    const view = (await call('GET', '/api/activity?filter=attention')).json as ActivityView;
    expect(view.samePurchase.find((x) => x.id === a.id)!.candidates.map((x) => x.key)).toEqual(['m:sq']);
    expect((await call('POST', `/api/same-purchase/${a.id}`, { answer: 'yes', key: 'm:sq' })).status).toBe(
      200,
    );
    await workOut(db, B, NOW);
    expect(await keyOf('sq')).toBe('m:sq');
    expect(await keyOf('sq-p')).toBe('m:sq');
    expect(await listed(13)).toEqual([{ key: 'm:sq', source: 'bank', status: 'posted', amount: -4800 }]);
    expect(await counted(13)).toEqual({ spent: -4800, pending: 0 });
  });
});
