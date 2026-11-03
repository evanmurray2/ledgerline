// The prototype's November numbers through the whole stack: D1 tables → overlay → budget lines → recompute → API.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AccountsView,
  ActivityView,
  BudgetView,
  MutationResult,
  OwedView,
  ReportsView,
} from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const post = async <T>(p: string, body: unknown): Promise<T> => {
  const r = await app(p, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

describe('November through the API', () => {
  beforeAll(async () => {
    const r = await app('/__dev/seed-november', {
      method: 'POST',
      headers: H,
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('Budget: RTA $981.90, cards, groups, Owed to you, Needs attention', async () => {
    const b = await get<BudgetView>('/api/budget/2026-11');
    expect(b.rta).toBe(98190);
    expect(b.rtaUpdating).toBe(false);
    const sapphire = b.cards.find((c) => c.name === 'Sapphire Preferred')!;
    expect(sapphire).toMatchObject({
      available: 87832,
      owed: 84217,
      budgetedPending: 8100,
      uncategorized: 4485,
      status: 'covered',
    });
    expect(sapphire.statement).toEqual({ balance: 61140, due: '2026-11-25', covered: true });
    const freedom = b.cards.find((c) => c.name === 'Freedom Unlimited')!;
    expect(freedom).toMatchObject({
      available: 15500,
      owed: 21488,
      uncategorized: 4163,
      status: 'short',
      short: 1825,
    });
    expect(Object.fromEntries(b.groups.map((g) => [g.name, g.total]))).toEqual({
      Bills: 112185,
      Everyday: 44145,
      Savings: 1887763,
    });
    expect(b.owed).toEqual({ out: 143060, late: 1, status: 'late' });
    const fixes = Object.fromEntries(
      b.attention.filter((a) => a.categoryId).map((a) => [a.name, `${a.fix?.verb} ${a.fix?.amount}`]),
    );
    expect(fixes).toEqual({
      'Dining out': 'Cover 1825',
      'Car insurance': 'Fund 9000',
      Vacation: 'Fund 25000',
      'Personal care': 'Add 2000',
      Gifts: 'Move -4000',
    });
    expect(b.attention.some((a) => a.section === 'Owed to you' && a.name.startsWith('Rent on Nov 30'))).toBe(
      true,
    );
    const status = Object.fromEntries(b.groups.flatMap((g) => g.categories.map((c) => [c.name, c.status])));
    expect(status).toMatchObject({
      'Personal care': 'low',
      Gifts: 'overfunded',
      Investments: 'invested',
      'Home repairs': 'no_target',
      'Dining out': 'overspent',
      Subscriptions: 'funded',
    });
  });

  it('Accounts: cash $23,612.40 at the bank, $23,492.40 working; net worth $22,555.35; Ally needs repair', async () => {
    const a = await get<AccountsView>('/api/accounts');
    const cash = a.groups.find((g) => g.name === 'Cash')!;
    expect(cash.accounts.reduce((s, x) => s + x.bank, 0)).toBe(2361240);
    expect(cash.total).toBe(2349240);
    expect(cash.accounts.find((x) => x.name === 'Everyday Checking')).toMatchObject({
      bank: 421240,
      pending: -12000,
      working: 409240,
      drift: null,
    });
    expect(a.netWorth).toBe(2255535);
    expect(a.owedOut).toBe(143060);
    expect(a.repairs.map((r) => r.institution)).toEqual(['Ally']);
  });

  it('Activity: Needs attention groups and pending', async () => {
    const v = await get<ActivityView>('/api/activity');
    expect(v.moneyToMatch.map((r) => [r.payee, r.amount])).toEqual([['Venmo cashout', 101800]]);
    expect(v.needsCategory.map((r) => r.payee).sort()).toEqual([
      'Amazon',
      'Amazon',
      'Blue Bottle Coffee',
      'CVS Pharmacy',
    ]);
    expect(v.checkThese.map((r) => r.payee).sort()).toEqual(['Check #1043', 'Shake Shack']);
    expect(v.pending.map((r) => r.payee).sort()).toEqual([
      'Check #1043',
      'Marriott Downtown',
      'Shell',
      'Uber Eats',
    ]);
    expect(v.pendingTotal).toBe(20100);
    expect(v.upcoming.map((r) => r.payee)).toEqual(['Comcast', 'Rent']);
  });

  it('Owed to you: $1,430.60 out, Nopa late, the Nov 30 rent front projected short', async () => {
    const o = await get<OwedView>('/api/owed');
    expect(o.out).toBe(143060);
    expect(o.items.find((i) => i.id === 'nopa')!.status).toBe('late');
    expect(o.projected[0]).toMatchObject({ owed: 200000, shortfall: 200000 - 98190 });
  });

  it('Reports: month to date', async () => {
    const r = await get<ReportsView>('/api/reports?month=2026-11');
    expect(r.monthToDate).toBe(true);
    expect(r.tiles.invested).toBe(150000);
    expect(r.tiles.rewards).toBe(2410);
    expect(r.stillOwed).toBe(143060);
  });

  it('Reports → Activity: searching a category name finds that category’s transactions', async () => {
    const r = await get<ReportsView>('/api/reports?month=2026-11');
    expect(r.byCategory.length).toBeGreaterThan(0);
    for (const c of r.byCategory) {
      const v = await get<ActivityView>(`/api/activity?q=${encodeURIComponent(c.name)}`);
      const rows = [...v.posted, ...v.pending, ...v.upcoming];
      expect(rows.length, c.name).toBeGreaterThan(0);
    }
  });

  it('after Cover $18.25, Fund $90 and $250, Add $20, Move $40 back from Gifts: RTA $643.65', async () => {
    let res = await post<MutationResult>('/api/budget/assign', {
      month: '2026-11',
      items: [
        { categoryId: 'dining', amount: 1825 },
        { categoryId: 'car', amount: 9000 },
        { categoryId: 'vacation', amount: 25000 },
        { categoryId: 'personal', amount: 2000 },
      ],
    });
    res = await post<MutationResult>('/api/budget/move', {
      month: '2026-11',
      from: 'gifts',
      to: 'rta',
      amount: 4000,
    });
    expect(res.rta).toBe(64365);
    const b = await get<BudgetView>('/api/budget/2026-11');
    expect(b.rta).toBe(64365);
    expect(b.cards.find((c) => c.name === 'Freedom Unlimited')).toMatchObject({
      available: 17325,
      status: 'covered',
    });
    expect(b.attention.filter((a) => a.categoryId)).toEqual([]);
  });

  it('rejects mutations without the CSRF header', async () => {
    const r = await app('/api/budget/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });
});

describe('Overfunded wording', () => {
  beforeAll(async () => {
    await app('/__dev/seed-november', {
      method: 'POST',
      headers: H,
      body: '{}',
    });
  });

  it('a Set aside target says how much more was assigned, even when spending left less than the target', async () => {
    const put = (p: string, body: unknown) =>
      app(p, { method: 'PUT', headers: H, body: JSON.stringify(body) });
    const cat = 'shopping';
    expect(
      (
        await put(`/api/categories/${cat}/target`, {
          categoryId: cat,
          month: '2026-11',
          target: { type: 'set_aside', amount: 10_000 },
        })
      ).status,
    ).toBe(200);
    await post('/api/budget/set', { month: '2026-11', categoryId: cat, assigned: 20_000 });
    // Spend most of it, so what's left is below the $100 target while $200 stays assigned.
    const accounts = await get<AccountsView>('/api/accounts');
    const checking = accounts.groups.find((g) => g.name === 'Cash')!.accounts[0]!.id;
    let row = (await get<BudgetView>('/api/budget/2026-11')).groups
      .flatMap((g) => g.categories)
      .find((c) => c.id === cat)!;
    await post('/api/transactions', {
      kind: 'pending',
      accountId: checking,
      date: '2026-11-14',
      amount: -(row.available - 5_000),
      payee: 'Night out',
      categoryId: cat,
      repeats: 'never',
    });
    row = (await get<BudgetView>('/api/budget/2026-11')).groups
      .flatMap((g) => g.categories)
      .find((c) => c.id === cat)!;
    expect(row.available).toBe(5_000);
    expect(row.status).toBe('overfunded');
    expect(row.detail).toBe('$100.00 more assigned than this month’s $100.00');
  });

  it('Check these: OK on a bank row that cleared at a new amount clears it from Needs attention', async () => {
    const before = await get<ActivityView>('/api/activity?filter=attention');
    const shake = before.checkThese.find((r) => r.payee === 'Shake Shack')!;
    expect(shake.action).toBe('dismiss');
    // The bank row has no expected entry, so "keep waiting" can't be what OK sends.
    const wrong = await app(`/api/transactions/${encodeURIComponent(shake.key)}/pending`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ action: 'keep_waiting' }),
    });
    expect(wrong.status).toBe(404);
    await post(`/api/transactions/${encodeURIComponent(shake.key)}/review`, {});
    const after = await get<ActivityView>('/api/activity?filter=attention');
    expect(after.checkThese.map((r) => r.payee)).toEqual(['Check #1043']);
    expect(after.attentionCount).toBe(before.attentionCount - 1);
    const missing = await app('/api/transactions/nope/review', {
      method: 'POST',
      headers: H,
      body: '{}',
    });
    expect(missing.status).toBe(404);
  });
});
