// An archived category takes no new money or spending (the owner's answer to the two-devices hunt, Nov 16, 2026).
// An edit made on a device that had not seen the archive yet lands after it and is refused, so the category keeps
// what it held at the archive. Taking money out stays allowed, and a row already in it may keep it.
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { newCopy, seed } from './phone.js';

const MONTH = '2026-11';

describe('an archived category', () => {
  let e: LocalEngine;
  let archived: string;
  let other: string;
  /** A purchase already in the archived category, and one in another. */
  let inIt: { key: string; amount: number };
  let elsewhere: { key: string; amount: number };
  let account: string;

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await e.request(method, path, body);
    return { status: r.status, body: (await r.json()) as { error?: string } };
  };

  beforeAll(async () => {
    e = await seed(await newCopy());
    // A spending category with a purchase in it this month.
    const row = (await e.db
      .prepare(
        `SELECT o.category_id AS cat, b.txn_key AS key, b.amount FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key
         JOIN category c ON c.id = o.category_id
         WHERE c.kind = 'spending' AND b.amount < -200 AND b.pending = 0 AND b.removed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_key = b.txn_key)
         ORDER BY b.txn_key LIMIT 1`,
      )
      .first<{ cat: string; key: string; amount: number }>())!;
    archived = row.cat;
    inIt = { key: row.key, amount: row.amount };
    const two = (await e.db
      .prepare(
        `SELECT o.category_id AS cat, b.txn_key AS key, b.amount FROM bank_txn b JOIN txn_overlay o ON o.txn_key = b.txn_key
         JOIN category c ON c.id = o.category_id
         WHERE c.kind = 'spending' AND c.id != ?1 AND b.amount < -200 AND b.pending = 0 AND b.removed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_key = b.txn_key)
         ORDER BY b.txn_key LIMIT 1`,
      )
      .bind(archived)
      .first<{ cat: string; key: string; amount: number }>())!;
    other = two.cat;
    elsewhere = { key: two.key, amount: two.amount };
    account = (await e.db.prepare(`SELECT id FROM account ORDER BY id LIMIT 1`).first<{ id: string }>())!.id;
    const sheet = (await (await e.request('GET', `/api/categories/${archived}/sheet`)).json()) as {
      available: number;
    };
    // Some money in it, to take out later.
    const a = await call('POST', '/api/budget/assign', {
      month: MONTH,
      items: [{ categoryId: archived, amount: Math.max(0, -sheet.available) + 1000 }],
    });
    expect(a.status).toBe(200);
    const shown = (await (await e.request('GET', `/api/categories/${archived}/sheet`)).json()) as {
      available: number;
    };
    const r = await call('POST', `/api/settings/categories/${archived}/archive`, {
      archived: true,
      available: shown.available,
      through: (await e.state()).through,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('takes no new money: assign, set higher and move in are refused', async () => {
    for (const [path, body] of [
      ['/api/budget/assign', { month: MONTH, items: [{ categoryId: archived, amount: 100 }] }],
      ['/api/budget/set', { month: MONTH, categoryId: archived, assigned: 1_000_000 }],
      ['/api/budget/move', { month: MONTH, from: other, to: archived, amount: 100 }],
      ['/api/budget/move', { month: MONTH, from: 'rta', to: archived, amount: 100 }],
    ] as const) {
      const r = await call('POST', path, body);
      expect([r.status, r.body.error], path).toEqual([422, 'archived']);
    }
  });

  it('takes no new spending: a row, a split line or a new entry in it is refused', async () => {
    const path = `/api/transactions/${encodeURIComponent(elsewhere.key)}`;
    expect((await call('PATCH', path, { categoryId: archived })).body.error).toBe('archived');
    const half = Math.trunc(elsewhere.amount / 2);
    const split = await call('PATCH', path, {
      split: [
        { categoryId: other, amount: half, memo: null, absorbsRemainder: false },
        { categoryId: archived, amount: elsewhere.amount - half, memo: null, absorbsRemainder: true },
      ],
    });
    expect(split.body.error).toBe('archived');
    const entry = await call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: account,
      date: '2026-11-10',
      amount: -500,
      payee: 'Archived test',
      categoryId: archived,
      repeats: 'never',
    });
    expect(entry.body.error).toBe('archived');
  });

  it('a row already in it may keep it, and be split with it', async () => {
    const path = `/api/transactions/${encodeURIComponent(inIt.key)}`;
    expect((await call('PATCH', path, { categoryId: archived, memo: 'kept' })).status).toBe(200);
    const half = Math.trunc(inIt.amount / 2);
    const r = await call('PATCH', path, {
      split: [
        { categoryId: archived, amount: half, memo: null, absorbsRemainder: false },
        { categoryId: other, amount: inIt.amount - half, memo: null, absorbsRemainder: true },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('money can still be taken out', async () => {
    const r = await call('POST', '/api/budget/move', {
      month: MONTH,
      from: archived,
      to: other,
      amount: 100,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('an archive sent at 0 from a copy that is behind is refused, like one sent with money', async () => {
    const r = await call('POST', `/api/settings/categories/${other}/archive`, {
      archived: true,
      available: 0,
      through: (await e.state()).through - 1,
    });
    expect([r.status, r.body.error]).toEqual([409, 'changed']);
  });
});
