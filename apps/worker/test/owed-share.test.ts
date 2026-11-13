// The sheet says which share of a transaction is owed to you (half, all or a typed amount), so it shows that one picked.
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OwedView, TxnSheet } from '@ledgerline/contracts';

const db = phoneDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const call = async (method: string, p: string, body?: unknown) => {
  const r = await app(p, {
    method,
    headers: method === 'GET' ? {} : H,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as unknown };
};

describe('owed share on the transaction sheet', () => {
  let url = '';
  let amount = 0;
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    const t = (await db
      .prepare(
        `SELECT key, amount FROM v_transaction WHERE amount < -1000 AND key NOT IN (SELECT txn_key FROM expected_reimbursement) LIMIT 1`,
      )
      .first<{ key: string; amount: number }>())!;
    url = `/api/transactions/${encodeURIComponent(t.key)}`;
    amount = -t.amount;
  });
  const owed = async () => ((await call('GET', url)).json as TxnSheet).owed[0];

  it('keeps half, all and a typed amount apart', async () => {
    expect(
      (await call('PATCH', url, { markOwed: { mode: 'fixed', amount: 700, expectBy: null } })).status,
    ).toBe(200);
    expect(await owed()).toMatchObject({ share: 'custom', amount: 700 });
    expect((await call('PATCH', url, { markOwed: { mode: 'half', expectBy: null } })).status).toBe(200);
    expect(await owed()).toMatchObject({ share: 'half', amount: Math.round(amount / 2) });
    expect((await call('PATCH', url, { markOwed: { mode: 'all', expectBy: null } })).status).toBe(200);
    expect(await owed()).toMatchObject({ share: 'all', amount });
  });
});

describe('deleting an entry you added', () => {
  it('cancels what was owed to you on it, so Owed to you no longer lists it', async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    const before = (await call('GET', '/api/owed')).json as OwedView;
    expect(
      (
        await call('POST', '/api/transactions', {
          kind: 'pending',
          accountId: 'checking',
          date: '2026-11-14',
          amount: -8000,
          payee: 'Dinner with Sam',
          categoryId: null,
          repeats: 'never',
        })
      ).status,
    ).toBe(200);
    const { key } = (await db
      .prepare(`SELECT txn_key AS key FROM manual_pending WHERE payee_name = 'Dinner with Sam'`)
      .first<{ key: string }>())!;
    const url = `/api/transactions/${encodeURIComponent(key)}`;
    expect((await call('PATCH', url, { markOwed: { mode: 'half', expectBy: null } })).status).toBe(200);
    expect(((await call('GET', '/api/owed')).json as OwedView).out).toBe(before.out + 4000);
    expect((await call('DELETE', url)).status).toBe(200);
    const after = (await call('GET', '/api/owed')).json as OwedView;
    expect(after.out).toBe(before.out);
    expect(after.items.map((i) => i.txnKey)).not.toContain(key);
  });
});
