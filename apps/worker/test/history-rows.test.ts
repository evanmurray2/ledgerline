// Rows before an account's budget start ("Before your budget", D-61) are read-only and are never listed: not in
// Activity (searches too), the account's register, a category sheet or Settings → Payees (D-62).
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, CategorySheet, PayeesView, RegisterView, TxnSheet } from '@ledgerline/contracts';
import { historyRow } from './history.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const send = (method: string, p: string, body: unknown) =>
  app(p, { method, headers: H, body: JSON.stringify(body) });

/** Marcus budgets from Oct 3 (the budget starts in October), so Oct 2 is before its budget. */
const KEY = 'p:csv_marcus_2026-10-02_0';
const sheetPath = `/api/transactions/${encodeURIComponent(KEY)}`;

describe('Before your budget', () => {
  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    await historyRow('marcus', '2026-10-02', -1234, 'Old Bakery');
    // A payee seen only on this row.
    const db = phoneDb();
    const now = Date.now();
    const budget = (await db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    await db.batch([
      db
        .prepare(
          `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES ('pay_old_bakery', ?1, 'Old Bakery', ?2, ?2)`,
        )
        .bind(budget, now),
      db
        .prepare(
          `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, created_at, updated_at) VALUES (?1, ?2, 'pay_old_bakery', ?3, ?3)
           ON CONFLICT (txn_key) DO UPDATE SET payee_id = excluded.payee_id`,
        )
        .bind(KEY, budget, now),
    ]);
  });

  it('opens as a read-only sheet', async () => {
    const t = await get<TxnSheet>(sheetPath);
    expect(t.kind).toBe('history');
  });

  it('refuses every edit', async () => {
    const cats = await get<ActivityView>('/api/activity?month=2026-11');
    const categoryId = cats.categoryPicker[0]!.categories[0]!.id;
    for (const body of [{ categoryId }, { memo: 'x' }, { wontClear: true }, { payeeName: 'New name' }]) {
      const r = await send('PATCH', sheetPath, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
    }
    const r = await send('POST', '/api/transactions/categorize', { keys: [KEY], categoryId });
    expect(r.status).toBe(409);
    expect((await send('POST', '/api/match', { inflowKey: KEY, items: [], rest: 'income' })).status).toBe(
      409,
    );
    expect(
      (await send('POST', `/api/transfers/${encodeURIComponent(KEY)}/pick`, { otherKey: null })).status,
    ).toBe(409);
    expect((await get<TxnSheet>(sheetPath)).categoryId).toBeNull();
  });

  it('is left out of Activity’s month and plain lists and its searches', async () => {
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    expect(oct.posted.map((r) => r.key)).not.toContain(KEY);
    expect(oct.posted.length).toBeGreaterThan(0);
    const plain = await get<ActivityView>('/api/activity');
    expect(plain.posted.map((r) => r.key)).not.toContain(KEY);
    const found = await get<ActivityView>('/api/activity?q=old%20bakery');
    expect(found.posted.map((r) => r.key)).not.toContain(KEY);
  });

  it('is left out of the account’s register', async () => {
    for (const show of ['all', 'needs']) {
      const v = await get<RegisterView>(`/api/accounts/marcus/register?show=${show}`);
      const keys = v.days.flatMap((d) => d.rows.map((r) => r.key));
      expect(keys, show).not.toContain(KEY);
      expect(v.days.flatMap((d) => d.rows.map((r) => r.badge))).not.toContain('Before your budget');
    }
    expect((await get<RegisterView>('/api/accounts/marcus/register')).days.length).toBeGreaterThan(0);
  });

  it('is left out of a category sheet’s recent rows and count, even with a category', async () => {
    const cats = await get<ActivityView>('/api/activity?month=2026-11');
    const categoryId = cats.categoryPicker[0]!.categories[0]!.id;
    const db = phoneDb();
    await db
      .prepare(`UPDATE txn_overlay SET category_id = ?2 WHERE txn_key = ?1`)
      .bind(KEY, categoryId)
      .run();
    const v = await get<CategorySheet>(`/api/categories/${categoryId}/sheet?month=2026-10`);
    expect(v.recent.map((r) => r.key)).not.toContain(KEY);
    await db.prepare(`UPDATE txn_overlay SET category_id = NULL WHERE txn_key = ?1`).bind(KEY).run();
    const without = await get<CategorySheet>(`/api/categories/${categoryId}/sheet?month=2026-10`);
    expect(v.recentTotal).toBe(without.recentTotal);
  });

  it('a payee seen only before the budget is left out of Settings → Payees', async () => {
    const v = await get<PayeesView>('/api/settings/payees');
    expect(v.payees.length).toBeGreaterThan(0);
    expect(v.payees.map((p) => p.name)).not.toContain('Old Bakery');
  });
});

describe('Before your budget, on a payee with budget transactions', () => {
  it('leaves the history row’s bank name out of the payee’s bank names', async () => {
    const before = await get<PayeesView>('/api/settings/payees');
    const p = before.payees.find((x) => x.bankNames.length < 10)!;
    await historyRow('marcus', '2026-10-01', -500, 'OLD HISTORY TEXT');
    const db = phoneDb();
    const now = Date.now();
    const budget = (await db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    await db
      .prepare(
        `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (txn_key) DO UPDATE SET payee_id = excluded.payee_id`,
      )
      .bind('p:csv_marcus_2026-10-01_0', budget, p.id, now)
      .run();
    const after = (await get<PayeesView>('/api/settings/payees')).payees.find((x) => x.id === p.id)!;
    expect(after.bankNames.map((b) => b.name)).not.toContain('OLD HISTORY TEXT');
    expect(after.bankNames.reduce((t, b) => t + b.count, 0)).toBe(after.transactions);
  });
});
