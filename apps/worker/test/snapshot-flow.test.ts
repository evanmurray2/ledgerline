// Snapshots, end to end (docs/privacy.md 5.3; src/local/device-snapshot.ts and src/seal/snapshot-store.ts): a
// device writes its base as a sealed snapshot and reads it back; a new device opens it and goes on from the
// log; a device checks the next snapshot by rebuilding the budget, and only then does the server delete what
// is older; a snapshot of a copy that drifted is not checked.
import { ulid } from '@ledgerline/platform';
import { ChainError, encodeEntry, randomBytes, SnapshotError, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import {
  checkSnapshot,
  openSnapshot,
  SnapshotNewer,
  writeSnapshot,
  type ListedSnapshot,
  type OpenDeps,
  type SnapshotTransport,
} from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import {
  logFloor,
  publicAfter,
  snapshotBegin,
  snapshotCheck,
  snapshotChunk,
  snapshotChunkOf,
  snapshotList,
  snapshotManifest,
  snapshotPrune,
} from '../src/seal/snapshot-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { syncPhone } from './phone.js';
import { world } from './sealed-world.js';
import { differences, newPhone, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const TABLET = '01DX5ZZKBKACTAV9WEVGEMMVRZ';

describe('snapshots, from one device to the next', () => {
  it('written, read back, opened by a new device, checked by rebuilding, and only then is anything deleted', async () => {
    await world(
      async (x) => {
        let clock = T0 + 10_000;
        const log: LogTransport = {
          after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
          append: (base, entries) =>
            logAppend(
              {
                db: x.db,
                budgetId: BUDGET,
                now: clock,
                resting: false,
                freshWay: false,
                lastCompleteRun: 0,
                receiptHashes: async () => null,
              },
              base,
              entries,
            ),
        };
        const deps = () => ({ db: x.db, budgetId: BUDGET, now: clock, resting: false });
        const t: SnapshotTransport = {
          list: () => snapshotList(x.db),
          manifest: (id) => snapshotManifest(x.db, id),
          chunk: (id, k) => snapshotChunkOf(x.db, id, k),
          begin: (s) => snapshotBegin(deps(), s),
          put: (id, k, bytes) => snapshotChunk(deps(), id, k, bytes),
          check: async (id, deviceId, signature, baseId) => {
            const r = await snapshotCheck(deps(), id, deviceId, signature, baseId);
            if (r.ok) await snapshotPrune(x.db);
            return r;
          },
          publics: async () => (await publicAfter(x.db, 0, 1000)).map((e) => e.bytes),
          after: log.after,
        };
        const numbers = async () =>
          (
            await x.db.prepare(`SELECT number FROM log_entry ORDER BY number`).all<{ number: number }>()
          ).results.map((r) => r.number);

        // Phone A: the budget at the cutover, standing at the log's first entry. (The page is taken as received at
        // its own time, so the copy's clock stays the device's.)
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
        const sessionA = new LogSession(a, logA, log, encodeEntry);
        let n = 0;
        const edit = async (e: LocalEngine, s: LogSession, amount: number) => {
          clock += 1000;
          const r = await e.enqueue({
            id: `snap-edit-${++n}-xxxxxx`,
            at: clock,
            method: 'POST',
            path: '/api/budget/assign',
            body: { month: '2026-11', items: [{ categoryId: 'rent', amount }] },
          });
          expect(r.response.status).toBe(200);
          return s.flush();
        };

        // An edit that waits: no snapshot.
        clock += 1000;
        await a.enqueue({
          id: `snap-edit-${++n}-xxxxxx`,
          at: clock,
          method: 'POST',
          path: '/api/budget/assign',
          body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 100 }] },
        });
        expect(await writeSnapshot(a, logA, t, ulid(clock))).toEqual({ written: false, why: 'edits wait' });
        expect(await sessionA.flush()).toEqual({ sent: 1, lost: 0 });
        expect(await edit(a, sessionA, 200)).toEqual({ sent: 1, lost: 0 });

        // ---- the first snapshot, at entry 3: written and read back
        clock += 1000;
        const s1 = await writeSnapshot(a, logA, t, ulid(clock));
        expect(s1).toMatchObject({ written: true, number: 3 });
        expect(await snapshotList(x.db)).toMatchObject([{ number: 3, checked: false }]);
        // With no older snapshot there is nothing to rebuild it from: it stays unchecked, and nothing is deleted.
        expect(await checkSnapshot(await newPhone(), logA, t, () => clock)).toEqual({
          checked: false,
          why: 'no older snapshot',
        });

        // ---- a new device opens it, and goes on from the log
        const b = await newPhone();
        const logB = await openSnapshot(b, t, {
          keys: [x.w.keys],
          budgetId: BUDGET,
          deviceId: LAPTOP,
          clock: () => clock,
        });
        expect(logB.number).toBe(3);
        expect((await b.state()).through).toBe(3);
        expect(differences(await rowsOf(b), await rowsOf(a))).toEqual([]);
        const rta = async (e: LocalEngine) =>
          (await e.db.prepare(`SELECT rta FROM budget`).first<{ rta: number }>())!.rta;
        expect(await rta(b)).toBe(await rta(a));
        const sessionB = new LogSession(b, logB, log, encodeEntry);
        expect(await edit(b, sessionB, 300)).toEqual({ sent: 1, lost: 0 });
        expect(await logHead(x.db)).toBe(4);
        expect(await sessionA.pull()).toMatchObject({ entries: 1 });
        expect(differences(await rowsOf(b), await rowsOf(a))).toEqual([]);

        // ---- the second snapshot, by the new device; phone A checks it by rebuilding from the first
        clock += 86_400_000;
        expect(await edit(b, sessionB, 400)).toEqual({ sent: 1, lost: 0 });
        const s2 = await writeSnapshot(b, logB, t, ulid(clock));
        expect(s2).toMatchObject({ written: true, number: 5 });
        expect(await numbers()).toEqual([1, 2, 3, 4, 5]);
        await sessionA.pull();
        const checked = await checkSnapshot(await newPhone(), logA, t, () => clock);
        expect(checked).toMatchObject({ checked: true });
        expect((await snapshotList(x.db)).map((s) => [s.number, s.checked])).toEqual([
          [5, true],
          [3, false],
        ]);
        // Only now does the server delete: the sealed entry before the first snapshot's.
        expect(await numbers()).toEqual([1, 3, 4, 5]);
        expect(await logFloor(x.db)).toBe(3);
        expect(await checkSnapshot(await newPhone(), logA, t, () => clock)).toEqual({
          checked: false,
          why: 'nothing to check',
        });

        // ---- a third device opens the checked one, though older entries are gone
        const c = await newPhone();
        const logC = await openSnapshot(c, t, {
          keys: [x.w.keys],
          budgetId: BUDGET,
          deviceId: TABLET,
          clock: () => clock,
        });
        expect(logC.number).toBe(5);
        expect(differences(await rowsOf(c), await rowsOf(b))).toEqual([]);
        const sessionC = new LogSession(c, logC, log, encodeEntry);
        expect(await edit(c, sessionC, 500)).toEqual({ sent: 1, lost: 0 });
        await sessionA.pull();
        await sessionB.pull();
        expect(differences(await rowsOf(c), await rowsOf(a))).toEqual([]);
        expect(differences(await rowsOf(c), await rowsOf(b))).toEqual([]);

        // ---- a server that hands out other bytes: the snapshot does not open, and the copy is left empty
        const d = await newPhone();
        const open = (
          e: LocalEngine,
          with_: SnapshotTransport,
          more: Partial<OpenDeps> = {},
          pick?: ListedSnapshot,
        ) =>
          openSnapshot(
            e,
            with_,
            { keys: [x.w.keys], budgetId: BUDGET, deviceId: TABLET, clock: () => clock, ...more },
            pick,
          );
        const rowsIn = async (e: LocalEngine) =>
          (await e.db.prepare(`SELECT count(*) AS n FROM category`).first<{ n: number }>())!.n;
        // The last chunk is cut short: the chunks before it were written, and are taken out again.
        const small: SnapshotTransport = {
          ...t,
          chunk: async (id, k) => {
            const b = await t.chunk(id, k);
            return b && k === 1 ? b.slice(0, -1) : b;
          },
        };
        await expect(open(d, small)).rejects.toBeInstanceOf(SnapshotError);
        expect(await rowsIn(d)).toBe(0);
        // A log shown without its public entries is no log.
        await expect(open(d, { ...t, publics: async () => [] })).rejects.toBeInstanceOf(ChainError);
        // A device that remembers a later place is not sent back to an older snapshot.
        await expect(open(d, t, { applied: 6 })).rejects.toBeInstanceOf(SnapshotError);
        expect(await rowsIn(d)).toBe(0);
        // After the failures the same copy opens the real thing.
        expect((await open(d, t)).number).toBe(5);

        // ---- a copy that drifted writes a snapshot: the rebuild differs, and it is not checked
        clock += 86_400_000;
        await b.db.prepare(`UPDATE category SET name = name || ' (drift)' WHERE id = 'rent'`).run();
        const s3 = await writeSnapshot(b, logB, t, ulid(clock));
        expect(s3).toMatchObject({ written: true, number: 6 });
        expect(await checkSnapshot(await newPhone(), logA, t, () => clock)).toEqual({
          checked: false,
          why: 'differs',
          tables: ['category'],
        });
        const state = async () => (await snapshotList(x.db)).map((s) => [s.number, s.checked]);
        expect(await state()).toEqual([
          [6, false],
          [5, true],
          [3, false],
        ]);
        // A new device takes the checked one, not the newest, even when the server says the newest is checked.
        expect((await open(await newPhone(), t)).number).toBe(5);
        const lying: SnapshotTransport = {
          ...t,
          list: async () =>
            (await t.list()).map((s, i) =>
              i === 0 ? { ...s, check: { deviceId: PHONE, signature: randomBytes(64) } } : s,
            ),
        };
        expect((await open(await newPhone(), lying)).number).toBe(5);

        // ---- the drifted device goes on: its next snapshot is checked against the last CHECKED one, not against
        // its own drifted one, so it is refused too, and nothing is deleted
        expect(await edit(b, sessionB, 600)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(b, logB, t, ulid(clock + 1))).toMatchObject({ written: true, number: 7 });
        await sessionA.pull();
        expect(await checkSnapshot(await newPhone(), logA, t, () => clock)).toMatchObject({
          checked: false,
          why: 'differs',
        });
        expect(await numbers()).toEqual([1, 3, 4, 5, 6, 7]);
        // A device with the true rows writes the next one; it is checked on the last checked one, and the two
        // drifted ones go.
        expect(await edit(a, sessionA, 700)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(a, logA, t, ulid(clock + 2))).toMatchObject({ written: true, number: 8 });
        await sessionC.pull();
        const fixed = await checkSnapshot(await newPhone(), logC, t, () => clock);
        expect(fixed).toMatchObject({ checked: true });
        expect(await state()).toEqual([
          [8, true],
          [5, true],
        ]);
        expect(await numbers()).toEqual([1, 5, 6, 7, 8]);
        // A new device now has the true name.
        const fresh = await newPhone();
        expect((await open(fresh, t)).number).toBe(8);
        expect(await fresh.db.prepare(`SELECT name FROM category WHERE id = 'rent'`).first()).toEqual(
          await a.db.prepare(`SELECT name FROM category WHERE id = 'rent'`).first(),
        );

        // ---- another version of the app: a copy with one more column opens an older snapshot; a snapshot with a
        // column this copy doesn't have says "update", and nothing is written
        const newer = await newPhone();
        await newer.db.prepare(`ALTER TABLE payee ADD COLUMN zz TEXT`).run();
        expect((await open(newer, t)).number).toBe(8);
        await a.db.prepare(`ALTER TABLE payee ADD COLUMN zz TEXT`).run();
        expect(await edit(a, sessionA, 800)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(a, logA, t, ulid(clock + 3))).toMatchObject({ written: true, number: 9 });
        const older = await newPhone();
        await expect(open(older, t, {}, (await t.list())[0]!)).rejects.toBeInstanceOf(SnapshotNewer);
        expect(await rowsIn(older)).toBe(0);
      },
      { described: false },
    );
  }, 180_000);
});
