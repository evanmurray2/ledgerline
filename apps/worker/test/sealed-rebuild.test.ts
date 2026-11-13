// A copy made again from a snapshot by itself, and a server that shows another history (docs/privacy.md 5.3;
// src/local/rebuild.ts, src/local/device-log.ts): a device whose place is below the log's floor rebuilds from
// the newest checked snapshot, keeps its waiting edit, and ends equal to the other device; a copy stopped with
// `FilingInterrupted` rebuilds from an older snapshot and reads on through its own place; a log that does not
// pass through what a device saw, an entry that does not continue its place, and an entry whose writer saw
// another entry are each refused as another history, and the copy is left as it was.
import { ulid } from '@ledgerline/platform';
import { encodeEntry, KIND, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { BelowFloor, DeviceLog, LogFork } from '../src/local/device-log.js';
import {
  checkSnapshot,
  openSnapshot,
  writeSnapshot,
  type SnapshotTransport,
} from '../src/local/device-snapshot.js';
import { FilingInterrupted, type LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { needsRebuild, rebuildCopy } from '../src/local/rebuild.js';
import { CopyAhead } from '../src/local/sealed-filing.js';
import { logAfter, logAppend } from '../src/seal/log-store.js';
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

describe('a copy made again from a snapshot, by itself', () => {
  it('below the floor, after a stopped filing, and never from another history', async () => {
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
        const t: SnapshotTransport & LogTransport = {
          ...log,
          list: () => snapshotList(x.db),
          manifest: (id) => snapshotManifest(x.db, id),
          chunk: (id, k) => snapshotChunkOf(x.db, id, k),
          begin: (s) => snapshotBegin(deps(), s),
          put: (id, k, bytes) => snapshotChunk(deps(), id, k, bytes),
          check: async (id, deviceId, signature, baseId) => {
            const r = await snapshotCheck(deps(), id, deviceId, signature, baseId);
            if (r.ok) while ((await snapshotPrune(x.db)).more);
            return r;
          },
          publics: async () => (await publicAfter(x.db, 0, 1000)).map((e) => e.bytes),
        };
        const env = { clock: () => clock, encode: encodeEntry };

        // Phone A: the budget at the cutover, standing at the log's first entry.
        const a = await syncPhone(await newPhone());
        await a.applyLogRows([], 1);
        const logA = new DeviceLog(
          x.w.keys,
          await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
          PHONE,
          () => clock,
        );
        const sessionA = new LogSession(a, logA, log, encodeEntry);
        let n = 0;
        const queue = async (e: LocalEngine, amount: number, category = 'rent') => {
          clock += 1000;
          const r = await e.enqueue({
            id: `rebuild-edit-${++n}-xxxxxx`,
            at: clock,
            method: 'POST',
            path: '/api/budget/assign',
            body: { month: '2026-11', items: [{ categoryId: category, amount }] },
          });
          expect(r.response.status).toBe(200);
        };
        const edit = async (e: LocalEngine, s: LogSession, amount: number) => {
          await queue(e, amount);
          return s.flush();
        };
        const check = async () => {
          const r = await checkSnapshot(await newPhone(), logA, t, () => clock);
          expect(r).toMatchObject({ checked: true });
        };

        // ---- the first snapshot at entry 3; phone B opens it, then goes away with a change that waits
        expect(await edit(a, sessionA, 100)).toEqual({ sent: 1, lost: 0 });
        expect(await edit(a, sessionA, 200)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(a, logA, t, ulid((clock += 1000)))).toMatchObject({ number: 3 });
        const b = await newPhone();
        const logB = await openSnapshot(b, t, {
          keys: [x.w.keys],
          budgetId: BUDGET,
          deviceId: LAPTOP,
          clock: () => clock,
        });
        expect(logB.number).toBe(3);
        await queue(b, 1234, 'groceries');
        expect(await b.queue()).toHaveLength(1);

        // ---- phone A goes on: two more snapshots, each checked, and the server deletes what they cover
        clock += 86_400_000;
        expect(await edit(a, sessionA, 300)).toEqual({ sent: 1, lost: 0 });
        expect(await edit(a, sessionA, 400)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(a, logA, t, ulid((clock += 1000)))).toMatchObject({ number: 5 });
        await check();
        clock += 86_400_000;
        expect(await edit(a, sessionA, 500)).toEqual({ sent: 1, lost: 0 });
        expect(await edit(a, sessionA, 600)).toEqual({ sent: 1, lost: 0 });
        expect(await writeSnapshot(a, logA, t, ulid((clock += 1000)))).toMatchObject({ number: 7 });
        await check();
        expect(await logFloor(x.db)).toBe(5);

        // ---- phone B is back: the entries it needs are gone, and the session says so
        const sessionB = new LogSession(b, logB, log, encodeEntry);
        const below = await sessionB.pull().catch((e: unknown) => e);
        expect(below).toBeInstanceOf(BelowFloor);
        expect(needsRebuild(below)).toBe(true);
        expect(needsRebuild(new CopyAhead())).toBe(true);
        expect(needsRebuild(new FilingInterrupted())).toBe(true);
        expect(needsRebuild(new LogFork('x'))).toBe(false);
        // Nothing of the copy changed: it still shows its change, at its old place.
        expect((await b.state()).through).toBe(3);
        expect(await b.queue()).toHaveLength(1);

        // It is made again from the newest checked snapshot, beside the old copy, and keeps the waiting change.
        const b2 = await newPhone();
        const made = await rebuildCopy(b2, b, t, logB, env);
        expect(made).toMatchObject({ kept: 1, lost: 0 });
        expect(made.log.number).toBe(7);
        expect((await b2.state()).through).toBe(7);
        expect(await b.queue()).toHaveLength(1);
        const sessionB2 = new LogSession(b2, made.log, log, encodeEntry);
        expect(await sessionB2.flush()).toEqual({ sent: 1, lost: 0 });
        expect(await sessionA.pull()).toMatchObject({ entries: 1 });
        expect(differences(await rowsOf(b2), await rowsOf(a))).toEqual([]);
        // Its place is kept with the new copy, and the change went out once, under the writer's own id.
        expect(await b2.noted(LogSession.PLACE)).toBe(made.log.save());
        const head = (await logAfter(x.db, made.log.number - 1, 1))[0]!;
        expect(head.number).toBe(8);

        // ---- a copy stopped in the middle of a filing: made again from the checked snapshot (older than its
        // place), and the log is read on through the place it had reached
        await a.db
          .prepare(
            `INSERT INTO local_state (key, value) VALUES ('filing', '8') ON CONFLICT (key) DO UPDATE SET value = '8'`,
          )
          .run();
        expect(await a.filingInterrupted()).toBe(true);
        const a2 = await newPhone();
        const again = await rebuildCopy(a2, a, t, logA, env);
        expect(again).toMatchObject({ kept: 0, lost: 0 });
        expect(again.log.number).toBe(8);
        expect(await a2.filingInterrupted()).toBe(false);
        expect(differences(await rowsOf(a2), await rowsOf(b2))).toEqual([]);

        // ---- another history: each is refused, and the copy that asked is left as it was
        // A device that saw an entry the log no longer holds as it was.
        const lied = await DeviceLog.restore(logA.keysHeld(), logA.save(), PHONE, () => clock);
        const saved = JSON.parse(lied.save()) as { own: [number, string][] };
        saved.own = saved.own.map(([num]) => [num, '00'.repeat(32)]);
        const liar = await DeviceLog.restore(logA.keysHeld(), JSON.stringify(saved), PHONE, () => clock);
        const fork1 = await rebuildCopy(await newPhone(), a2, t, liar, env).catch((e: unknown) => e);
        expect(fork1).toBeInstanceOf(LogFork);
        expect((fork1 as Error).message).toMatch(/The server showed this device a different history/);
        // A device that saw more than the server now shows: the log ends before its place.
        const short = {
          ...t,
          after: async (num: number) =>
            (await logAfter(x.db, num, 100)).filter((e) => e.number <= 7).map((e) => e.bytes),
        };
        const fork2 = await rebuildCopy(await newPhone(), a2, short, again.log, env).catch((e: unknown) => e);
        expect(fork2).toBeInstanceOf(LogFork);
        expect((fork2 as LogFork).older).toBe(true);
        expect((await a2.state()).through).toBe(8);

        // An entry that does not continue this device's place: another device wrote on a branch the server
        // showed it alone.
        const branch = await DeviceLog.restore(logA.keysHeld(), logA.save(), LAPTOP, () => clock);
        await branch.take(await branch.build(KIND.edit, { at: clock, rows: [] }));
        const onSide = await branch.build(KIND.edit, { at: clock + 1, rows: [] });
        await edit(b2, sessionB2, 777);
        expect(await sessionA.pull()).toMatchObject({ entries: 1 });
        expect(logA.number).toBe(9);
        const notMine = await logA.read(onSide).catch((e: unknown) => e);
        expect(notMine).toBeInstanceOf(LogFork);
        expect((notMine as Error).message).toMatch(/does not follow/);

        // An entry whose writer says it saw another entry of this device than the one this device wrote.
        const own = (JSON.parse(logA.save()) as { own: [number, string][] }).own;
        const [mine] = own[own.length - 1]!;
        const told = JSON.parse(made.log.save()) as { seen: [string, [number, string]][] };
        told.seen = [[PHONE, [mine, '11'.repeat(32)]]];
        const writer = await DeviceLog.restore(logA.keysHeld(), JSON.stringify(told), LAPTOP, () => clock);
        expect(writer.number).toBe(9);
        const sawOther = await writer.build(KIND.edit, { at: clock + 2, rows: [] });
        const refused = await logA.read(sawOther).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(LogFork);
        expect((refused as Error).message).toMatch(/says it saw another entry/);
        // The same entry with what its writer truly saw is taken: honest entries are never refused.
        const honest = await DeviceLog.restore(logA.keysHeld(), made.log.save(), LAPTOP, () => clock);
        expect((await logA.read(await honest.build(KIND.edit, { at: clock + 3, rows: [] }))).number).toBe(10);
        // Refused reads moved nothing.
        expect(logA.number).toBe(9);
      },
      { described: false },
    );
  }, 180_000);
});
