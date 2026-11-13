// Linking a card refund to its purchase (docs/design.md, Credit card refunds; Money rule 3). Linked, the card's
// payment category gives back the funded part of that purchase; "Not this purchase" unlinks it, and the payment
// category gives back as much as it holds up to the refund. Through the phone's engine, as the app counts it.
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, RefundOfView, TxnSheet } from '@ledgerline/contracts';
import { app, everythingAgain, phone } from './phone.js';

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
const sheet = async (key: string) => (await call('GET', `/api/transactions/${key}`)).json as TxnSheet;
const link = (key: string, purchaseKey: string | null) =>
  call('POST', `/api/transactions/${key}/refund-of`, { purchaseKey });
/** The card's payment category this month: what it holds for the card's debt. */
const pay = async () => (await budget('2026-11')).cards.find((c) => c.accountId === 'sapphire')!.available;

describe('a card refund linked to its purchase', () => {
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
  });

  it('the sheet names the linked purchase and its category', async () => {
    const t = await sheet('n-rei-refund');
    expect(t.kind).toBe('refund');
    expect(t.refundOf).toMatchObject({ key: 'o-rei', categoryId: 'shopping', categoryName: 'Shopping' });
    expect(t.refundOf!.label).toMatch(/^REI · /);
  });

  it('offers the same payee’s purchases on that card first, and only purchases on that card', async () => {
    const r = await call('GET', '/api/transactions/n-rei-refund/refund-of');
    expect(r.status).toBe(200);
    const v = r.json as RefundOfView;
    expect(v.suggested.map((p) => p.key)).toEqual(['o-rei']);
    expect(v.suggested[0]).toMatchObject({ payee: 'REI', amount: -5400, categoryLabel: 'Shopping' });
    const all = [...v.suggested, ...v.others];
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((p) => p.amount < 0)).toBe(true);
    // Newest first, never after the refund, never 90 days before it.
    for (const p of all) expect(p.date >= '2026-08-06' && p.date <= '2026-11-04').toBe(true);
    expect(all.map((p) => p.key)).toContain('o-wholefoods');
    // Not the refund itself, a card payment, or another account's purchase.
    for (const k of ['n-rei-refund', 'n-sapphire-pay-in', 'o-target', 'n-tj'])
      expect(all.map((p) => p.key)).not.toContain(k);
  });

  it('Not this purchase unlinks it; picking it again gives the same budget back', async () => {
    const linked = await budget('2026-11');
    const r = await link('n-rei-refund', null);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const t = await sheet('n-rei-refund');
    expect(t.kind).toBe('refund');
    expect(t.refundOf).toBeNull();
    const unlinked = await budget('2026-11');
    // Worked out from scratch, the copy shows the same.
    await everythingAgain(await phone());
    expect(await budget('2026-11')).toEqual(unlinked);
    // Sent again (another device's "Not this purchase"), nothing changes.
    expect((await link('n-rei-refund', null)).status).toBe(200);
    expect(await budget('2026-11')).toEqual(unlinked);

    expect((await link('n-rei-refund', 'o-rei')).status).toBe(200);
    expect((await sheet('n-rei-refund')).refundOf?.key).toBe('o-rei');
    expect(await budget('2026-11')).toEqual(linked);
    await everythingAgain(await phone());
    expect(await budget('2026-11')).toEqual(linked);
  });

  it('linked to a purchase nothing funded, the payment category gives back nothing for it', async () => {
    // A new category with nothing assigned, and a purchase in it on the card: none of it is funded (rule 2).
    const made = await call('POST', '/api/settings/categories', {
      name: 'Refund test',
      groupId: null,
      kind: 'spending',
    });
    expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
    const db = (await phone()).db;
    const c = (await db
      .prepare(`SELECT id FROM category WHERE name = 'Refund test'`)
      .first<{ id: string }>())!.id;
    const added = await call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: 'sapphire',
      date: '2026-11-03',
      amount: -5400,
      payee: 'Unfunded shop',
      categoryId: c,
      repeats: 'never',
    });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const key = (await db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Unfunded shop'`)
      .first<{ txn_key: string }>())!.txn_key;
    const toRei = await pay();
    expect((await link('n-rei-refund', key)).status).toBe(200);
    const toUnfunded = await pay();
    // o-rei was funded in full, so the $54 it set aside stays in the payment category now (rule 3: g = 0).
    expect(toUnfunded - toRei).toBe(5400);
    await everythingAgain(await phone());
    expect(await pay()).toBe(toUnfunded);
    // Back to o-rei: one link per refund, the new pick replaces the old.
    expect((await link('n-rei-refund', 'o-rei')).status).toBe(200);
    expect(await pay()).toBe(toRei);
    const n = await db
      .prepare(
        `SELECT count(*) AS n FROM txn_link WHERE kind = 'refund_of' AND from_key = 'n-rei-refund' AND undone_at IS NULL`,
      )
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('refuses what is not a refund or not a purchase on the same card', async () => {
    // A purchase is not a refund; a card payment is a transfer.
    expect((await call('GET', '/api/transactions/o-rei/refund-of')).status).toBe(422);
    expect((await link('n-sapphire-pay-in', 'o-rei')).status).toBe(422);
    // Another account's purchase, money in, the refund itself.
    expect((await link('n-rei-refund', 'o-target')).status).toBe(422);
    expect((await link('n-rei-refund', 'n-points')).status).toBe(422);
    expect((await link('n-rei-refund', 'n-rei-refund')).status).toBe(422);
    expect((await link('n-rei-refund', 'no-such-key')).status).toBe(404);
    expect((await sheet('n-rei-refund')).refundOf?.key).toBe('o-rei');
  });
});
