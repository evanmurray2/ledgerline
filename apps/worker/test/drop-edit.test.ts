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

  // The app keeps its queue in the copy (`local_state`, key `outbox`): the engine reads it when a sync arrives.
  const putQueue = (q: QueuedEdit[]) =>
    a.db
      .prepare(
        `INSERT INTO local_state (key, value) VALUES ('outbox', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(q))
      .run();
  const getQueue = async () =>
    JSON.parse(
      (await a.db.prepare(`SELECT value FROM local_state WHERE key = 'outbox'`).first<{ value: string }>())!
        .value,
    ) as QueuedEdit[];
  const other = (method: string, path: string, body: unknown) =>
    SELF.fetch(`${ORIGIN}${path}`, { method, headers: H, body: JSON.stringify(body) });
  const assigned = async (e: LocalEngine, category: string) =>
    (await e.db
      .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = ?1`)
      .bind(category)
      .first<{ amount: number }>())!.amount;

  it('a sync goes under the queue: the server’s rows, then the queued edits again', async () => {
    await syncPhone(a);
    await syncPhone(b);
    // Offline on this phone: add 500 to Rent, and an entry with a note.
    const add = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 500 }],
    });
    const entry = await offline('POST', '/api/transactions', {
      kind: 'pending',
      accountId: 'checking',
      date: '2026-11-11',
      amount: -777,
      payee: 'Under the queue',
      categoryId: 'electric',
      repeats: 'never',
    });
    await putQueue([add, entry]);
    // Meanwhile another device sets Rent to 1,000.00 on the server.
    expect(
      (await other('POST', '/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 100_000 }))
        .status,
    ).toBe(200);

    await syncPhone(a);
    // The other device's amount, then this phone's 500 on top: what the server will hold once the queue is sent.
    expect(await assigned(a, 'rent')).toBe(100_500);
    const q = await getQueue();
    expect(q.map((e) => e.id)).toEqual([add.id, entry.id]);
    expect(q.every((e) => e.through === q[0]!.through && e.through > add.through)).toBe(true);

    for (const e of q) expect((await send(e)).status).toBe(200);
    await putQueue([]);
    await syncPhone(a);
    await syncPhone(b);
    expect(await assigned(b, 'rent')).toBe(100_500);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  });

  it('a queued edit of a row the server removed is lost, and says so', async () => {
    const made = await other('POST', '/api/transactions', {
      kind: 'pending',
      accountId: 'checking',
      date: '2026-11-12',
      amount: -150,
      payee: 'Soon gone',
      categoryId: 'electric',
      repeats: 'never',
    });
    expect(made.status).toBe(200);
    await syncPhone(a);
    const key = (await a.db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Soon gone'`)
      .first<{ txn_key: string }>())!.txn_key;
    const note = await offline('PATCH', `/api/transactions/${key}`, { note: 'too late' });
    const keep = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'internet', amount: 25 }],
    });
    await putQueue([note, keep]);
    expect((await other('DELETE', `/api/transactions/${key}`, {})).status).toBe(200);

    const { since } = await a.nextRequest();
    const page = (await (
      await SELF.fetch(`${ORIGIN}/api/sync?since=${since}&limit=200`)
    ).json()) as Parameters<LocalEngine['apply']>[0];
    const res = await a.apply(page);
    expect(res.lost).toBe(1);
    expect((await getQueue()).map((e) => e.id)).toEqual([keep.id]);

    // An edit on its way to the server is never run again by the copy: the page goes over it, as before.
    const sending = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'internet', amount: 1 }],
    });
    await putQueue([...(await getQueue()), { ...sending, sending: true }]);
    expect(
      (await other('POST', '/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 5 })).status,
    ).toBe(200);
    const next = await a.nextRequest();
    const page2 = (await (
      await SELF.fetch(`${ORIGIN}/api/sync?since=${next.since}&limit=200`)
    ).json()) as Parameters<LocalEngine['apply']>[0];
    expect((await a.apply(page2)).lost).toBeUndefined();
  });
});
