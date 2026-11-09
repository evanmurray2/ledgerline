// Undoing Close out (D-79, Money rule 11). A close undone in the month it was made goes as if it never happened. One
// made in an earlier month stays there: that month keeps its numbers, and the undo gives the amount back to the
// category this month and takes it from Ready to Assign. Through the phone's engine, as the app counts it.
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, OwedView } from '@ledgerline/contracts';
import { app } from './phone.js';
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
const budget = async (m: string) => (await call('GET', `/api/budget/${m}`)).json as BudgetView;
const cat = (b: BudgetView, id: string) => b.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
const owedItem = async (id: string) =>
  ((await call('GET', '/api/owed')).json as OwedView).items.find((i) => i.id === id);

describe('reopening an owed item', () => {
  let id = '';
  let categoryId = '';
  let amount = 0;
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    // The work trip, fronted on Oct 20 and owed to you in full.
    const e = (await db
      .prepare(
        `SELECT e.id, e.amount, o.category_id FROM expected_reimbursement e JOIN txn_overlay o ON o.txn_key = e.txn_key
         WHERE e.txn_key = 'o-united'`,
      )
      .first<{ id: string; amount: number; category_id: string }>())!;
    id = e.id;
    categoryId = e.category_id;
    amount = e.amount;
  });

  it('in the month it was closed: as if it was never closed', async () => {
    const before = { oct: await budget('2026-10'), nov: await budget('2026-11') };
    expect((await call('POST', `/api/owed/${id}`, { action: 'close' })).status).toBe(200);
    const closed = await budget('2026-11');
    expect(cat(closed, categoryId).available).toBe(cat(before.nov, categoryId).available - amount);
    expect((await owedItem(id))?.status).toBe('closed');

    expect((await call('POST', `/api/owed/${id}`, { action: 'reopen' })).status).toBe(200);
    expect(await budget('2026-10')).toEqual(before.oct);
    expect(await budget('2026-11')).toEqual(before.nov);
    expect((await owedItem(id))?.status).toBe('open');
    expect((await db.prepare(`SELECT count(*) AS n FROM owed_close`).first<{ n: number }>())!.n).toBe(0);
  });

  it('closed in an earlier month: that month stays as it was, and this month gives the amount back', async () => {
    // Closed in October (the clock says Nov 14, so the close is moved back by hand).
    expect((await call('POST', `/api/owed/${id}`, { action: 'close' })).status).toBe(200);
    await db
      .prepare(`UPDATE expected_reimbursement SET closed_month = '2026-10' WHERE id = ?1`)
      .bind(id)
      .run();
    const closed = { oct: await budget('2026-10'), nov: await budget('2026-11') };
    expect((await owedItem(id))?.closedMonth).toBe('2026-10');

    expect((await call('POST', `/api/owed/${id}`, { action: 'reopen' })).status).toBe(200);
    const after = { oct: await budget('2026-10'), nov: await budget('2026-11') };
    // October's categories are as they were; Ready to Assign and what's out are today's on every month.
    expect(after.oct.groups).toEqual(closed.oct.groups);
    expect(cat(after.nov, categoryId).available - cat(closed.nov, categoryId).available).toBe(amount);
    expect(after.nov.rta - closed.nov.rta).toBe(-amount);
    expect((await owedItem(id))?.status).toBe('open');
    const rows = (
      await db
        .prepare(`SELECT month, amount FROM owed_close WHERE item_id = ?1 ORDER BY month`)
        .bind(id)
        .all<{
          month: string;
          amount: number;
        }>()
    ).results;
    expect(rows).toEqual([
      { month: '2026-10', amount },
      { month: '2026-11', amount: -amount },
    ]);
  });

  it('undoes Remove the mark, and refuses an item that is open', async () => {
    expect((await call('POST', `/api/owed/${id}`, { action: 'reopen' })).status).toBe(409);
    const before = await budget('2026-11');
    expect((await call('POST', `/api/owed/${id}`, { action: 'cancel' })).status).toBe(200);
    expect((await call('POST', `/api/owed/${id}`, { action: 'reopen' })).status).toBe(200);
    expect(await budget('2026-11')).toEqual(before);
  });
});
