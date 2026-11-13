// An account's register, on the seeded November budget: a card's statement says Covered as Accounts does, upcoming
// bills are listed apart with their dates, rows with no category say so, and the overspent note reads well.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView, RegisterView } from '@ledgerline/contracts';
import { nameList } from '../src/routes/account-register.js';
import { ownerDb } from './store-db.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

describe('register view', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
  });

  it('a card’s statement is covered (or not) as on Accounts', async () => {
    // Take $300 out of Sapphire's payment category: it no longer covers the $611.40 statement.
    const pay = (await ownerDb()
      .prepare(
        `SELECT c.id FROM category c JOIN account a ON a.id = c.card_account_id WHERE c.kind = 'cc_payment' AND a.name = 'Sapphire Preferred'`,
      )
      .first<{ id: string }>())!;
    const r0 = await app('/api/budget/move', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ month: '2026-11', from: pay.id, to: 'rta', amount: 30000 }),
    });
    expect(r0.status).toBe(200);
    const accounts = await get<AccountsView>('/api/accounts');
    const cards = accounts.groups.flatMap((g) => g.accounts).filter((a) => a.kind === 'credit');
    expect(cards.some((a) => a.statement && !a.statement.covered)).toBe(true);
    for (const a of cards) {
      const r = await get<RegisterView>(`/api/accounts/${a.id}/register`);
      expect(r.account.statement).toEqual(a.statement);
    }
  });

  it('upcoming bills are listed apart, by date, and not under Pending', async () => {
    const accounts = await get<AccountsView>('/api/accounts');
    let found = false;
    for (const a of accounts.groups.flatMap((g) => g.accounts)) {
      const r = await get<RegisterView>(`/api/accounts/${a.id}/register`);
      const pending = r.days.find((d) => d.label === 'Pending');
      expect(pending?.rows.some((x) => x.status === 'upcoming' && x.date > '2026-11-14') ?? false).toBe(
        false,
      );
      const up = r.days.find((d) => d.label === 'Upcoming');
      if (!up) continue;
      found = true;
      expect(up.balance).toBeNull();
      expect(up.rows.every((x) => x.status === 'upcoming')).toBe(true);
      const dates = up.rows.map((x) => x.date);
      expect(dates).toEqual([...dates].sort());
    }
    expect(found).toBe(true);
  });

  it('a row with no category says it needs one', async () => {
    const accounts = await get<AccountsView>('/api/accounts');
    const rows = [];
    for (const a of accounts.groups.flatMap((g) => g.accounts))
      rows.push(...(await get<RegisterView>(`/api/accounts/${a.id}/register`)).days.flatMap((d) => d.rows));
    const bare = rows.filter((r) => r.badge === 'Needs a category');
    expect(bare.length).toBeGreaterThan(0);
    expect(bare.every((r) => r.categoryLabel === null && r.badgeKind === 'alert')).toBe(true);
  });

  it('a name of only spaces, or with direction or control characters, is refused', async () => {
    const rename = (name: string) =>
      app('/api/accounts/marcus/name', { method: 'POST', headers: H, body: JSON.stringify({ name }) });
    for (const bad of ['   ', 'Party \u202Eevil', 'Tab\u0009name', 'a\u2066b'])
      expect((await rename(bad)).status).toBe(400);
    expect((await rename('Savings 🎉')).status).toBe(200);
  });

  it('names several categories in plain words', () => {
    expect(nameList(['Dining out'])).toBe('Dining out');
    expect(nameList(['Dining out', 'Groceries'])).toBe('Dining out and Groceries');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
