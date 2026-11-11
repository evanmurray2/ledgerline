// An offline edit that makes a new row (a target for a month that had none) and is then sent to the server: the copy
// must take the server's row for it, and go on syncing. The server gives the row its own id, so the two rows differ
// by id and are the same by (category, month).
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine } from '../src/local/engine.js';
import { phone, syncPhone } from './phone.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = (method: string, path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method, headers: H, body: JSON.stringify(body) });

describe('an offline target, sent later', () => {
  let engine: LocalEngine;
  let category: string;
  const month = '2027-03';

  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    engine = await syncPhone(await phone());
    const cats = (await (await engine.request('GET', '/api/settings/categories')).json()) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    category = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!.id;
  });

  it('the copy takes the server’s row and keeps syncing', async () => {
    const body = { categoryId: category, month, target: { type: 'set_aside', amount: 12345 } };
    const path = `/api/categories/${category}/target`;
    // Offline: the engine makes the row, with an id of its own.
    expect((await engine.request('PUT', path, body)).status).toBe(200);
    const local = await engine.db
      .prepare(`SELECT id FROM target WHERE category_id = ?1 AND effective_from = ?2`)
      .bind(category, month)
      .all<{ id: string }>();
    expect(local.results.length).toBe(1);
    // Back online: the same edit goes to the server, which makes the row with another id.
    expect((await send('PUT', path, body)).status).toBe(200);
    // The copy syncs: it must not stop on the row it already holds under the other id.
    await syncPhone(engine);
    const after = await engine.db
      .prepare(`SELECT id, amount FROM target WHERE category_id = ?1 AND effective_from = ?2`)
      .bind(category, month)
      .all<{ id: string; amount: number }>();
    expect(after.results.length).toBe(1);
    expect(after.results[0]!.amount).toBe(12345);
    // And a later change still arrives.
    expect((await send('PUT', path, { ...body, target: { type: 'set_aside', amount: 500 } })).status).toBe(
      200,
    );
    await syncPhone(engine);
    const later = await engine.db
      .prepare(`SELECT amount FROM target WHERE category_id = ?1 AND effective_from = ?2`)
      .bind(category, month)
      .first<{ amount: number }>();
    expect(later!.amount).toBe(500);
  });
});
