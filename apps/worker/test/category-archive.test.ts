// Archive, remove and restore with money; names; assigning past the largest amount or against a stale view.
import { app, syncPhone, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CategoriesView } from '@ledgerline/contracts';

const db = phoneDb();
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const call = async (method: string, p: string, body?: unknown) => {
  const r = await app(p, {
    method,
    headers: method === 'GET' ? {} : H,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const cats = async () => (await call('GET', '/api/settings/categories')).json as unknown as CategoriesView;
const assigned = async (id: string, month: string) =>
  (await db
    .prepare(`SELECT coalesce(sum(amount), 0) AS n FROM assignment WHERE category_id = ?1 AND month = ?2`)
    .bind(id, month)
    .first<{ n: number }>())!.n;
/** What a phone sends with an archive: the available it shows and its change number. */
const shown = async (id: string) => {
  const e = await syncPhone();
  const sheet = (await (await e.request('GET', `/api/categories/${id}/sheet`)).json()) as {
    available: number;
  };
  return { available: sheet.available, through: (await e.state()).through };
};

describe('archive and restore with money', () => {
  let month: string;
  let next: string;
  beforeAll(async () => {
    expect((await call('POST', '/__dev/seed-november')).status).toBe(200);
    month = ((await call('GET', '/api/session')).json as { budget: { currentMonth: string } }).budget
      .currentMonth;
    const [y, m] = month.split('-').map(Number) as [number, number];
    next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  });

  it('Remove sends this month’s money and later months’ assignments to Ready to Assign; Undo gives them back', async () => {
    expect(
      (await call('POST', '/api/budget/set', { month: next, categoryId: 'rent', assigned: 12_345 })).status,
    ).toBe(200);
    const before = { now: await assigned('rent', month), later: await assigned('rent', next) };
    const sent = await shown('rent');
    expect(sent.available).toBeGreaterThan(0);
    const r = await call('POST', '/api/settings/categories/rent/remove', sent);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      outcome: 'archived',
      returned: [
        { month, amount: sent.available },
        { month: next, amount: 12_345 },
      ],
    });
    expect(await assigned('rent', month)).toBe(before.now - sent.available);
    expect(await assigned('rent', next)).toBe(0);

    const undo = await call('POST', '/api/settings/categories/rent/archive', {
      archived: false,
      giveBack: r.json.returned,
    });
    expect(undo.status).toBe(200);
    expect(await assigned('rent', month)).toBe(before.now);
    expect(await assigned('rent', next)).toBe(before.later);
    expect((await shown('rent')).available).toBe(sent.available);
    // An Undo sent twice gives the money back once.
    const again = await call('POST', '/api/settings/categories/rent/archive', {
      archived: false,
      giveBack: r.json.returned,
    });
    expect(again.status).toBe(409);
    expect(await assigned('rent', month)).toBe(before.now);
  });

  it('a restore brings back the group that was removed meanwhile', async () => {
    const g = String(
      (await call('POST', '/api/settings/groups', { name: 'Hobbies', isBills: false })).json.id,
    );
    const c = String(
      (await call('POST', '/api/settings/categories', { name: 'Kites', groupId: g, kind: 'spending' })).json
        .id,
    );
    expect((await call('POST', '/api/budget/set', { month, categoryId: c, assigned: 500 })).status).toBe(200);
    expect((await call('POST', `/api/settings/categories/${c}/remove`, await shown(c))).json).toMatchObject({
      outcome: 'archived',
    });
    expect((await call('POST', `/api/settings/groups/${g}/remove`)).status).toBe(200);
    expect((await cats()).groups.some((x) => x.id === g)).toBe(false);

    expect((await call('POST', `/api/settings/categories/${c}/archive`, { archived: false })).status).toBe(
      200,
    );
    const back = (await cats()).groups.find((x) => x.id === g);
    expect(back?.categories.map((x) => x.id)).toEqual([c]);
  });

  it('an archived category says the month it was archived, in words', async () => {
    expect(
      (await call('POST', '/api/settings/categories/vacation/remove', await shown('vacation'))).status,
    ).toBe(200);
    const a = (await cats()).archived.find((x) => x.id === 'vacation');
    expect(a?.meta).toMatch(/^Archived [A-Z][a-z]+ 20\d\d$/);
  });
});

describe('category names', () => {
  it('a second category with a name already used is refused, whatever the case', async () => {
    const g = (await cats()).groups.find((x) => !x.system)!;
    const r = await call('POST', '/api/settings/categories', {
      name: 'GROCERIES',
      groupId: g.id,
      kind: 'spending',
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('duplicate');
    // An archived one too, with a way out.
    const v = await call('POST', '/api/settings/categories', {
      name: 'Vacation',
      groupId: g.id,
      kind: 'spending',
    });
    expect(v.status).toBe(409);
    expect(String(v.json.message)).toContain('Restore it');
    // Saving a category with its own name (another field changed) is fine.
    expect(
      (
        await call('POST', '/api/settings/categories', {
          id: 'groceries',
          name: 'Groceries',
          groupId: g.id,
          kind: 'spending',
        })
      ).status,
    ).toBe(200);
  });

  it('control and direction characters are taken out of a name; one with nothing left is refused', async () => {
    const g = (await cats()).groups.find((x) => !x.system)!;
    const r = await call('POST', '/api/settings/categories', {
      name: ' Bo\u202eats\u200b  club ',
      groupId: g.id,
      kind: 'spending',
    });
    expect(r.status).toBe(200);
    const row = await db
      .prepare(`SELECT name FROM category WHERE id = ?1`)
      .bind(String(r.json.id))
      .first<{ name: string }>();
    expect(row!.name).toBe('Boats club');
    const empty = await call('POST', '/api/settings/groups', { name: '\u202e\u200b', isBills: false });
    expect(empty.status).toBe(422);
  });

  it('renaming a group that isn’t there says so', async () => {
    const r = await call('POST', '/api/settings/groups', { id: 'nope', name: 'X', isBills: false });
    expect(r.status).toBe(404);
  });
});

describe('assigning', () => {
  it('no category can pass the largest amount, however it is reached', async () => {
    const month = '2026-11';
    expect(
      (await call('POST', '/api/budget/set', { month, categoryId: 'groceries', assigned: 9_999_999_000 }))
        .status,
    ).toBe(200);
    const r = await call('POST', '/api/budget/assign', {
      month,
      items: [{ categoryId: 'groceries', amount: 10_000 }],
    });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('too_large');
    // Taking some back still works.
    expect(
      (await call('POST', '/api/budget/move', { month, from: 'groceries', to: 'rta', amount: 10_000 }))
        .status,
    ).toBe(200);
  });

  it('an add sent with what the device saw is refused once that changed', async () => {
    const month = '2026-11';
    const was = await assigned('dining', month);
    const add = { month, items: [{ categoryId: 'dining', amount: 100, was }] };
    expect((await call('POST', '/api/budget/assign', add)).status).toBe(200);
    // The same tap from a second tab, drawn before the first one: refused, not added twice.
    const twice = await call('POST', '/api/budget/assign', add);
    expect(twice.status).toBe(409);
    expect(twice.json.error).toBe('changed');
    expect(await assigned('dining', month)).toBe(was + 100);
  });
});
