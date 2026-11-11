// Ids are an input (docs/privacy.md 5.3): an edit run on the phone and then sent to the server, with the same edit
// id and time, makes the same new rows on both sides, id for id.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { phone, syncPhone } from './phone.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = (method: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method, headers: { ...H, ...extra }, body: JSON.stringify(body) });

describe('an edit names its own new rows', () => {
  let engine: LocalEngine;
  let category: string;

  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    engine = await syncPhone(await phone());
    const cats = (await (await engine.request('GET', '/api/settings/categories')).json()) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    category = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!.id;
  });

  const targetId = async (month: string) =>
    (
      await engine.db
        .prepare(`SELECT id FROM target WHERE category_id = ?1 AND effective_from = ?2`)
        .bind(category, month)
        .all<{ id: string }>()
    ).results.map((r) => r.id);

  it('the phone and the server give a new target the same id', async () => {
    const month = '2027-04';
    const body = { categoryId: category, month, target: { type: 'set_aside', amount: 4321 } };
    const path = `/api/categories/${category}/target`;
    const edit = { id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', at: Date.now() - 60_000 };

    expect((await engine.request('PUT', path, body, edit)).status).toBe(200);
    const local = await targetId(month);
    expect(local.length).toBe(1);

    // The queue sends the same edit, with its id and time.
    const r = await send('PUT', path, body, { 'x-edit-id': edit.id, 'x-edit-at': String(edit.at) });
    expect(r.status).toBe(200);
    await syncPhone(engine);
    expect(await targetId(month)).toEqual(local);

    // The server's row has that id too: the same edit run on a second phone finds it by id.
    const other = await syncPhone(await phone());
    const there = await other.db
      .prepare(`SELECT id FROM target WHERE category_id = ?1 AND effective_from = ?2`)
      .bind(category, month)
      .first<{ id: string }>();
    expect(there!.id).toBe(local[0]);
  });

  it('two edits give different ids, and an edit with no id gets a random one', async () => {
    const path = `/api/categories/${category}/target`;
    const make = async (month: string, edit?: { id: string; at: number }) => {
      const body = { categoryId: category, month, target: { type: 'set_aside', amount: 100 } };
      expect((await engine.request('PUT', path, body, edit)).status).toBe(200);
      return (await targetId(month))[0]!;
    };
    const at = Date.now();
    const a = await make('2027-05', { id: 'edit-aaaaaaaa', at });
    const b = await make('2027-06', { id: 'edit-bbbbbbbb', at });
    const c = await make('2027-07');
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
