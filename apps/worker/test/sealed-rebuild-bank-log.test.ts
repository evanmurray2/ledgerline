// A copy made again keeps this device's bank log that the log doesn't hold yet (src/local/rebuild.ts; D-103): the
// rows of runs it filed before bank entries carried their bank log go into the new copy and are shared again, once;
// the old copy is only read, and a share that waited in its queue is made again, not run twice. And a public
// entry's place or write, or a snapshot check, that finds the copy below the floor leads to a rebuild, not an error.
import { ulid } from '@ledgerline/platform';
import { encodeEntry, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { BelowFloor, DeviceLog, LogFork } from '../src/local/device-log.js';
import { openSnapshot, writeSnapshot, type SnapshotTransport } from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { LogSession, SHARE_PATH, type LogTransport } from '../src/local/log-session.js';
import { afterRebuild, readStale, rebuildCopy, unlessGone } from '../src/local/rebuild.js';
import { logAfter, logAppend } from '../src/seal/log-store.js';
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

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('a copy made again, and its own bank log', () => {
  it('keeps the runs the log does not hold yet, and shares them again once', async () => {
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
          check: async () => ({ ok: false }),
          publics: async () => (await publicAfter(x.db, 0, 1000)).map((e) => e.bytes),
        };
        const env = { clock: () => clock, encode: encodeEntry };

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
        expect(await writeSnapshot(a, logA, t, ulid((clock += 1000)))).toMatchObject({ written: true });

        // Runs 1 to 3 this device filed before bank entries carried their bank log: in its copy only.
        const event = (id: number, run: number) =>
          a.db
            .prepare(
              `INSERT INTO bank_event (id, budget_id, connection_id, sync_run_id, page, position, apply_seq, kind,
               provider_txn_id, provider_account_id, payload, raw_ref, sha256, created_at)
               VALUES (?1, ?2, 'link', ?3, 0, ?1, ?1, 'added', ?4, 'acct', '{}', 'raw', 'hash', ?5)`,
            )
            .bind(id, BUDGET, `sealed:${run}`, `txn-${id}`, clock);
        await a.db.batch([event(901, 1), event(902, 2), event(903, 3)]);
        const bankLog = async (e: LocalEngine) =>
          (
            await e.db
              .prepare(`SELECT id, sync_run_id FROM bank_event WHERE sync_run_id LIKE 'sealed:%' ORDER BY id`)
              .all<{ id: number; sync_run_id: string }>()
          ).results;
        const mine = await bankLog(a);
        expect(mine.map((r) => r.id)).toEqual([901, 902, 903]);

        // The old copy is only read: what it keeps is its runs not shared (none is noted as shared).
        const stale = await readStale(a);
        expect(stale.edits).toEqual([]);
        expect(stale.bankLog.find((b) => b.table === 'bank_event')?.rows).toHaveLength(3);

        // Made again from the snapshot, which holds none of them: they are kept, and shared again as one edit.
        const a2 = await newPhone();
        const made = await rebuildCopy(a2, a, t, logA, env);
        expect(made).toMatchObject({ kept: 0, lost: 0 });
        expect(await bankLog(a2)).toEqual(mine);
        const q = await a2.queue();
        expect(q.map((e) => [e.path, e.body])).toEqual([[SHARE_PATH, { from: 1, to: 3 }]]);
        expect(await a2.noted(LogSession.BANK_LOG_SHARED)).toBe('1');
        const session = new LogSession(a2, made.log, log, encodeEntry);
        expect(await session.flush()).toEqual({ sent: 1, lost: 0 });
        // Shared once: the copy notes it, so the next round queues nothing.
        expect(await session.shareBankLog(clock)).toBe(0);

        // Another device that joins from the snapshot reads the share from the log, and holds the same bank log.
        const b = await newPhone();
        const logB = await openSnapshot(b, t, {
          keys: [x.w.keys],
          budgetId: BUDGET,
          deviceId: LAPTOP,
          clock: () => clock,
        });
        await new LogSession(b, logB, log, encodeEntry).pull();
        expect(await bankLog(b)).toEqual(mine);

        // Made again once more: the log holds the runs now, so nothing is kept twice and nothing is shared again.
        const a3 = await newPhone();
        const again = await rebuildCopy(a3, a2, t, made.log, env);
        expect(again).toMatchObject({ kept: 0, lost: 0 });
        expect(await a3.queue()).toEqual([]);
        expect(await bankLog(a3)).toEqual(mine);
      },
      { described: false },
    );
  }, 120_000);
});

describe('below the floor outside a sync', () => {
  it('makes the copy again and runs the step once more; a fork or a fault is thrown as it is', async () => {
    const told: string[] = [];
    let rebuilt = 0;
    let calls = 0;
    const place = await afterRebuild(
      async () => {
        if (++calls === 1) throw new BelowFloor(3);
        return 'place';
      },
      async () => void rebuilt++,
      (e) => told.push(e),
    );
    expect(place).toBe('place');
    expect([calls, rebuilt, told]).toEqual([2, 1, ['rebuilding', 'rebuilt']]);
    // Another history is never made again over.
    await expect(
      afterRebuild(
        async () => {
          throw new LogFork('x');
        },
        async () => void rebuilt++,
        (e) => told.push(e),
      ),
    ).rejects.toBeInstanceOf(LogFork);
    expect(rebuilt).toBe(1);
    // A snapshot check whose entries are gone checks nothing; any other fault is thrown.
    expect(
      await unlessGone(async () => {
        throw new BelowFloor(5);
      }),
    ).toEqual({ checked: false, why: 'no older snapshot' });
    await expect(
      unlessGone(async () => {
        throw new Error('no answer');
      }),
    ).rejects.toThrow('no answer');
  });
});
