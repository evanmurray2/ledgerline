// Money in you added (Add pending) can pay back what's owed to you, as money in from the bank can (rule 12): Match
// links it, it can't come to less than it pays back, and deleting it makes what it paid back owed again. When the
// bank's row posts it takes the entry's key (D-64), so the match moves with it (entry-covers.test.ts).
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView, BudgetView, MatchView, OwedView, TxnSheet } from '@ledgerline/contracts';

const db = phoneDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const json = async <T>(path: string, init?: RequestInit) => {
  const r = await app(path, init);
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const send = (method: string, path: string, body?: unknown) =>
  app(path, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const rta = async () => (await json<BudgetView>('/api/budget/2026-11')).rta;
const matchedOn = async (id: string) =>
  (await json<OwedView>('/api/owed')).items.find((o) => o.id === id)!.matched;

describe('Match on money in you added', () => {
  let key = '';
  let item = { id: '', amount: 0 };

  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    const acct = await db
      .prepare(`SELECT id FROM account WHERE kind = 'checking' ORDER BY id LIMIT 1`)
      .first<{ id: string }>();
    expect(
      (
        await send('POST', '/api/transactions', {
          kind: 'pending',
          accountId: acct!.id,
          date: '2026-11-14',
          amount: 2_000,
          payee: 'Sam paid me back',
          categoryId: null,
          toRta: true,
          repeats: 'never',
        })
      ).status,
    ).toBe(200);
    key = (await db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Sam paid me back'`)
      .first<{ txn_key: string }>())!.txn_key;
  });

  it('opens Match and links it; Ready to Assign stays as it was', async () => {
    const v = await json<MatchView>(`/api/match/${encodeURIComponent(key)}`);
    expect(v.left).toBe(2_000);
    const o = v.open.find((x) => x.still >= 2_000)!;
    item = { id: o.id, amount: 2_000 };
    const before = await rta();
    const was = await matchedOn(item.id);
    expect(
      (await send('POST', '/api/match', { inflowKey: key, items: [{ itemId: item.id, amount: 2_000 }] }))
        .status,
    ).toBe(200);
    expect(await matchedOn(item.id)).toBe(was + 2_000);
    expect(await rta()).toBe(before);
  });

  it('refuses an amount below what it pays back', async () => {
    const r = await send('PATCH', `/api/transactions/${encodeURIComponent(key)}`, { amount: 1_500 });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: 'too_little' });
    expect(
      (await send('PATCH', `/api/transactions/${encodeURIComponent(key)}`, { amount: 2_500 })).status,
    ).toBe(200);
  });

  it('deleting it makes what it paid back owed again', async () => {
    const was = await matchedOn(item.id);
    expect((await send('DELETE', `/api/transactions/${encodeURIComponent(key)}`)).status).toBe(200);
    expect(await matchedOn(item.id)).toBe(was - 2_000);
  });
});

describe('A second payback you added', () => {
  it('shows on its own row and sheet, and on the purchase beside the first payback', async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    const acct = await db
      .prepare(`SELECT id FROM account WHERE kind = 'checking' ORDER BY id LIMIT 1`)
      .first<{ id: string }>();
    // An owed item with at least $20 still owed.
    const owed = await json<OwedView>('/api/owed');
    const it0 = owed.items.find((o) => (o.status === 'open' || o.status === 'late') && o.still >= 2_000)!;
    const add = async (payee: string, amount: number) => {
      expect(
        (
          await send('POST', '/api/transactions', {
            kind: 'pending',
            accountId: acct!.id,
            date: '2026-11-14',
            amount,
            payee,
            categoryId: null,
            toRta: true,
            repeats: 'never',
          })
        ).status,
      ).toBe(200);
      const k = (await db
        .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = ?1`)
        .bind(payee)
        .first<{ txn_key: string }>())!.txn_key;
      expect(
        (await send('POST', '/api/match', { inflowKey: k, items: [{ itemId: it0.id, amount: 1_000 }] }))
          .status,
      ).toBe(200);
      return k;
    };
    const first = await add('Payback one', 1_000);
    const before = await rta();
    const second = await add('Payback two', 1_000);
    // All of it is in Ready to Assign, matched or not (rule 12).
    expect(await rta()).toBe(before + 1_000);

    const purchase = await json<TxnSheet>(`/api/transactions/${encodeURIComponent(it0.txnKey)}`);
    expect(purchase.paybacks.map((p) => p.inflowKey)).toEqual(expect.arrayContaining([first, second]));

    const sheet = await json<TxnSheet>(`/api/transactions/${encodeURIComponent(second)}`);
    expect(sheet.paybacks).toMatchObject([{ inflowKey: second, itemId: it0.id, amount: 1_000 }]);

    const rows = (await json<ActivityView>('/api/activity')).pending;
    expect(rows.find((r) => r.key === second)?.badge).toMatch(/^Paid back/);

    // Unlink makes it owed again; the money in stays in Ready to Assign.
    expect((await send('POST', `/api/match/${encodeURIComponent(second)}/unlink`)).status).toBe(200);
    expect(await matchedOn(it0.id)).toBe(it0.matched + 1_000);
    expect(await rta()).toBe(before + 1_000);
  });
});
