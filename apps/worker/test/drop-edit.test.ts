// The queue of edits a phone made with no connection (docs/privacy.md 5.3, "Redoing a refused write"). The engine
// owns it: each change to it is one step. A refused edit is taken out of the copy and the later ones run again; a
// sync goes under the queue, not over it; and an edit the server may already hold is never run again by the copy.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalEngine, QueuedEdit } from '../src/local/engine.js';
import { syncPhone } from './phone.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The queue sends an edit: with its id and time, and no change number. */
const send = (e: QueuedEdit) =>
  SELF.fetch(`${ORIGIN}${e.path}`, {
    method: e.method,
    headers: { ...H, 'x-edit-id': e.id, 'x-edit-at': String(e.at) },
    body: JSON.stringify(e.body),
  });
/** Another device changes the server. */
const other = (method: string, path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method, headers: H, body: JSON.stringify(body) });

describe('the queue of offline edits', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  let n = 0;

  /** An edit made on the phone with no connection, as the app makes it. */
  const offline = async (method: string, path: string, body: unknown, sending = false): Promise<string> => {
    const st = await a.state();
    const id = `queued-edit-${++n}-xxxxxx`;
    const r = await a.enqueue({
      id,
      at: Date.now() + st.offset - 60_000 + n,
      method,
      path,
      body,
      ...(sending ? { sending: true } : {}),
    });
    expect(r.response.status, await r.response.clone().text()).toBeLessThan(300);
    return id;
  };
  const ids = async () => (await a.queue()).map((e) => e.id);
  /** Sends the whole queue, as the app does. */
  const flush = async () => {
    for (;;) {
      const e = (await a.queue())[0];
      if (!e) return;
      await a.queueSending(e.id);
      expect((await send(e)).status).toBe(200);
      await a.queueDone(e.id);
    }
  };
  const assigned = async (e: LocalEngine, category: string) =>
    (await e.db
      .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = ?1`)
      .bind(category)
      .first<{ amount: number }>())!.amount;
  const same = async () => {
    await syncPhone(a);
    await syncPhone(b);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
  };
  const entry = (payee: string, amount: number) => ({
    kind: 'pending',
    accountId: 'checking',
    date: '2026-11-10',
    amount,
    payee,
    categoryId: 'electric',
    repeats: 'never',
  });
  const keyOf = async (payee: string) =>
    (await a.db
      .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = ?1`)
      .bind(payee)
      .first<{ txn_key: string }>())!.txn_key;

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
  });

  it('a refused edit is taken out, the later ones run again, and the copy matches the server', async () => {
    const assign = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 500 }],
    });
    const added = await offline('POST', '/api/transactions', entry('Refused cafe', -4321));
    const note = await offline('PATCH', `/api/transactions/${await keyOf('Refused cafe')}`, {
      note: 'on it',
    });
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
    expect(await ids()).toEqual([assign, added, note, category, move]);

    // Back online: the server takes the first edit and, in this test, refuses the entry (it is never sent).
    const first = (await a.queue())[0]!;
    await a.queueSending(first.id);
    expect((await send(first)).status).toBe(200);
    await a.queueDone(first.id);
    await a.queueSending(added);
    const out = await a.queueRefused(added);
    // The note on the refused entry has nothing to act on; the other two stand.
    expect(out).toEqual({ redownload: false, lost: 1, left: 2 });
    expect(await ids()).toEqual([category, move]);
    const gone = await a.db
      .prepare(`SELECT count(*) AS n FROM manual_pending WHERE payee_name = 'Refused cafe'`)
      .first<{ n: number }>();
    expect(gone!.n).toBe(0);

    await flush();
    await same();
  });

  it('a sync goes under the queue: the server’s rows, then the queued edits again', async () => {
    await same();
    const add = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 500 }],
    });
    const added = await offline('POST', '/api/transactions', entry('Under the queue', -777));
    // Meanwhile another device sets Rent to 1,000.00.
    expect(
      (await other('POST', '/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 100_000 }))
        .status,
    ).toBe(200);
    await syncPhone(a);
    // The other device's amount, then this phone's 500 on top: what the server holds once the queue is sent.
    expect(await assigned(a, 'rent')).toBe(100_500);
    expect(await ids()).toEqual([add, added]);
    await flush();
    await same();
    expect(await assigned(b, 'rent')).toBe(100_500);
  });

  it('a queued edit of a row the server removed is lost, and the sync says so', async () => {
    expect((await other('POST', '/api/transactions', entry('Soon gone', -150))).status).toBe(200);
    await syncPhone(a);
    const key = await keyOf('Soon gone');
    await offline('PATCH', `/api/transactions/${key}`, { note: 'too late' });
    const keep = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'internet', amount: 25 }],
    });
    expect((await other('DELETE', `/api/transactions/${key}`, {})).status).toBe(200);
    const { since } = await a.nextRequest();
    const page = (await (
      await SELF.fetch(`${ORIGIN}/api/sync?since=${since}&limit=200`)
    ).json()) as Parameters<LocalEngine['apply']>[0];
    expect((await a.apply(page)).lost).toBe(1);
    expect(await ids()).toEqual([keep]);
    await flush();
    await same();
  });

  // The app sent an edit, the server took it, and the answer was lost. The app keeps the edit in the queue to
  // send again under the same id (apps/web/src/api/client.ts). A sync that arrives first brings the edit's own
  // rows: the copy must not run the edit again on top of them.
  it('an edit the server already holds is not run again by a sync', async () => {
    await same();
    const before = await assigned(a, 'rent');
    const st = await a.state();
    const edit: QueuedEdit = {
      id: 'answer-lost-0001',
      at: Date.now() + st.offset - 60_000,
      method: 'POST',
      path: '/api/budget/assign',
      body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 500 }] },
    };
    expect((await send(edit)).status).toBe(200); // the server has it; the phone never saw the answer
    const r = await a.enqueue({ ...edit, sending: true });
    expect(r.response.status).toBe(200);
    await syncPhone(a);
    expect(await assigned(a, 'rent')).toBe(before + 500);
    // The queue sends it again; the server answers that it had it; nothing is added twice anywhere.
    const again = await send((await a.queue())[0]!);
    expect(((await again.json()) as { repeated?: boolean }).repeated).toBe(true);
    await a.queueDone(edit.id);
    await same();
    expect(await assigned(b, 'rent')).toBe(before + 500);
  });

  it('after the copy is downloaded again, what was kept for an undo is not used', async () => {
    await same();
    const one = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 500 }],
    });
    const two = await offline('POST', '/api/budget/assign', {
      month: '2026-11',
      items: [{ categoryId: 'rent', amount: 100 }],
    });
    const server = await assigned(b, 'rent');
    // The copy is thrown away and downloaded again (as after a refusal that couldn't be undone exactly). The
    // queue stays, but the rows kept for taking its edits out belonged to the old copy.
    await a.clear();
    await syncPhone(a);
    expect((await a.queue()).every((e) => e.undo === undefined && e.through === undefined)).toBe(true);
    expect(
      (
        await other('POST', '/api/budget/assign', {
          month: '2026-11',
          items: [{ categoryId: 'internet', amount: 1 }],
        })
      ).status,
    ).toBe(200);
    await syncPhone(a);
    // Nothing was undone or run again: the copy shows the server's amount until the queue is sent.
    expect(await assigned(a, 'rent')).toBe(server);
    // A refusal now can't be undone exactly either: it asks for a download.
    await a.queueSending(one);
    expect((await a.queueRefused(one)).redownload).toBe(true);
    expect(await ids()).toEqual([two]);
    await flush();
    await same();
    expect(await assigned(b, 'rent')).toBe(server + 100);
  });
});
