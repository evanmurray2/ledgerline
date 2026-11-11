// The server refuses one queued edit (docs/privacy.md 5.3, "Redoing a refused write"): the phone takes that edit
// and the ones after it out of its copy, runs the later ones again, and ends with what the server will have once
// the kept edits are sent. Nothing is downloaded again.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine, QueuedEdit } from '../src/local/engine.js';
import { syncPhone } from './phone.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = (e: QueuedEdit) =>
  SELF.fetch(`${ORIGIN}${e.path}`, {
    method: e.method,
    headers: { ...H, 'x-edit-id': e.id, 'x-edit-at': String(e.at) },
    body: JSON.stringify(e.body),
  });

describe('a refused edit in the queue', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  let n = 0;

  /** Runs an edit on the phone as the app does offline, and gives the queue entry. */
  const offline = async (method: string, path: string, body: unknown): Promise<QueuedEdit> => {
    const st = await a.state();
    const edit = { id: `drop-edit-${++n}-xxxxxx`, at: Date.now() + st.offset - 60_000 + n };
    const r = await a.record(method, path, body, edit);
    expect(r.response.status, await r.response.clone().text()).toBeLessThan(300);
    return { ...edit, method, path, body, undo: r.undo, through: st.through };
  };

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
  });

  it('is taken out, the later edits run again, and the copy matches the server', async () => {
    // Offline: assign, add an entry, edit that entry, add a category, assign to it.
    const assign = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 500 }],
    });
    const entry = await offline('POST', '/api/transactions', {
      kind: 'pending',
      accountId: 'checking',
      date: '2026-11-10',
      amount: -4321,
      payee: 'Refused cafe',
      categoryId: 'rent',
      repeats: 'never',
    });
    const key = (await a.db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Refused cafe'`)
      .first<{ txn_key: string }>())!.txn_key;
    const note = await offline('PATCH', `/api/transactions/${key}`, { note: 'on the refused entry' });
    const category = await offline('POST', '/api/settings/categories', {
      name: 'Kept category',
      groupId: null,
      kind: 'spending',
    });
    const move = await offline('POST', '/api/budget/move', {
      month: '2026-11',
      from: 'rent',
      to: 'electric',
      amount: 100,
    });

    // Back online. The server takes the first edit and, in this test, refuses the entry (it is never sent).
    expect((await send(assign)).status).toBe(200);
    const { kept, lost } = await a.dropEdit(entry, [note, category, move]);
    // The edit of the refused entry has nothing to act on; the other two stand.
    expect(lost.map((e) => e.id)).toEqual([note.id]);
    expect(kept.map((e) => e.id)).toEqual([category.id, move.id]);
    const gone = await a.db
      .prepare(`SELECT count(*) AS n FROM manual_pending WHERE payee_name = 'Refused cafe'`)
      .first<{ n: number }>();
    expect(gone!.n).toBe(0);

    // The kept edits go to the server; a second phone that only syncs ends with the same rows.
    for (const e of kept) expect((await send(e)).status).toBe(200);
    await syncPhone(b);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    // And the first phone's next sync changes nothing.
    await syncPhone(a);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });

  it('a kept edit can be taken out again later', async () => {
    const first = await offline('POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'rent',
      assigned: 111,
    });
    const second = await offline('POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'electric',
      assigned: 222,
    });
    const third = await offline('POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'internet',
      assigned: 333,
    });
    const one = await a.dropEdit(first, [second, third]);
    expect(one.kept.length).toBe(2);
    const two = await a.dropEdit(one.kept[0]!, [one.kept[1]!]);
    expect(two.kept.length).toBe(1);
    expect((await send(two.kept[0]!)).status).toBe(200);
    await syncPhone(b);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });
});
