// The sheet says which share of a transaction is owed to you (half, all or a typed amount), so it shows that one picked.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TxnSheet } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

const db = ownerDb();
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
