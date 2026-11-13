// Pending transactions: money you add can go to Ready to Assign, amounts you added can change, and a bank pending
// row takes your estimate even if it never had one. On the seeded November budget.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, TxnSheet } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

const db = ownerDb();

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const call = async (method: string, p: string, body?: unknown) => {
  const r = await app(p, {
    method,
    headers: method === 'GET' ? {} : H,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const rta = async () => ((await call('GET', '/api/budget/2026-11')).json as unknown as BudgetView).rta;
const sheet = async (key: string) =>
  (await call('GET', `/api/transactions/${encodeURIComponent(key)}`)).json as unknown as TxnSheet;

describe('pending transactions', () => {
  let checking = '';
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    checking = (await db.prepare(`SELECT id FROM account WHERE kind = 'checking' LIMIT 1`).first<{
      id: string;
    }>())!.id;
  });

  it('money in that you add can go straight to Ready to Assign, and its amount can change', async () => {
    const before = await rta();
    const add = await call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: checking,
      date: '2026-11-14',
      amount: 50_000,
      payee: 'Zelle from a friend',
      categoryId: null,
      toRta: true,
      repeats: 'never',
    });
    expect(add.status).toBe(200);
    expect(await rta()).toBe(before + 50_000);

    const key = (await db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Zelle from a friend'`)
      .first<{ txn_key: string }>())!.txn_key;
    expect((await sheet(key)).categoryLabel).toBe('Ready to Assign');
    expect(
      (await call('PATCH', `/api/transactions/${encodeURIComponent(key)}`, { amount: 45_000 })).status,
    ).toBe(200);
    expect((await sheet(key)).amount).toBe(45_000);
    expect(await rta()).toBe(before + 45_000);
  });

  it('money out can’t go to Ready to Assign', async () => {
    const before = await rta();
    await call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: checking,
      date: '2026-11-14',
      amount: -2_000,
      payee: 'Check 1044',
      categoryId: null,
      toRta: true,
      repeats: 'never',
    });
    const o = await db
      .prepare(
        `SELECT o.to_rta FROM txn_overlay o JOIN manual_pending m ON m.txn_key = o.txn_key WHERE m.payee_name = 'Check 1044'`,
      )
      .first<{ to_rta: number }>();
    expect(o!.to_rta).toBe(0);
    expect(await rta()).toBe(before);
  });

  it('an entry you added can turn from Out to In and back', async () => {
    await call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: checking,
      date: '2026-11-14',
      amount: -3_000,
      payee: 'Wrong way',
      categoryId: null,
      repeats: 'never',
    });
    const key = (await db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Wrong way'`)
      .first<{ txn_key: string }>())!.txn_key;
    const url = `/api/transactions/${encodeURIComponent(key)}`;
    const out = await rta();
    expect((await call('PATCH', url, { markOwed: { mode: 'half', expectBy: null } })).status).toBe(200);
    const open = async () =>
      (await db
        .prepare(
          `SELECT count(*) AS n FROM expected_reimbursement WHERE txn_key = ?1 AND canceled_at IS NULL`,
        )
        .bind(key)
        .first<{ n: number }>())!.n;
    expect(await open()).toBe(1);

    // Out to In, into Ready to Assign: what was owed goes with the old direction.
    expect((await call('PATCH', url, { amount: 3_000, toRta: true })).status).toBe(200);
    const s = await sheet(key);
    expect(s.amount).toBe(3_000);
    expect(s.categoryLabel).toBe('Ready to Assign');
    expect(await open()).toBe(0);
    expect(await rta()).toBe(out + 3_000);

    // Back to Out: money out can't stay in Ready to Assign.
    expect((await call('PATCH', url, { amount: -3_000 })).status).toBe(200);
    expect((await sheet(key)).categoryLabel).not.toBe('Ready to Assign');
    expect(await rta()).toBe(out);
  });

  it('a bank pending row takes a first estimate; its bank amount can’t be changed', async () => {
    const t = (await db
      .prepare(
        `SELECT key, amount FROM v_transaction WHERE source = 'bank' AND status = 'pending' AND amount < 0 AND estimated_amount IS NULL LIMIT 1`,
      )
      .first<{ key: string; amount: number }>())!;
    const url = `/api/transactions/${encodeURIComponent(t.key)}`;
    expect((await call('PATCH', url, { estimatedAmount: t.amount - 1_000 })).status).toBe(200);
    const s = await sheet(t.key);
    expect(s.amount).toBe(t.amount - 1_000);
    expect(s.bankAmount).toBe(t.amount);
    expect((await call('PATCH', url, { estimatedAmount: null })).status).toBe(200);
    expect((await sheet(t.key)).amount).toBe(t.amount);
    // A $0.00 estimate isn't one.
    expect((await call('PATCH', url, { estimatedAmount: 0 })).status).toBe(422);
    expect((await call('PATCH', url, { amount: -1 })).status).toBe(422);
  });
});

describe('assign suggestions', () => {
  it('list an overspent category with a target once, for the larger amount', async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    // Set aside $1,000 a month in a category, take back what it holds, then spend from it.
    const cat = 'shopping';
    expect(
      (
        await call('PUT', `/api/categories/${cat}/target`, {
          categoryId: cat,
          month: '2026-11',
          target: { type: 'set_aside', amount: 100_000 },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('POST', '/api/budget/set', { month: '2026-11', categoryId: cat, assigned: 0 })).status,
    ).toBe(200);
    const b = (await call('GET', '/api/budget/2026-11')).json as unknown as BudgetView;
    const row = b.groups.flatMap((g) => g.categories).find((c) => c.id === cat)!;
    if (row.available >= 0) {
      const checking = (await db.prepare(`SELECT id FROM account WHERE kind = 'checking' LIMIT 1`).first<{
        id: string;
      }>())!.id;
      await call('POST', '/api/transactions', {
        kind: 'pending',
        accountId: checking,
        date: '2026-11-14',
        amount: -(row.available + 41_310),
        payee: 'Night out',
        categoryId: cat,
        repeats: 'never',
      });
    }
    const v = (await call('GET', '/api/budget/2026-11/assign')).json as unknown as {
      suggestions: { categoryId: string; amount: number }[];
    };
    const mine = v.suggestions.filter((x) => x.categoryId === cat);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amount).toBe(100_000);
  });
});
