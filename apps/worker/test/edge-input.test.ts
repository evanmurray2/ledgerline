// What the API does with input the app never sends: dates that don't exist, months thousands of years away, sync
// paging values out of range and cursors it didn't write. Each is refused with a plain answer, never a server error,
// a page with no limit, or a month the phone could never finish working out.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, syncPhone } from './phone.js';
import { SYNC_TABLES } from '../src/sync-tables.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = async (method: string, path: string, body?: unknown) => {
  const r = await app(path, { method, headers: H, body: JSON.stringify(body ?? {}) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const read = async (path: string) => {
  const r = await app(path);
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
/** The server itself, not the phone's copy. */
const server = (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);

const entry = (date: string) => ({
  kind: 'upcoming',
  accountId: 'checking',
  date,
  amount: -1500,
  payee: 'Gym',
  categoryId: null,
  repeats: 'never',
});

describe('input the app never sends', () => {
  beforeAll(async () => {
    const r = await server('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
  });

  it('a date that isn’t on the calendar is refused', async () => {
    for (const date of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-11-00', '2027-02-29'])
      expect((await send('POST', '/api/transactions', entry(date))).status, date).toBe(400);
    expect((await send('POST', '/api/owed/nope', { action: 'snooze', expectBy: '2026-11-31' })).status).toBe(
      400,
    );
    // A leap day is a real date.
    expect((await send('POST', '/api/transactions', entry('2028-02-29'))).status).toBe(200);
  });

  it('a month or date more than 10 years away is refused, and Budget still opens', async () => {
    expect(
      await send('POST', '/api/budget/assign', {
        month: '9999-12',
        items: [{ categoryId: 'dining', amount: 100 }],
      }),
    ).toMatchObject({ status: 422, json: { error: 'too_far' } });
    expect(
      (await send('POST', '/api/budget/set', { month: '2036-12', categoryId: 'dining', assigned: 100 }))
        .status,
    ).toBe(422);
    expect(await send('POST', '/api/transactions', entry('9999-12-31'))).toMatchObject({
      status: 422,
      json: { error: 'too_far' },
    });
    const pay = (await read('/api/activity?filter=attention')).json as { needsCategory: { key: string }[] };
    const key = pay.needsCategory[0]!.key;
    expect((await send('PATCH', `/api/transactions/${key}`, { budgetMonth: '9999-12' })).status).toBe(422);
    for (const path of ['/api/budget/9999-12', '/api/budget/9999-12/assign', '/api/reports?month=9999-12'])
      expect((await read(path)).status, path).toBe(400);
    expect((await read('/api/budget/2026-11')).json).toMatchObject({ rta: 98190, maxMonth: '2026-12' });
    expect((await read('/api/budget/2036-11')).status).toBe(200);
  });

  it('a sync page always has a limit, whatever limit is asked for', async () => {
    await syncPhone();
    for (const limit of ['-1', '0', '0.5', '1.5', 'abc', '1e9', 'Infinity']) {
      for (const since of ['0', '1']) {
        const r = await server(`/api/sync?since=${since}&limit=${limit}`);
        expect(r.status, `since=${since} limit=${limit}`).toBe(200);
        const p = (await r.json()) as { rows: unknown[]; more: boolean; through: number };
        expect(p.rows.length, `since=${since} limit=${limit}`).toBeGreaterThan(0);
        expect(p.rows.length, `since=${since} limit=${limit}`).toBeLessThanOrEqual(500);
        // An incremental page reads at most the page size of the change log.
        if (since === '1') expect(p.through - 1).toBeLessThanOrEqual(500);
      }
    }
    const one = (await (await server('/api/sync?since=0&limit=1.5')).json()) as { rows: unknown[] };
    expect(one.rows).toHaveLength(1);
  });

  it('a sync cursor this server didn’t write is refused, not a server error', async () => {
    const first = SYNC_TABLES[0]!;
    for (const cur of [
      { t: 0, after: [], through: 0 },
      { t: 0, after: [...first.pk, 'extra'], through: 0 },
      { t: 0, after: first.pk.map(() => ({ a: 1 })), through: 0 },
      { t: 0, after: first.pk.map(() => null), through: 0 },
      { t: SYNC_TABLES.length + 3, after: ['x'], through: 0 },
      { t: -1, after: null, through: 0 },
      'not an object',
    ]) {
      const r = await server(`/api/sync?since=0&cursor=${encodeURIComponent(JSON.stringify(cur))}`);
      expect(r.status, JSON.stringify(cur)).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'invalid' });
    }
    // A cursor past the last table is simply the end.
    const end = { t: SYNC_TABLES.length, after: null, through: 7 };
    const r = await server(`/api/sync?since=0&cursor=${encodeURIComponent(JSON.stringify(end))}`);
    expect(await r.json()).toMatchObject({ more: false, cursor: null, rows: [], through: 7 });
  });

  it('Activity: a broken cursor is refused, and a very long search still answers', async () => {
    for (const cursor of ['zzz', '2026-99-99|000000000000001', '2026-11-01|1', ''])
      expect((await read(`/api/activity?cursor=${encodeURIComponent(cursor)}`)).status, cursor).toBe(400);
    const page = (await read('/api/activity')).json as { nextCursor: string | null };
    if (page.nextCursor)
      expect((await read(`/api/activity?cursor=${encodeURIComponent(page.nextCursor)}`)).status).toBe(200);
    for (const q of ['a'.repeat(5000), 'é'.repeat(60), '🍕'.repeat(30), 'Whole Foods Market'.repeat(4)])
      expect((await read(`/api/activity?q=${encodeURIComponent(q)}`)).status, q.slice(0, 8)).toBe(200);
    // The start of a long search still finds what it starts with.
    const hit = (
      await read(`/api/activity?q=${encodeURIComponent('Whole Foods' + ' '.repeat(10) + 'x'.repeat(80))}`)
    ).json as { needsCategory: unknown[] };
    expect(hit).toBeDefined();
  });

  it('a path or method the API doesn’t have answers JSON', async () => {
    for (const [method, path] of [
      ['DELETE', '/api/session'],
      ['PUT', '/api/budget/assign'],
      ['POST', '/api/nope'],
    ] as const) {
      const r = await server(path, { method, headers: H, body: '{}' });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(await r.json()).toMatchObject({ error: 'not_found' });
    }
  });
});
