// The routes of the sealed log (src/seal/log-routes.ts): they answer only for a budget marked sealed, and a
// sealed budget has no other routes.
import { ulid } from '@ledgerline/platform';
import {
  encodeEntry,
  randomBytes,
  readEntry,
  readSnapshotHeader,
  sealSnapshot,
  signSnapshotCheck,
} from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { logGenesis, logHead } from '../src/seal/log-store.js';
import { PHONE, Writer } from './log-writer.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('the routes of the sealed log', () => {
  let budget: string;
  let w: Writer;
  const seal = (on: boolean) =>
    on
      ? storeDb(budget)
          .prepare(`INSERT OR IGNORE INTO store_mark (key, at) VALUES ('sealed', ?1)`)
          .bind(NOW)
          .run()
      : storeDb(budget).prepare(`DELETE FROM store_mark`).run();

  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
    budget = ((await (await get('/api/session')).json()) as { budget: { id: string } }).budget.id;
    // The budget's first entry, as the cutover will store it.
    w = new Writer(budget, NOW - 60_000);
    const r = await logGenesis(
      {
        db: storeDb(budget),
        budgetId: budget,
        now: NOW,
        resting: false,
        freshWay: false,
        lastCompleteRun: 0,
        receiptHashes: async () => null,
      },
      encodeEntry(await w.genesis()),
    );
    expect(r).toMatchObject({ ok: true, number: 1 });
  });

  it('answer nothing for a budget that is not sealed', async () => {
    expect((await get('/api/log?after=0')).status).toBe(404);
    const e = await w.edit('not yet');
    expect((await post('/api/log/append', { base: 1, entries: [b64(encodeEntry(e))] })).status).toBe(404);
    expect(await logHead(storeDb(budget))).toBe(1);
    // That entry was never stored: the writer goes back to where the log is.
    w = Object.assign(new Writer(budget, NOW - 50_000), { keys: w.keys, bk: w.bk, last: null, counter: 1 });
  });

  it('a sealed budget: the log is read and written here, and nothing else answers', async () => {
    await seal(true);
    try {
      // No bank run is complete yet.
      expect(await (await get('/api/log/runs?after=0')).json()).toEqual({ runs: [], last: 0, more: false });
      expect((await get('/api/log/runs/1/0')).status).toBe(404);
      expect((await get('/api/log/runs?after=x')).status).toBe(400);
      const first = (await (await get('/api/log?after=0')).json()) as {
        entries: string[];
        number: number;
        more: boolean;
      };
      expect(first).toMatchObject({ number: 1, more: false });
      expect(first.entries.length).toBe(1);
      // The writer continues from the stored first entry.
      w.last = await readEntry(Uint8Array.from(atob(first.entries[0]!), (c) => c.charCodeAt(0)));

      const a = await w.edit('one');
      const b = await w.edit('two');
      const write = { base: 1, entries: [b64(encodeEntry(a)), b64(encodeEntry(b))] };
      const stored = await post('/api/log/append', write);
      expect(stored.status).toBe(200);
      expect(await stored.json()).toEqual({ ok: true, number: 3, stored: 'now' });
      // Sent again: stored already. On an older log: behind, with where the log stands.
      expect(await (await post('/api/log/append', write)).json()).toEqual({
        ok: true,
        number: 3,
        stored: 'already',
      });
      const late = await post('/api/log/append', {
        base: 1,
        entries: [b64(encodeEntry(await w.edit('three')))],
      });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ ok: false, why: 'behind', number: 3, retry: true });
      const after = (await (await get('/api/log?after=1')).json()) as { entries: string[]; number: number };
      expect(after.entries).toEqual(write.entries);

      // ---- a snapshot, over the routes: begun, its chunk stored, read back, checked
      expect(await (await get('/api/log/snapshots')).json()).toEqual({ snapshots: [] });
      const snap = await sealSnapshot(
        w.keys,
        {
          budgetId: budget,
          snapshotId: ulid(NOW),
          number: 3,
          entryHash: b.hash,
          lastPublic: { number: 1, hash: (await readEntry(unb64(first.entries[0]!))).hash },
          tables: [],
          checkpoints: [{ number: 3, hash: b.hash }],
          counters: [{ deviceId: PHONE, counter: 3 }],
        },
        [randomBytes(5000)],
      );
      const begin = {
        header: b64(snap.header),
        signature: b64(snap.signature),
        manifest: b64(snap.manifest),
        chunks: 1,
      };
      expect((await post('/api/log/snapshots', { ...begin, chunks: 0 })).status).toBe(400);
      const refusedSnap = await post('/api/log/snapshots', { ...begin, signature: b64(randomBytes(64)) });
      expect(refusedSnap.status).toBe(409);
      expect(await refusedSnap.json()).toEqual({ ok: false, why: 'signature' });
      expect(await (await post('/api/log/snapshots', begin)).json()).toEqual({ ok: true });
      const id = readSnapshotHeader(snap.header).snapshotId;
      const put = (k: number, body: Uint8Array) =>
        SELF.fetch(`${ORIGIN}/api/log/snapshots/${id}/chunks/${k}`, {
          method: 'PUT',
          headers: { origin: ORIGIN, 'x-ledgerline': '1', 'content-type': 'application/octet-stream' },
          body,
        });
      expect((await put(2, snap.chunks[0]!)).status).toBe(409);
      expect((await get(`/api/log/snapshots/${id}/manifest`)).status).toBe(404);
      // A chunk is a write like any other: no app header, no chunk.
      const noHeader = await SELF.fetch(`${ORIGIN}/api/log/snapshots/${id}/chunks/1`, {
        method: 'PUT',
        headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' },
        body: snap.chunks[0]!,
      });
      expect(noHeader.status).toBe(403);
      const elsewhere = await SELF.fetch(`${ORIGIN}/api/log/snapshots/${id}/chunks/1`, {
        method: 'PUT',
        headers: {
          origin: 'https://elsewhere.example',
          'x-ledgerline': '1',
          'content-type': 'application/octet-stream',
        },
        body: snap.chunks[0]!,
      });
      expect(elsewhere.status).toBe(403);
      expect(await (await put(1, snap.chunks[0]!)).json()).toEqual({ ok: true });
      const listed = (await (await get('/api/log/snapshots')).json()) as {
        snapshots: { id: string; number: number; header: string; chunks: number; checked: boolean }[];
      };
      expect(listed.snapshots).toMatchObject([
        { id, number: 3, header: begin.header, chunks: 1, checked: false },
      ]);
      const back = new Uint8Array(await (await get(`/api/log/snapshots/${id}/chunks/1`)).arrayBuffer());
      expect([...back]).toEqual([...snap.chunks[0]!]);
      expect([
        ...new Uint8Array(await (await get(`/api/log/snapshots/${id}/manifest`)).arrayBuffer()),
      ]).toEqual([...snap.manifest]);
      expect((await get(`/api/log/snapshots/${id}/chunks/2`)).status).toBe(404);
      // A check record names the snapshot it was built on. The budget's first snapshot has none, so it stays
      // unchecked; a record with a wrong signature, or with no base, is refused.
      const check = b64(await signSnapshotCheck(w.keys, snap, budget, PHONE));
      expect(
        (await post(`/api/log/snapshots/${id}/check`, { deviceId: PHONE, signature: check })).status,
      ).toBe(400);
      const forged = await post(`/api/log/snapshots/${id}/check`, {
        deviceId: PHONE,
        signature: b64(randomBytes(64)),
        base: id,
      });
      expect(await forged.json()).toEqual({ ok: false, why: 'signature' });
      const alone = await post(`/api/log/snapshots/${id}/check`, {
        deviceId: PHONE,
        signature: check,
        base: id,
      });
      expect(alone.status).toBe(409);
      expect(await alone.json()).toEqual({ ok: false, why: 'base' });
      expect(((await (await get('/api/log/snapshots')).json()) as typeof listed).snapshots[0]!.checked).toBe(
        false,
      );
      // The public entries, for a device that starts from a snapshot.
      expect(await (await get('/api/log/public?after=0')).json()).toMatchObject({ last: 1, more: false });
      // Nothing was deleted: there is no older snapshot.
      expect(await (await get('/api/log?after=0')).json()).toMatchObject({ number: 3, floor: 0 });

      // A body that is not a write, and a request with no CSRF header.
      expect((await post('/api/log/append', { base: 3, entries: ['not base64!'] })).status).toBe(400);
      const bare = await SELF.fetch(`${ORIGIN}/api/log/append`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(write),
      });
      expect(bare.status).toBe(403);

      // The old routes leave a sealed budget alone.
      expect((await get('/api/sync?since=0&limit=5')).status).toBe(409);
      expect(
        (await post('/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 1 })).status,
      ).toBe(409);
    } finally {
      await seal(false);
    }
    expect((await get('/api/sync?since=0&limit=5')).status).toBe(200);
  });
});
