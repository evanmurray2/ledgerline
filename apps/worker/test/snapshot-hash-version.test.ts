// A snapshot names the rules its table hashes follow (src/local/snapshot-tables.ts): this release writes its own
// version, opens a snapshot written before the rules had a number as version 1, and refuses one with rules it
// doesn't know as written by a newer app.
import { ulid } from '@ledgerline/platform';
import { startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import {
  dumpChunks,
  hashVersionOfChunk,
  openSnapshot,
  SnapshotFormatError,
  SnapshotNewer,
  tableHashes,
  TABLE_HASH_VERSION,
  type SnapshotTransport,
} from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { logAfter } from '../src/seal/log-store.js';
import {
  publicAfter,
  snapshotBegin,
  snapshotChunk,
  snapshotChunkOf,
  snapshotList,
  snapshotManifest,
} from '../src/seal/snapshot-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { syncPhone } from './phone.js';
import { world } from './sealed-world.js';
import { newPhone } from './twin.js';

const enc = (s: string) => new TextEncoder().encode(s);
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('the hash rules a snapshot was written with', () => {
  it('are named in its first line, and an older snapshot opens by its own', async () => {
    expect(TABLE_HASH_VERSION).toBe(1);
    expect(hashVersionOfChunk(enc('{"schema":{}}\n'))).toBe(1);
    expect(hashVersionOfChunk(enc('{"schema":{},"hash":1}\n'))).toBe(1);
    expect(() => hashVersionOfChunk(enc('{"schema":{},"hash":99}\n'))).toThrow(SnapshotNewer);
    expect(() => hashVersionOfChunk(enc('{"schema":{},"hash":"1"}\n'))).toThrow(SnapshotFormatError);

    await world(
      async (x) => {
        const clock = T0 + 10_000;
        const deps = () => ({ db: x.db, budgetId: BUDGET, now: clock, resting: false });
        const t: SnapshotTransport = {
          list: () => snapshotList(x.db),
          manifest: (id) => snapshotManifest(x.db, id),
          chunk: (id, k) => snapshotChunkOf(x.db, id, k),
          begin: (s) => snapshotBegin(deps(), s),
          put: (id, k, bytes) => snapshotChunk(deps(), id, k, bytes),
          check: async () => ({ ok: false }),
          publics: async () => (await publicAfter(x.db, 0, 1000)).map((e) => e.bytes),
          after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
        };
        const a = await syncPhone(await newPhone());
        const st = await a.state();
        await a.apply(
          {
            format: st.format,
            epoch: st.epoch!,
            serverTime: clock,
            through: 1,
            more: false,
            cursor: null,
            rows: [],
          },
          clock,
        );
        const logA = new DeviceLog(
          x.w.keys,
          await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
          PHONE,
          () => clock,
        );
        const plain = await dumpChunks(a.db);
        expect(JSON.parse(new TextDecoder().decode(plain[0]!).split('\n')[0]!)).toMatchObject({
          hash: TABLE_HASH_VERSION,
        });
        /** A snapshot of A whose first line is `first` in place of its own. */
        const store = async (first: (line: Record<string, unknown>) => Record<string, unknown>) => {
          const id = ulid(clock + Math.floor(Math.random() * 1000));
          const text = new TextDecoder().decode(plain[0]!);
          const cut = text.indexOf('\n');
          const line = first(JSON.parse(text.slice(0, cut)) as Record<string, unknown>);
          const chunks = [enc(JSON.stringify(line) + text.slice(cut)), ...plain.slice(1)];
          const sealed = await logA.sealSnapshot(id, await tableHashes(a.db), chunks);
          expect(await t.begin({ ...sealed, chunks: sealed.chunks.length })).toMatchObject({ ok: true });
          for (const [i, c] of sealed.chunks.entries())
            expect(await t.put(id, i + 1, c)).toMatchObject({ ok: true });
          return { id, header: sealed.header, signature: sealed.signature };
        };
        const open = (e: LocalEngine, pick: Awaited<ReturnType<typeof store>>) =>
          openSnapshot(
            e,
            t,
            { keys: [x.w.keys], budgetId: BUDGET, deviceId: LAPTOP, clock: () => clock },
            pick,
          );

        // Written before the rules had a number: opened as version 1.
        const older = await store(({ hash: _hash, ...rest }) => rest);
        const b = await newPhone();
        expect((await open(b, older)).number).toBe(1);

        // Rules a newer app wrote: refused before a row is written, and the copy is left empty.
        const newer = await store((line) => ({ ...line, hash: 99 }));
        const c = await newPhone();
        await expect(open(c, newer)).rejects.toBeInstanceOf(SnapshotNewer);
        expect((await c.state()).through).toBe(0);
      },
      { described: false },
    );
  }, 120_000);
});
