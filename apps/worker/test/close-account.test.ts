// Close account and Reopen account (D-73): close only at $0 (no bank balance, nothing pending or upcoming, a $0
// working balance and a card's payment category at $0), the account and its payment category leave the screens, and
// a new bank row or an entry you add opens it again. Through the real sync and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView, CategoriesView, RegisterView } from '@ledgerline/contracts';
import { bankSync, pend, plaidTxn } from './bank-sync.js';

const B = 'b_close';
const NOW = Date.UTC(2026, 10, 8, 18, 0);
const h = bankSync('close-account', B, 'c_close', 3, NOW);

const through = async () =>
  (await h.db.prepare(`SELECT coalesce(max(seq), 0) AS n FROM change_log`).first<{ n: number }>())!.n;
const register = async (n: number) =>
  (await h.call('GET', `/api/accounts/a_${n}/register`)).json as RegisterView;
const accounts = async () => (await h.call('GET', '/api/accounts')).json as AccountsView;
const closedAt = async (n: number) =>
  (await h.db
    .prepare(`SELECT closed_at FROM account WHERE id = ?1`)
    .bind(`a_${n}`)
    .first<{ closed_at: number | null }>())!.closed_at;
const cardCatArchived = async () =>
  (await h.db
    .prepare(`SELECT archived_at FROM category WHERE id = 'pay_1'`)
    .first<{ archived_at: number | null }>())!.archived_at;
const close = async (n: number, body: Record<string, unknown>) =>
  h.call('POST', `/api/accounts/a_${n}/close`, body);
const atZero = async () => ({ working: 0, available: 0, through: await through() });

describe('close account (D-73)', () => {
  beforeAll(async () => {
    await h.setup();
    await h.db
      .prepare(
        `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES ('pay_1', ?1, 'Card 1', 'cc_payment', 'a_1', 0, 0)`,
      )
      .bind(B)
      .run();
    await h.sync([]);
  });

  it('can close a card at $0', async () => {
    const r = await register(1);
    expect(r.closeBlock).toBeNull();
    expect(r.cardAvailable).toBe(0);
    expect(r.account.closed).toBe(false);
  });

  it('refuses without the phone’s change number, or with a balance', async () => {
    expect((await close(1, { working: 0, available: 0 })).status).toBe(409);
    expect((await close(1, { working: 0, available: 0, through: (await through()) - 1 })).status).toBe(409);
    expect((await close(1, { ...(await atZero()), working: -500 })).status).toBe(422);
    expect((await close(1, { ...(await atZero()), available: 500 })).status).toBe(422);
    expect(await closedAt(1)).toBeNull();
  });

  it('closes: off Accounts, the payment category archived, the register still open', async () => {
    expect((await close(1, await atZero())).status).toBe(200);
    expect(await closedAt(1)).not.toBeNull();
    expect(await cardCatArchived()).not.toBeNull();
    const v = await accounts();
    expect(v.groups.flatMap((g) => g.accounts).some((a) => a.id === 'a_1')).toBe(false);
    expect(v.closed.map((a) => a.id)).toEqual(['a_1']);
    expect(v.closed[0]!.meta).toContain('closed Nov 8');
    const r = await register(1);
    expect(r.account.closed).toBe(true);
    expect(r.closeBlock).toBeNull();
    // Reopen restores the payment category, so Settings doesn't list it as archived.
    const cats = (await h.call('GET', '/api/settings/categories')).json as CategoriesView;
    expect(cats.archived.some((c) => c.id === 'pay_1')).toBe(false);
  });

  it('reopens with its payment category', async () => {
    expect((await h.call('POST', '/api/accounts/a_1/reopen', {})).status).toBe(200);
    expect(await closedAt(1)).toBeNull();
    expect(await cardCatArchived()).toBeNull();
    expect((await accounts()).closed).toEqual([]);
  });

  it('a new bank row opens a closed account again', async () => {
    expect((await close(1, await atZero())).status).toBe(200);
    expect(await closedAt(1)).not.toBeNull();
    await h.sync([plaidTxn('late-interest', 1, 3, '2026-11-08', 'INTEREST CHARGE')]);
    expect(await closedAt(1)).toBeNull();
    expect(await cardCatArchived()).toBeNull();
    expect((await accounts()).groups.flatMap((g) => g.accounts).some((a) => a.id === 'a_1')).toBe(true);
  });

  it('a pending row blocks Close', async () => {
    await h.sync([pend('p2', 2, 4, '2026-11-08', 'COFFEE')]);
    const r = await register(2);
    expect(r.closeBlock).toContain('pending');
    // The server checks the bank's pending rows itself.
    expect((await close(2, await atZero())).status).toBe(422);
    expect(await closedAt(2)).toBeNull();
  });

  it('a balance blocks Close', async () => {
    const r = await register(1);
    expect(r.closeBlock).toContain('You still owe $3.00');
  });

  it('an entry you add opens a closed account again', async () => {
    expect((await close(3, await atZero())).status).toBe(200);
    expect(await closedAt(3)).not.toBeNull();
    const add = await h.call('POST', '/api/transactions', {
      kind: 'pending',
      accountId: 'a_3',
      date: '2026-11-08',
      amount: -1200,
      payee: 'Lunch',
      categoryId: null,
      repeats: 'never',
    });
    expect(add.status).toBe(200);
    expect(await closedAt(3)).toBeNull();
  });
});
