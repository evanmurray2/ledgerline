// Owed to you on list rows: a purchase says your share (what its category counts), so a category's list adds up to
// its Spent; money in that paid it back says which category it paid back. The money itself doesn't move.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, CategorySheet, TxnListRow } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

const db = ownerDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('owed labels on list rows', () => {
  let out: { key: string; payee: string; amount: number; category_id: string; month: string; name: string };
  let inflow: { key: string; payee: string };
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    out = (await db
      .prepare(
        `SELECT v.key, v.payee, v.amount, v.category_id, coalesce(v.budget_month, substr(v.date, 1, 7)) AS month,
           c.name FROM v_transaction v JOIN category c ON c.id = v.category_id
         WHERE v.amount < -2000 AND v.status = 'posted' AND v.alert IS NULL
           AND v.key NOT IN (SELECT txn_key FROM expected_reimbursement)
           AND v.key NOT IN (SELECT txn_key FROM txn_split)
           AND NOT EXISTS (SELECT 1 FROM v_transaction w WHERE w.category_id = v.category_id
             AND (w.date > v.date OR (w.date = v.date AND w.seq > v.seq)))
         ORDER BY v.date DESC LIMIT 1`,
      )
      .first<typeof out>())!;
    inflow = (await db
      .prepare(
        `SELECT key, payee FROM v_transaction WHERE amount > 1000 AND status = 'posted' AND wtm_state IS NULL
           AND key NOT IN (SELECT from_key FROM txn_link) ORDER BY date DESC LIMIT 1`,
      )
      .first<typeof inflow>())!;
    const r = await app(`/api/transactions/${encodeURIComponent(out.key)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ markOwed: { mode: 'fixed', amount: 1000, expectBy: null } }),
    });
    expect(r.status).toBe(200);
  });
  const find = async (payee: string, key: string): Promise<TxnListRow | undefined> => {
    const v = (await (await app(`/api/activity?q=${encodeURIComponent(payee)}`)).json()) as ActivityView;
    return v.posted.find((r) => r.key === key);
  };
  // The category sheet lists a few recent rows: the purchase picked is the newest in its category.
  const share = () => `your share $${((-out.amount - 1000) / 100).toFixed(2)}`;

  it('says your share on the purchase, on Activity and on its category sheet', async () => {
    expect(await find(out.payee, out.key)).toMatchObject({ badge: '$10.00 owed', sub: share() });
    const sheet = (await (
      await app(`/api/categories/${out.category_id}/sheet?month=${out.month}`)
    ).json()) as CategorySheet;
    const row = sheet.recent.find((r) => r.key === out.key);
    expect(row).toBeDefined();
    expect(row).toMatchObject({ badge: '$10.00 owed', sub: share() });
  });

  it('says which category money in paid back', async () => {
    const item = (await db
      .prepare(`SELECT id, budget_id FROM expected_reimbursement WHERE txn_key = ?1`)
      .bind(out.key)
      .first<{ id: string; budget_id: string }>())!;
    await db
      .prepare(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at)
         VALUES ('test-label', ?1, 'reimbursement_of', ?2, ?3, 1000, 'user', 0)`,
      )
      .bind(item.budget_id, inflow.key, item.id)
      .run();
    expect(await find(inflow.payee, inflow.key)).toMatchObject({
      badge: `Paid back · ${out.name}`,
      badgeKind: 'match',
    });
    expect(await find(out.payee, out.key)).toMatchObject({ badge: 'Paid', sub: share() });
  });

  it('lists the payback on the category sheet and in See all, as money in Ready to Assign', async () => {
    const month = (await db
      .prepare(`SELECT coalesce(budget_month, substr(date, 1, 7)) AS m FROM v_transaction WHERE key = ?1`)
      .bind(inflow.key)
      .first<{ m: string }>())!.m;
    const sheet = (await (
      await app(`/api/categories/${out.category_id}/sheet?month=${month}`)
    ).json()) as CategorySheet;
    const all = (await (
      await app(`/api/activity?category=${encodeURIComponent(out.category_id)}`)
    ).json()) as ActivityView;
    expect(all.posted.find((r) => r.key === inflow.key)).toMatchObject({ badge: `Paid back · ${out.name}` });
    // The sheet lists a few rows: the payback is there unless newer rows of the month push it out.
    if (sheet.recent.some((r) => r.key === inflow.key))
      expect(sheet.recent.find((r) => r.key === inflow.key)).toMatchObject({
        badge: 'Paid back',
        sub: 'to Ready to Assign',
      });
    // Unlinked, the payback leaves the category's list: the count drops by one.
    await db.prepare(`UPDATE txn_link SET undone_at = 1 WHERE id = 'test-label'`).run();
    const without = (await (
      await app(`/api/categories/${out.category_id}/sheet?month=${month}`)
    ).json()) as CategorySheet;
    await db.prepare(`UPDATE txn_link SET undone_at = NULL WHERE id = 'test-label'`).run();
    expect(without.recentTotal).toBe(sheet.recentTotal - 1);
    expect(without.recent.some((r) => r.key === inflow.key)).toBe(false);
  });
});
