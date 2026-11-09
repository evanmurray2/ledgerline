// A split whose lines no longer add up to its amount (the amount changed after the split): the owner chose to
// leave the lines as they are and ask you to fix them (D-82). The gap counts as uncategorized, Activity lists the
// row under Check these, and its sheet says what is off.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView, ActivityView, BudgetView, TxnSheet } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = async (method: string, p: string, body: unknown) => {
  const r = await app(p, { method, headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const get = async <T>(p: string) => (await (await app(p)).json()) as T;
const avail = (b: BudgetView, id: string) =>
  b.groups.flatMap((g) => g.categories).find((c) => c.id === id)!.available;

describe('a split that no longer adds up', () => {
  let key = '';
  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    const accounts = await get<AccountsView>('/api/accounts');
    const checking = accounts.groups.find((g) => g.name === 'Cash')!.accounts[0]!.id;
    const add = await send('POST', '/api/transactions', {
      kind: 'pending',
      accountId: checking,
      date: '2026-11-14',
      amount: -12_000,
      payee: 'Check #1043',
      categoryId: null,
      repeats: 'never',
    });
    expect(add.status).toBe(200);
    const v = await get<ActivityView>('/api/activity?filter=attention');
    key = v.needsCategory.find((r) => r.payee === 'Check #1043')!.key;
    const split = await send('PATCH', `/api/transactions/${encodeURIComponent(key)}`, {
      split: [
        { categoryId: 'gifts', amount: -6_000, memo: null, absorbsRemainder: false },
        { categoryId: 'dining', amount: -6_000, memo: null, absorbsRemainder: true },
      ],
    });
    expect(split.status).toBe(200);
  });

  it('adds up: nothing to check', async () => {
    const v = await get<ActivityView>('/api/activity?filter=attention');
    expect(v.checkThese.some((r) => r.key === key)).toBe(false);
    expect(v.needsCategory.some((r) => r.key === key)).toBe(false);
  });

  it('after the amount changes: the lines stay, Check these lists it, and its sheet says what is off', async () => {
    const before = await get<BudgetView>('/api/budget/2026-11');
    const r = await send('PATCH', `/api/transactions/${encodeURIComponent(key)}`, { amount: -50_000 });
    expect(r.status).toBe(200);
    const after = await get<BudgetView>('/api/budget/2026-11');
    // The categories keep their lines, and Ready to Assign doesn't move: the $380 is uncategorized.
    expect(avail(after, 'gifts')).toBe(avail(before, 'gifts'));
    expect(avail(after, 'dining')).toBe(avail(before, 'dining'));
    expect(after.rta).toBe(before.rta);
    const v = await get<ActivityView>('/api/activity?filter=attention');
    const row = v.checkThese.find((x) => x.key === key)!;
    expect(row).toMatchObject({ action: 'review', badge: 'Split $380.00 off', badgeKind: 'alert' });
    expect(v.needsCategory.some((x) => x.key === key)).toBe(false);
    const sheet = await get<TxnSheet>(`/api/transactions/${encodeURIComponent(key)}`);
    expect(sheet.alerts).toContain('The split adds up to $120.00, not $500.00. Edit the split to fix it.');
  });

  it('fixing the split clears it', async () => {
    const r = await send('PATCH', `/api/transactions/${encodeURIComponent(key)}`, {
      split: [
        { categoryId: 'gifts', amount: -6_000, memo: null, absorbsRemainder: false },
        { categoryId: 'dining', amount: -44_000, memo: null, absorbsRemainder: true },
      ],
    });
    expect(r.status).toBe(200);
    const v = await get<ActivityView>('/api/activity?filter=attention');
    expect(v.checkThese.some((x) => x.key === key)).toBe(false);
    const sheet = await get<TxnSheet>(`/api/transactions/${encodeURIComponent(key)}`);
    expect(sheet.alerts.some((a) => a.startsWith('The split adds up'))).toBe(false);
  });
});
