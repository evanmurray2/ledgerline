// Check these and Check not cleared: Accept a bank row that cleared at another amount (with Undo), and a new date
// for an entry you added. Through the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, TxnSheet } from '@ledgerline/contracts';
import { bankSync, plaidTxn } from './bank-sync.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const { db, setup, sync, keyOf, call } = bankSync('entry-edits', 'b_ee', 'con_ee', 1, NOW);
const checkThese = async () =>
  ((await call('GET', '/api/activity?filter=attention')).json as ActivityView).checkThese;
const sheet = async (key: string) =>
  (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as TxnSheet;
const add = (body: Record<string, unknown>) =>
  call('POST', '/api/transactions', {
    kind: 'pending',
    accountId: 'a_1',
    date: '2026-11-10',
    amount: -4200,
    payee: 'Check #77',
    categoryId: null,
    repeats: 'never',
    ...body,
  });
const entry = async (payee: string) =>
  (await db
    .prepare(`SELECT txn_key, date FROM manual_pending WHERE payee_name = ?1 AND deleted_at IS NULL`)
    .bind(payee)
    .first<{ txn_key: string; date: string }>())!;

describe('Accept a changed amount', () => {
  let key: string;
  beforeAll(async () => {
    await setup();
    await sync([plaidTxn('cafe', 1, 28.1, '2026-11-12', 'CORNER CAFE')]);
    key = await keyOf('cafe');
    // As pairing leaves it when the posted amount isn't your estimate (sync/pairing.ts).
    await db
      .prepare(
        `INSERT INTO txn_overlay (txn_key, budget_id, alert, created_at, updated_at) VALUES (?1, 'b_ee', ?2, 1, 1)
         ON CONFLICT (txn_key) DO UPDATE SET alert = excluded.alert`,
      )
      .bind(key, JSON.stringify(['amount_changed:-2400:-2810']))
      .run();
  });

  it('Check these asks to accept it; accepting changes no money, and Undo asks again', async () => {
    const row = (await checkThese()).find((r) => r.key === key);
    expect(row).toMatchObject({ action: 'accept', amount: -2810, badge: 'Cleared $4.10 higher' });
    const before = (await sheet(key)).amount;
    expect((await call('POST', `/api/transactions/${encodeURIComponent(key)}/review`, {})).status).toBe(200);
    expect((await checkThese()).map((r) => r.key)).not.toContain(key);
    expect((await sheet(key)).amount).toBe(before);
    expect((await call('POST', `/api/transactions/${encodeURIComponent(key)}/review/undo`, {})).status).toBe(
      200,
    );
    expect((await checkThese()).find((r) => r.key === key)?.action).toBe('accept');
    // Undo again: nothing was accepted.
    expect((await call('POST', `/api/transactions/${encodeURIComponent(key)}/review/undo`, {})).status).toBe(
      409,
    );
  });
});

describe('A new date for an entry you added', () => {
  it('moves a pending entry to an earlier day', async () => {
    expect((await add({})).status).toBe(200);
    const { txn_key } = await entry('Check #77');
    const r = await call('PATCH', `/api/transactions/${encodeURIComponent(txn_key)}`, { date: '2026-11-03' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await entry('Check #77')).date).toBe('2026-11-03');
    expect(await sheet(txn_key)).toMatchObject({ date: '2026-11-03', budgetMonth: '2026-11' });
  });

  it('with an amount in the same edit', async () => {
    const { txn_key } = await entry('Check #77');
    const r = await call('PATCH', `/api/transactions/${encodeURIComponent(txn_key)}`, {
      amount: -4500,
      date: '2026-11-04',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await sheet(txn_key)).toMatchObject({ date: '2026-11-04', amount: -4500 });
  });

  it('refuses a later day for a pending entry, a date far away, and a bank row', async () => {
    const { txn_key } = await entry('Check #77');
    const later = await call('PATCH', `/api/transactions/${encodeURIComponent(txn_key)}`, {
      date: '2026-11-20',
    });
    expect(later.status).toBe(422);
    expect((later.json as { error: string }).error).toBe('future');
    const far = await call('PATCH', `/api/transactions/${encodeURIComponent(txn_key)}`, {
      date: '2040-01-01',
    });
    expect(far.status).toBe(422);
    expect((await entry('Check #77')).date).toBe('2026-11-04');
    const bank = await call('PATCH', `/api/transactions/${encodeURIComponent(await keyOf('cafe'))}`, {
      date: '2026-11-01',
    });
    expect(bank.status).toBe(422);
    expect((bank.json as { error: string }).error).toBe('not_manual');
  });

  it('moves an upcoming entry to another day', async () => {
    expect(
      (await add({ kind: 'upcoming', date: '2026-12-01', payee: 'Rent', repeats: 'monthly' })).status,
    ).toBe(200);
    const { txn_key } = await entry('Rent');
    const r = await call('PATCH', `/api/transactions/${encodeURIComponent(txn_key)}`, { date: '2026-12-03' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await sheet(txn_key)).toMatchObject({ date: '2026-12-03', status: 'upcoming' });
  });
});
