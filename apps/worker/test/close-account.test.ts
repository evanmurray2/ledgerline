// Close account and Reopen account (D-73): close only at $0 (no bank balance, nothing pending or upcoming, a $0
// working balance and a card's payment category at $0), the account and its payment category leave the screens, and
// a new bank row or an entry you add opens it again. Through the real sync and the routes the phone runs.
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AccountsView,
  ActivityView,
  CategoriesView,
  RegisterView,
  ReportsView,
} from '@ledgerline/contracts';
import { bankSync, pend, plaidTxn, removal } from './bank-sync.js';

const B = 'b_close';
const NOW = Date.UTC(2026, 10, 8, 18, 0);
const h = bankSync('close-account', B, 'c_close', 5, NOW);

// The change number the phone's copy holds, as the engine gives it to the routes (http/through.ts).
const through = async () => (await h.engine.state()).through;
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

  // M14: the only way to empty a card's payment category is the Close sheet's "Move $X to Ready to Assign".
  it('money in the payment category: offered to move to Ready to Assign, then Close works', async () => {
    const month = (await h.call('GET', '/api/session')).json as { budget: { currentMonth: string } };
    const m = month.budget.currentMonth;
    expect(
      (
        await h.call('POST', '/api/budget/assign', {
          month: m,
          items: [{ categoryId: 'pay_1', amount: 2500 }],
        })
      ).status,
    ).toBe(200);
    const r = await register(1);
    expect(r.cardAvailable).toBe(2500);
    expect(r.closeBlock).toBe('Its payment category has $25.00 available. Move it to Ready to Assign first.');
    expect(r.closeMove).toEqual({ categoryId: 'pay_1', amount: 2500 });
    expect((await close(1, { ...(await atZero()), available: 2500 })).status).toBe(422);
    const moved = await h.call('POST', '/api/budget/move', {
      month: m,
      from: 'pay_1',
      to: 'rta',
      amount: 2500,
    });
    expect(moved.status).toBe(200);
    const after = await register(1);
    expect(after.cardAvailable).toBe(0);
    expect(after.closeBlock).toBeNull();
    expect(after.closeMove).toBeNull();
  });

  it('a new bank row opens a closed account again', async () => {
    expect((await close(1, await atZero())).status).toBe(200);
    expect(await closedAt(1)).not.toBeNull();
    await h.sync([plaidTxn('late-interest', 1, 3, '2026-11-08', 'INTEREST CHARGE')]);
    expect(await closedAt(1)).toBeNull();
    expect(await cardCatArchived()).toBeNull();
    expect((await accounts()).groups.flatMap((g) => g.accounts).some((a) => a.id === 'a_1')).toBe(true);
  });

  it('a pending row that leaves a balance blocks Close', async () => {
    await h.sync([pend('p2', 2, 4, '2026-11-08', 'COFFEE')]);
    const r = await register(2);
    expect(r.closeBlock).toContain('balance after pending is $4.00');
    expect((await close(2, { ...(await atZero()), working: 400 })).status).toBe(422);
    expect(await closedAt(2)).toBeNull();
  });

  // D-93: the bank closed the account, so its own pending row never posts. A refund of the same amount is pending.
  it('the bank’s pending row stays when the balance after pending is $0, and its removal opens the account', async () => {
    await h.sync([pend('p2-back', 2, -4, '2026-11-08', 'COFFEE REFUND')]);
    const r = await register(2);
    expect(r.account.working).toBe(0);
    expect(r.closeBlock).toBeNull();
    const before = (await accounts()).netWorth;
    expect((await close(2, await atZero())).status).toBe(200);
    expect(await closedAt(2)).not.toBeNull();
    const a = await accounts();
    expect(a.netWorth).toBe(before);
    expect(a.closed.find((x) => x.id === 'a_2')).toMatchObject({ bank: 0, pending: 0, working: 0 });
    const closed = await register(2);
    expect(closed.days.map((d) => d.label)).toEqual(['Nov 8']);
    expect(closed.days[0]!.rows).toHaveLength(2);
    const keys = closed.days[0]!.rows.map((x) => x.key);
    const v = (await h.call('GET', '/api/activity')).json as ActivityView;
    expect(v.pending.some((x) => keys.includes(x.key))).toBe(false);
    // Final rows are listed with the posted rows, on their date (D-93), in the month and in a search too.
    for (const path of ['/api/activity', '/api/activity?month=2026-11', '/api/activity?q=coffee']) {
      const posted = ((await h.call('GET', path)).json as ActivityView).posted.map((x) => x.key);
      for (const k of keys) expect(posted, path).toContain(k);
    }
    const oct = ((await h.call('GET', '/api/activity?month=2026-10')).json as ActivityView).posted;
    expect(oct.some((x) => keys.includes(x.key))).toBe(false);
    // The bank removes one of the two: the account is no longer $0, so it opens again.
    await h.sync([], [removal('p2-back', 2)]);
    expect(await closedAt(2)).toBeNull();
    expect((await register(2)).closeBlock).toContain('balance after pending is $4.00');
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

  // D-93: the bank closed the account and sends nothing more, so your own pending entry never posts.
  describe('with a pending entry of yours (D-93)', () => {
    const add = (n: number, kind: 'pending' | 'upcoming', amount: number, date = '2026-11-08') =>
      h.call('POST', '/api/transactions', {
        kind,
        accountId: `a_${n}`,
        date,
        amount,
        payee: 'Payment',
        categoryId: null,
        repeats: 'never',
      });
    const entryKey = async (n: number) =>
      (await h.db
        .prepare(`SELECT txn_key FROM manual_pending WHERE account_id = ?1 AND deleted_at IS NULL`)
        .bind(`a_${n}`)
        .first<{ txn_key: string }>())!.txn_key;
    const reports = async () => (await h.call('GET', '/api/reports')).json as ReportsView;
    let before: { netWorth: number; change: number; series: ReportsView['netWorth'] };

    it('Close works at a working balance of $0, though the bank balance is not $0', async () => {
      await h.sync([plaidTxn('last-charge', 4, 50, '2026-11-06', 'LAST CHARGE')]);
      expect((await register(4)).closeBlock).toContain('You still owe $50.00');
      expect((await add(4, 'pending', 5000)).status).toBe(200);
      const r = await register(4);
      expect(r.account).toMatchObject({ bank: 5000, pending: -5000, working: 0 });
      expect(r.closeBlock).toBeNull();
      const a = await accounts();
      before = { netWorth: a.netWorth, change: a.netWorthChange, series: (await reports()).netWorth };
      expect((await close(4, await atZero())).status).toBe(200);
      expect(await closedAt(4)).not.toBeNull();
    });

    it('the closed account is $0, and net worth is the same now and in every month', async () => {
      const a = await accounts();
      expect(a.closed.find((x) => x.id === 'a_4')).toMatchObject({ bank: 0, pending: 0, working: 0 });
      expect(a.netWorth).toBe(before.netWorth);
      expect(a.netWorthChange).toBe(before.change);
      expect((await reports()).netWorth).toEqual(before.series);
    });

    it('the entry is final: on its day in the register, not waiting on Activity', async () => {
      const key = await entryKey(4);
      const r = await register(4);
      expect(r.days.map((d) => d.label)).toEqual(['Nov 8', 'Nov 6']);
      expect(r.days[0]).toMatchObject({ balance: 0, rows: [{ key }] });
      expect(r.days[1]!.balance).toBe(5000);
      const v = (await h.call('GET', '/api/activity')).json as ActivityView;
      expect(v.pending.some((x) => x.key === key)).toBe(false);
      expect(v.posted.map((x) => x.key)).toContain(key);
      // Long after: it is never "not at the bank yet".
      h.setNow(NOW + 40 * 86_400_000);
      const later = (await h.call('GET', '/api/activity')).json as ActivityView;
      expect(later.checkThese.some((x) => x.key === key)).toBe(false);
      h.setNow(NOW);
    });

    it('deleting the entry opens the account again', async () => {
      expect((await h.call('DELETE', `/api/transactions/${await entryKey(4)}`)).status).toBe(200);
      expect(await closedAt(4)).toBeNull();
      expect((await register(4)).closeBlock).toContain('You still owe $50.00');
    });

    it('an upcoming entry, or a balance after pending that is not $0, still blocks', async () => {
      expect((await add(5, 'upcoming', -1000, '2026-12-01')).status).toBe(200);
      expect((await register(5)).closeBlock).toContain('upcoming');
      expect((await close(5, await atZero())).status).toBe(422);
      expect((await h.call('DELETE', `/api/transactions/${await entryKey(5)}`)).status).toBe(200);
      expect((await add(5, 'pending', -700)).status).toBe(200);
      expect((await register(5)).closeBlock).toContain('balance after pending is $7.00');
      expect(await closedAt(5)).toBeNull();
    });

    it('the server refuses a bank balance that is not $0 when no entry of yours stays', async () => {
      await h.call('DELETE', `/api/transactions/${await entryKey(5)}`);
      await h.db
        .prepare(
          `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, current_balance, created_at, updated_at)
           VALUES ('pa5', ?1, 'c_close', 'pa_5', 'Card 5', 'credit', 900, 0, 0)`,
        )
        .bind(B)
        .run();
      expect((await close(5, await atZero())).status).toBe(422);
      expect(await closedAt(5)).toBeNull();
    });
  });
});
