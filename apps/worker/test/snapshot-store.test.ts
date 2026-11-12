// The server's store of sealed snapshots (src/seal/snapshot-store.ts): it takes a snapshot only from a holder
// of the budget's signing key, standing at an entry the log holds; a snapshot counts as checked only with a
// device's signed check record; and one rule deletes what is older.
import {
  afterRun,
  deriveBudgetKeys,
  encodeEntry,
  KIND,
  openRun,
  randomBytes,
  sealSnapshot,
  signSnapshotCheck,
  type Bytes,
  type Entry,
} from '@ledgerline/seal';
import { ulid } from '@ledgerline/platform';
import { describe, expect, it } from 'vitest';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import { beginSealedRun, lastCompleteRun, receiptHashes, sealedPageOf } from '../src/seal/runs.js';
import {
  logFloor,
  snapshotBegin,
  snapshotCheck,
  snapshotChunk,
  snapshotChunkOf,
  snapshotList,
  snapshotManifest,
  snapshotPrune,
  type SnapshotDeps,
} from '../src/seal/snapshot-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { handed, LINK_A, world, type World } from './sealed-world.js';

const OTHER = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

/** The log grows by `n` edits, written by the world's device. */
async function edits(x: World, n: number, now: number): Promise<Entry[]> {
  const out: Entry[] = [];
  // The device's clock is the server's: an entry dated far from it is refused.
  x.w.time = Math.max(x.w.time, now - 60_000);
  for (let i = 0; i < n; i++) {
    const base = await logHead(x.db);
    const e = await x.w.edit(`edit ${base + 1}`, { filedThrough: x.w.last!.header.filedThrough });
    const r = await logAppend(
      {
        db: x.db,
        budgetId: BUDGET,
        now,
        resting: false,
        freshWay: false,
        lastCompleteRun: await lastCompleteRun(x.db),
        receiptHashes: (from, to) => receiptHashes(x.db, from, to),
      },
      base,
      [encodeEntry(e)],
    );
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    out.push(e);
  }
  return out;
}

/** A snapshot of two chunks standing at entry `at`, sealed by the world's device. */
async function snapshot(x: World, at: Entry, o: { budgetId?: string; keys?: World['w']['keys'] } = {}) {
  const genesis = (await logAfter(x.db, 0, 1))[0]!;
  const { readEntry } = await import('@ledgerline/seal');
  const first = await readEntry(genesis.bytes);
  return sealSnapshot(
    o.keys ?? x.w.keys,
    {
      budgetId: o.budgetId ?? BUDGET,
      snapshotId: ulid(T0),
      number: at.header.number,
      entryHash: at.hash,
      lastPublic: { number: 1, hash: first.hash },
      tables: [{ name: 'budget', hash: randomBytes(32) }],
      checkpoints: [{ number: at.header.number, hash: at.hash }],
      counters: [{ deviceId: PHONE, counter: at.header.number }],
    },
    [randomBytes(2000), randomBytes(700)],
  );
}

const deps = (x: World, now: number, resting = false): SnapshotDeps => ({
  db: x.db,
  budgetId: BUDGET,
  now,
  resting,
});

/** Stores a snapshot whole; gives its id. */
async function store(x: World, s: Awaited<ReturnType<typeof snapshot>>, now: number): Promise<string> {
  expect(await snapshotBegin(deps(x, now), { ...s, chunks: s.chunks.length })).toEqual({ ok: true });
  const id = (await x.db
    .prepare(`SELECT id FROM snapshot ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .first<{ id: string }>())!.id;
  for (const [i, c] of s.chunks.entries())
    expect(await snapshotChunk(deps(x, now), id, i + 1, c)).toEqual({ ok: true });
  return id;
}

const numbers = async (x: World) =>
  (await x.db.prepare(`SELECT number FROM log_entry ORDER BY number`).all<{ number: number }>()).results.map(
    (r) => r.number,
  );

describe('the store of sealed snapshots', () => {
  it('takes a snapshot only from the key in force, at an entry the log holds', async () => {
    await world(
      async (x) => {
        const [e2, e3] = await edits(x, 2, T0 + 5000);
        const now = T0 + 6000;
        const good = await snapshot(x, e3!);
        const begin = (
          s: { header: Bytes; signature: Bytes; manifest: Bytes },
          chunks = 2,
          d = deps(x, now),
        ) => snapshotBegin(d, { ...s, chunks });

        expect(await begin({ ...good, header: randomBytes(40) })).toEqual({ ok: false, why: 'not a header' });
        expect(await begin(await snapshot(x, e3!, { budgetId: OTHER }))).toEqual({
          ok: false,
          why: 'another budget',
        });
        // Signed by another key of the same version.
        const stranger = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
        expect(await begin(await snapshot(x, e3!, { keys: stranger }))).toEqual({
          ok: false,
          why: 'signature',
        });
        expect(await begin({ ...good, signature: randomBytes(64) })).toEqual({ ok: false, why: 'signature' });
        // A key version that is not in force.
        const v2 = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
        expect(await begin(await snapshot(x, e3!, { keys: v2 }))).toEqual({ ok: false, why: 'key version' });
        // An entry the log doesn't hold, or holds with another hash.
        const ghost = { ...e3!, hash: randomBytes(32) };
        expect(await begin(await snapshot(x, ghost))).toEqual({ ok: false, why: 'no such entry' });
        const ahead = { ...e3!, header: { ...e3!.header, number: 9 } };
        expect(await begin(await snapshot(x, ahead))).toEqual({ ok: false, why: 'no such entry' });
        expect(await begin(good, 0)).toEqual({ ok: false, why: 'too large' });
        expect(await begin(good, 5000)).toEqual({ ok: false, why: 'too large' });
        expect(await begin(good, 2, deps(x, now, true))).toEqual({ ok: false, why: 'resting' });
        expect(await snapshotList(x.db)).toEqual([]);

        // Begun, it is not offered until every chunk is stored.
        expect(await begin(good)).toEqual({ ok: true });
        expect(await begin(good)).toEqual({ ok: true });
        const id = (await x.db.prepare(`SELECT id FROM snapshot`).first<{ id: string }>())!.id;
        expect(await snapshotChunk(deps(x, now), id, 3, good.chunks[0]!)).toEqual({
          ok: false,
          why: 'chunk',
        });
        expect(await snapshotChunk(deps(x, now), id, 0, good.chunks[0]!)).toEqual({
          ok: false,
          why: 'chunk',
        });
        expect(await snapshotChunk(deps(x, now), id, 1, new Uint8Array(1_200_000))).toEqual({
          ok: false,
          why: 'too large',
        });
        expect(await snapshotChunk(deps(x, now), OTHER, 1, good.chunks[0]!)).toEqual({
          ok: false,
          why: 'no such snapshot',
        });
        expect(await snapshotChunk(deps(x, now), id, 2, good.chunks[1]!)).toEqual({ ok: true });
        expect(await snapshotList(x.db)).toEqual([]);
        expect(await snapshotManifest(x.db, id)).toBeNull();
        expect(await snapshotChunkOf(x.db, id, 2)).toBeNull();
        // Not whole: no check record is taken.
        const check = await signSnapshotCheck(x.w.keys, good, BUDGET, PHONE);
        expect(await snapshotCheck(deps(x, now), id, PHONE, check)).toEqual({ ok: false, why: 'not whole' });

        expect(await snapshotChunk(deps(x, now), id, 1, good.chunks[0]!)).toEqual({ ok: true });
        const list = await snapshotList(x.db);
        expect(list).toMatchObject([{ id, number: 3, chunks: 2, checked: false, check: null }]);
        expect([...list[0]!.header]).toEqual([...good.header]);
        expect([...(await snapshotManifest(x.db, id))!]).toEqual([...good.manifest]);
        expect([...(await snapshotChunkOf(x.db, id, 2))!]).toEqual([...good.chunks[1]!]);
        // Whole, it is never changed.
        expect(await snapshotChunk(deps(x, now), id, 2, randomBytes(10))).toEqual({ ok: true });
        expect([...(await snapshotChunkOf(x.db, id, 2))!]).toEqual([...good.chunks[1]!]);

        // The check record: signed for this header, by this budget's key, for the device it names.
        expect(await snapshotCheck(deps(x, now), id, PHONE, randomBytes(64))).toEqual({
          ok: false,
          why: 'signature',
        });
        expect(await snapshotCheck(deps(x, now), id, '01CX5ZZKBKACTAV9WEVGEMMVRZ', check)).toEqual({
          ok: false,
          why: 'signature',
        });
        expect(await snapshotCheck(deps(x, now), id, PHONE, check)).toEqual({ ok: true });
        expect(await snapshotList(x.db)).toMatchObject([{ id, checked: true, check: { deviceId: PHONE } }]);
        // An older snapshot than the newest whole one is not taken.
        expect(await begin(await snapshot(x, e2!))).toEqual({ ok: false, why: 'older than a snapshot' });
      },
      { described: false },
    );
  });

  it('a snapshot that was begun and left makes way for the next', async () => {
    await world(
      async (x) => {
        const [, e3] = await edits(x, 2, T0 + 5000);
        const left = await snapshot(x, e3!);
        expect(await snapshotBegin(deps(x, T0 + 6000), { ...left, chunks: 2 })).toEqual({ ok: true });
        const id = (await x.db.prepare(`SELECT id FROM snapshot`).first<{ id: string }>())!.id;
        await snapshotChunk(deps(x, T0 + 6000), id, 1, left.chunks[0]!);
        const next = await store(x, await snapshot(x, e3!), T0 + 7000);
        expect(next).not.toBe(id);
        expect((await x.db.prepare(`SELECT count(*) AS n FROM snapshot`).first<{ n: number }>())!.n).toBe(1);
        expect(
          (await x.db
            .prepare(`SELECT count(*) AS n FROM snapshot_chunk WHERE snapshot_id = ?1`)
            .bind(id)
            .first<{ n: number }>())!.n,
        ).toBe(0);
        // Only so many in a day.
        for (let i = 0; i < 4; i++) await store(x, await snapshot(x, e3!), T0 + 8000 + i);
        expect(await snapshotBegin(deps(x, T0 + 9000), { ...(await snapshot(x, e3!)), chunks: 2 })).toEqual({
          ok: false,
          why: 'limit',
        });
      },
      { described: false },
    );
  });

  it('deletes by one rule: the snapshot before the newest checked one stays, with everything since', async () => {
    await world(async (x) => {
      // The world's two runs are filed by a bank entry, then edits follow.
      const fresh = {
        ...x.filing,
        filedThrough: 0,
        lastManifestHash: new Uint8Array(32),
        lastRunTime: 0,
        lastInboxVersion: 0,
        cursors: new Map(),
      };
      const one = await openRun(fresh, await handed(x.db, 1));
      const two = await openRun(afterRun(fresh, one), await handed(x.db, 2));
      x.w.time = T0 + 4000;
      const bank = await x.w.entry(KIND.bank, 'two runs', {
        filedThrough: 2,
        receipts: [one.receipt, two.receipt],
      });
      const day = 86_400_000;
      expect(
        await logAppend(
          {
            db: x.db,
            budgetId: BUDGET,
            now: T0 + 5000,
            resting: false,
            freshWay: false,
            lastCompleteRun: 2,
            receiptHashes: (from, to) => receiptHashes(x.db, from, to),
          },
          1,
          [encodeEntry(bank)],
        ),
      ).toMatchObject({ ok: true, number: 2 });
      const [, e4] = await edits(x, 2, T0 + 6000);
      expect(await numbers(x)).toEqual([1, 2, 3, 4]);

      // The first snapshot, checked: there is no older one, so nothing goes.
      const s1 = await store(x, await snapshot(x, e4!), T0 + 7000);
      expect(
        await snapshotCheck(
          deps(x, T0 + 7000),
          s1,
          PHONE,
          await signSnapshotCheck(x.w.keys, (await snapshotList(x.db))[0]!, BUDGET, PHONE),
        ),
      ).toEqual({ ok: true });
      expect(await snapshotPrune(x.db)).toEqual({ deleted: 0, more: false });
      expect(await logFloor(x.db)).toBe(0);

      // A second snapshot, whole and not checked: still nothing goes.
      const [, , e7] = await edits(x, 3, T0 + day);
      const s2 = await store(x, await snapshot(x, e7!), T0 + day + 1000);
      expect(await snapshotPrune(x.db)).toEqual({ deleted: 0, more: false });
      expect(await sealedPageOf(x.db, 1, 0)).not.toBeNull();

      // Checked: the first snapshot is the one kept before it. Sealed entries before entry 4 go (not the first
      // entry, which is public), and the pages of the runs that entry 4 says are filed.
      const list2 = await snapshotList(x.db);
      expect(list2.map((s) => s.id)).toEqual([s2, s1]);
      expect(
        await snapshotCheck(
          deps(x, T0 + day + 2000),
          s2,
          PHONE,
          await signSnapshotCheck(x.w.keys, list2[0]!, BUDGET, PHONE),
        ),
      ).toEqual({ ok: true });
      expect(await snapshotPrune(x.db)).toMatchObject({ more: false });
      expect(await numbers(x)).toEqual([1, 4, 5, 6, 7]);
      expect(await logFloor(x.db)).toBe(4);
      expect((await snapshotList(x.db)).map((s) => s.id)).toEqual([s2, s1]);
      expect(await sealedPageOf(x.db, 1, 0)).toBeNull();
      expect(await sealedPageOf(x.db, 2, 0)).toBeNull();
      // The runs' manifests and receipt hashes stay, and the next run still begins.
      expect((await receiptHashes(x.db, 1, 2))!.length).toBe(2);
      expect(await beginSealedRun(x.d, LINK_A, T0 + day + 3000)).toMatchObject({ run: 3 });

      // A third, checked: the second is kept, and the first goes with its chunks.
      const [, e9] = await edits(x, 2, T0 + 2 * day);
      const s3 = await store(x, await snapshot(x, e9!), T0 + 2 * day + 1000);
      expect(
        await snapshotCheck(
          deps(x, T0 + 2 * day + 2000),
          s3,
          PHONE,
          await signSnapshotCheck(x.w.keys, (await snapshotList(x.db))[0]!, BUDGET, PHONE),
        ),
      ).toEqual({ ok: true });
      await snapshotPrune(x.db);
      expect((await snapshotList(x.db)).map((s) => s.id)).toEqual([s3, s2]);
      expect(await snapshotChunkOf(x.db, s1, 1)).toBeNull();
      expect(await numbers(x)).toEqual([1, 7, 8, 9]);
      expect(await logFloor(x.db)).toBe(7);
      // Run again, it deletes nothing more.
      expect(await snapshotPrune(x.db)).toEqual({ deleted: 0, more: false });
    });
  });
});
