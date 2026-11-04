// Rows before an account's budget start ("Before your budget", D-61) are read-only and stay out of Activity's lists
// and Settings → Payees; a search and the account's register still show them.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, PayeesView, TxnSheet } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

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
    const r = await send('POST', '/api/import/csv', {
      accountId: 'marcus',
      csv: 'date,payee,amount\n2026-10-02,Old Bakery,-12.34\n',
    });
    expect(r.status, await r.clone().text()).toBe(200);
    // A payee seen only on this row.
    const db = ownerDb();
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

  it('is left out of Activity’s month and plain lists, but a search finds it', async () => {
    const oct = await get<ActivityView>('/api/activity?month=2026-10');
    expect(oct.posted.map((r) => r.key)).not.toContain(KEY);
    expect(oct.posted.length).toBeGreaterThan(0);
    const plain = await get<ActivityView>('/api/activity');
    expect(plain.posted.map((r) => r.key)).not.toContain(KEY);
    const found = await get<ActivityView>('/api/activity?q=old%20bakery');
    const row = found.posted.find((r) => r.key === KEY);
    expect(row?.badge).toBe('Before your budget');
  });

  it('a payee seen only before the budget is left out of Settings → Payees', async () => {
    const v = await get<PayeesView>('/api/settings/payees');
    expect(v.payees.length).toBeGreaterThan(0);
    expect(v.payees.map((p) => p.name)).not.toContain('Old Bakery');
  });
});
