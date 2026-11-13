// A device's change has one entry id, and its place in the log is kept with its copy (src/local/log-session.ts,
// device-log.ts): a change whose answer was lost is in the log once and in the copy once, and an app that was
// closed goes on from where it stood.
import { encodeEntry, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { DeviceLog, entryIdOf } from '../src/local/device-log.js';
import type { LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { syncPhone } from './phone.js';
import { world } from './sealed-world.js';
import { differences, newPhone, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('a change sent twice, and an app that was closed', () => {
  it('is in the log once and in the copy once; the device goes on from its kept place', async () => {
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
        const device = async (id: string) => {
          const engine = await syncPhone(await newPhone());
          await engine.applyLogRows([], 1);
          const dl = new DeviceLog(
            x.w.keys,
            await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
            id,
            () => clock,
          );
          return { engine, log: dl };
        };
        const a = await device(PHONE);
        const b = await device(LAPTOP);
        const sessionB = new LogSession(b.engine, b.log, log, encodeEntry);
        let n = 0;
        const assign = async (e: LocalEngine, amount: number) => {
          clock += 1000;
          const id = `restart-edit-${++n}-xxxxxx`;
          const r = await e.enqueue({
            id,
            at: clock,
            method: 'POST',
            path: '/api/budget/assign',
            body: { month: '2026-11', items: [{ categoryId: 'rent', amount }] },
          });
          expect(r.response.status).toBe(200);
          return id;
        };
        const rent = async (e: LocalEngine) =>
          (await e.db
            .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = 'rent'`)
            .first<{ amount: number }>())!.amount;
        const start = await rent(a.engine);

        // ---- the server stores the entry, and the answer is lost
        let lose = true;
        const lossy = new LogSession(
          a.engine,
          a.log,
          {
            after: log.after,
            append: async (base, entries) => {
              const r = await log.append(base, entries);
              if (lose) {
                lose = false;
                throw new Error('the connection dropped');
              }
              return r;
            },
          },
          encodeEntry,
        );
        const first = await assign(a.engine, 100);
        await expect(lossy.flush()).rejects.toThrow('the connection dropped');
        expect(await logHead(x.db)).toBe(2);
        expect((await a.engine.queue()).map((e) => e.id)).toEqual([first]);
        // Sent again: the same entry id, so the server says it holds it, and nothing is stored twice.
        expect(await lossy.flush()).toEqual({ sent: 0, lost: 0 });
        expect(await logHead(x.db)).toBe(2);
        expect(await a.engine.queue()).toEqual([]);
        expect(await rent(a.engine)).toBe(start + 100);
        expect(a.log.number).toBe(2);
        // The other device has it once too.
        await sessionB.pull();
        expect(await rent(b.engine)).toBe(start + 100);
        expect(differences(await rowsOf(a.engine), await rowsOf(b.engine))).toEqual([]);
        expect((await entryIdOf(first)).length).toBe(16);

        // ---- the app is closed and opened: the device's place is the one kept with its copy
        const kept = await a.engine.noted(LogSession.PLACE);
        expect(kept).not.toBeNull();
        const reopened = await DeviceLog.restore(x.w.keys, kept!, PHONE, () => clock);
        expect(reopened.number).toBe(2);
        expect(reopened.place()).toEqual(a.log.place());
        const sessionA = new LogSession(a.engine, reopened, log, encodeEntry);
        await assign(a.engine, 50);
        expect(await sessionA.flush()).toEqual({ sent: 1, lost: 0 });
        expect(await logHead(x.db)).toBe(3);

        // ---- closed between the server's yes and the note: the place kept is the older one, the change still
        // waits in the queue, and the log holds it. On the next read the device knows its own entry.
        const older = (await a.engine.noted(LogSession.PLACE))!;
        const third = await assign(a.engine, 25);
        const entries = await reopened.build(
          1,
          { at: clock, rows: (await a.engine.queue())[0]!.rows! },
          {
            entryId: await entryIdOf(third),
          },
        );
        expect(await log.append(3, entries.map(encodeEntry))).toMatchObject({ ok: true, number: 4 });
        const again = await DeviceLog.restore(x.w.keys, older, PHONE, () => clock);
        expect(again.number).toBe(3);
        const afterCrash = new LogSession(a.engine, again, log, encodeEntry);
        // Another device wrote meanwhile, too.
        clock += 1000;
        await sessionB.pull();
        await assign(b.engine, 7);
        expect(await sessionB.flush()).toEqual({ sent: 1, lost: 0 });
        expect(await afterCrash.pull()).toEqual({ entries: 2, lost: 0 });
        expect(await a.engine.queue()).toEqual([]);
        expect(await rent(a.engine)).toBe(start + 100 + 50 + 25 + 7);
        await sessionB.pull();
        expect(differences(await rowsOf(a.engine), await rowsOf(b.engine))).toEqual([]);
        expect(await logHead(x.db)).toBe(5);

        // Text that is not a kept place is refused.
        await expect(DeviceLog.restore(x.w.keys, '{"v":2}', PHONE, () => clock)).rejects.toThrow();
        await expect(DeviceLog.restore(x.w.keys, 'nothing', PHONE, () => clock)).rejects.toThrow();
      },
      { described: false },
    );
  }, 120_000);
});
