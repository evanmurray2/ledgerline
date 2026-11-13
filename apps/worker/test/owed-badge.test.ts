// An owed purchase's Activity row says only what is still owed ("$7.00 owed"), and "Paid" once money back covers it.
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';

const db = phoneDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('owed badge on an Activity row', () => {
  let key = '';
  let payee = '';
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    const t = (await db
      .prepare(
        `SELECT key, payee FROM v_transaction WHERE amount < -1000 AND status = 'posted'
           AND alert IS NULL AND key NOT IN (SELECT txn_key FROM expected_reimbursement) ORDER BY date DESC LIMIT 1`,
      )
      .first<{ key: string; payee: string }>())!;
    key = t.key;
    payee = t.payee;
    const r = await app(`/api/transactions/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ markOwed: { mode: 'fixed', amount: 700, expectBy: null } }),
    });
    expect(r.status).toBe(200);
  });
  const row = async (): Promise<TxnListRow | undefined> => {
    const v = (await (await app(`/api/activity?q=${encodeURIComponent(payee)}`)).json()) as ActivityView;
    return v.posted.find((r) => r.key === key);
  };

  it('shows the amount still owed, then Paid', async () => {
    expect(await row()).toMatchObject({ badge: '$7.00 owed', badgeKind: 'owed' });
    const item = (await db
      .prepare(`SELECT id, budget_id FROM expected_reimbursement WHERE txn_key = ?1`)
      .bind(key)
      .first<{ id: string; budget_id: string }>())!;
    const link = (from: string, amount: number) =>
      db
        .prepare(
          `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at)
           VALUES (?1, ?2, 'reimbursement_of', ?3, ?4, ?5, 'user', 0)`,
        )
        .bind(`test-${from}`, item.budget_id, from, item.id, amount)
        .run();
    await link('inflow-a', 300);
    expect(await row()).toMatchObject({ badge: '$4.00 owed', badgeKind: 'owed' });
    await link('inflow-b', 400);
    expect(await row()).toMatchObject({ badge: 'Paid', badgeKind: 'match' });
  });
});
