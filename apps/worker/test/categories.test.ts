// Settings → Categories: rename, reorder and remove categories and groups, on the seeded November budget.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BudgetView, CategoriesView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const call = async (method: string, p: string, body?: unknown) => {
  const r = await SELF.fetch(`https://ledgerline.test${p}`, {
    method,
    headers: method === 'GET' ? {} : H,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const cats = async () => (await call('GET', '/api/settings/categories')).json as unknown as CategoriesView;
const mine = async () => (await cats()).groups.filter((g) => !g.system);

describe('categories and groups', () => {
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
  });

  it('renames a group and a category', async () => {
    const g = (await mine())[0]!;
    expect(
      (await call('POST', '/api/settings/groups', { id: g.id, name: 'Renamed group', isBills: g.isBills }))
        .status,
    ).toBe(200);
    const c = g.categories[0]!;
    expect(
      (
        await call('POST', '/api/settings/categories', {
          id: c.id,
          name: 'Renamed cat',
          groupId: g.id,
          kind: 'spending',
        })
      ).status,
    ).toBe(200);
    const after = (await mine()).find((x) => x.id === g.id)!;
    expect(after.name).toBe('Renamed group');
    expect(after.categories.find((x) => x.id === c.id)!.name).toBe('Renamed cat');
  });

  it('reorders groups and categories, and the budget follows', async () => {
    const before = await mine();
    const ids = before.map((g) => g.id).reverse();
    expect((await call('POST', '/api/settings/groups/reorder', { ids })).status).toBe(200);
    expect((await mine()).map((g) => g.id)).toEqual(ids);
    const b = (await call('GET', '/api/budget/2026-11')).json as unknown as BudgetView;
    const budgetOrder = b.groups.map((g) => g.id).filter((id) => ids.includes(id));
    expect(budgetOrder).toEqual(ids);

    const g = (await mine())[0]!;
    const order = (await mine()).flatMap((x) => x.categories.map((c) => c.id));
    const [a, c2] = [g.categories[0]!.id, g.categories[1]!.id];
    const swapped = order.map((id) => (id === a ? c2 : id === c2 ? a : id));
    expect((await call('POST', '/api/settings/categories/reorder', { ids: swapped })).status).toBe(200);
    const now = (await mine())[0]!.categories.map((c) => c.id);
    expect(now.slice(0, 2)).toEqual([c2, a]);
  });

  it('removing a never-used category deletes it; one with history is archived', async () => {
    const g = (await mine())[0]!;
    const add = await call('POST', '/api/settings/categories', {
      name: 'Brand new',
      groupId: g.id,
      kind: 'spending',
    });
    const id = String(add.json.id);
    expect((await call('POST', `/api/settings/categories/${id}/remove`)).json).toMatchObject({
      outcome: 'deleted',
    });
    const all = await cats();
    expect(all.groups.flatMap((x) => x.categories).some((c) => c.id === id)).toBe(false);
    expect(all.archived.some((c) => c.id === id)).toBe(false);

    const used = (await mine()).flatMap((x) => x.categories).find((c) => c.name === 'Dining out')!;
    expect((await call('POST', `/api/settings/categories/${used.id}/remove`)).json).toMatchObject({
      outcome: 'archived',
    });
    expect((await cats()).archived.some((c) => c.id === used.id)).toBe(true);
  });

  it('a group can be removed only once it is empty', async () => {
    const g = (await mine())[0]!;
    const r = await call('POST', `/api/settings/groups/${g.id}/remove`);
    expect(r.status).toBe(409);
    for (const c of g.categories) await call('POST', `/api/settings/categories/${c.id}/remove`);
    expect((await call('POST', `/api/settings/groups/${g.id}/remove`)).status).toBe(200);
    expect((await mine()).some((x) => x.id === g.id)).toBe(false);
  });

  it('card payment categories can’t be removed', async () => {
    const card = (await cats()).groups.find((g) => g.system)!.categories[0]!;
    expect((await call('POST', `/api/settings/categories/${card.id}/remove`)).status).toBe(422);
  });
});

describe('accounts', () => {
  it('rename; a card’s payment category follows', async () => {
    expect((await call('POST', '/api/accounts/sapphire/name', { name: '  Travel card ' })).status).toBe(200);
    const a = await env.DB.prepare(`SELECT name FROM account WHERE id = 'sapphire'`).first<{
      name: string;
    }>();
    expect(a!.name).toBe('Travel card');
    const c = await env.DB.prepare(
      `SELECT name FROM category WHERE card_account_id = 'sapphire' AND kind = 'cc_payment'`,
    ).first<{ name: string }>();
    expect(c!.name).toBe('Travel card');
    expect((await call('POST', '/api/accounts/sapphire/name', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/api/accounts/nope/name', { name: 'X' })).status).toBe(404);
  });
});
