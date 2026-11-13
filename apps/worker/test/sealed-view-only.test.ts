// The queue while the server is view only (90% of a daily limit, or a budget past its fair-use share): the log
// refuses a change with "limit", which the device may send again; the Directory refuses every write outright. The
// changes wait in the queue, the copy shows them meanwhile, nothing is lost or sent twice, and they go out in order
// once the server takes changes again. Another device reads the log all along.
import { encodeEntry, startChain } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import { TransportError } from '../src/local/http-transport.js';
import type { LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { logAfter, logAppend, logHead } from '../src/seal/log-store.js';
import { BUDGET, PHONE, T0 } from './log-writer.js';
import { syncPhone } from './phone.js';
import { world } from './sealed-world.js';
import { differences, newPhone, rowsOf } from './twin.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('the queue while the server is view only', () => {
  it('waits, shows on this device, and goes out in order once the server takes changes again', async () => {
    await world(
      async (x) => {
        let clock = T0 + 10_000;
        /** 'log': the log refuses changes (the breaker); 'directory': the Directory refuses every write. */
        let viewOnly: false | 'log' | 'directory' = false;
        const log: LogTransport = {
          after: async (n) => (await logAfter(x.db, n, 100)).map((e) => e.bytes),
          append: async (base, entries) => {
            if (viewOnly === 'directory') throw new TransportError(503, 'The server gave no answer. Try again.');
            return logAppend(
              {
                db: x.db,
                budgetId: BUDGET,
                now: clock,
                resting: viewOnly === 'log',
                freshWay: false,
                lastCompleteRun: 0,
                receiptHashes: async () => null,
              },
              base,
              entries,
            );
          },
        };
        const device = async (id: string) => {
          const engine = await syncPhone(await newPhone());
          const st = await engine.state();
          await engine.apply(
            { format: st.format, epoch: st.epoch!, serverTime: clock, through: 1, more: false, cursor: null, rows: [] },
            clock,
          );
          const dl = new DeviceLog(
            x.w.keys,
            await startChain(x.w.last!, { now: clock, schemaVersion: 1 }, BUDGET),
            id,
            () => clock,
          );
          return { engine, session: new LogSession(engine, dl, log, encodeEntry) };
        };
        const a = await device(PHONE);
        const b = await device(LAPTOP);
        let n = 0;
        const assign = async (e: LocalEngine, amount: number) => {
          clock += 1000;
          const r = await e.enqueue({
            id: `view-only-edit-${++n}-xxxxx`,
            at: clock,
            method: 'POST',
            path: '/api/budget/assign',
            body: { month: '2026-11', items: [{ categoryId: 'rent', amount }] },
          });
          expect(r.response.status).toBe(200);
        };
        const rent = async (e: LocalEngine) =>
          (await e.db
            .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = 'rent'`)
            .first<{ amount: number }>())!.amount;
        const start = await rent(a.engine);
        const head = await logHead(x.db);

        // ---- the log refuses changes: they wait, in order, and the copy shows them
        viewOnly = 'log';
        await assign(a.engine, 100);
        await assign(a.engine, 50);
        expect(await a.session.flush()).toEqual({ sent: 0, lost: 0 });
        expect((await a.engine.queue()).map((e) => e.id)).toEqual([
          'view-only-edit-1-xxxxx',
          'view-only-edit-2-xxxxx',
        ]);
        expect(await logHead(x.db)).toBe(head);
        expect(await rent(a.engine)).toBe(start + 150);

        // ---- the Directory refuses every write: the sync fails, and the queue is as it was
        viewOnly = 'directory';
        await assign(a.engine, 25);
        await expect(a.session.flush()).rejects.toThrow(TransportError);
        expect(await a.engine.queue()).toHaveLength(3);
        expect(await rent(a.engine)).toBe(start + 175);
        // Reads go on: the other device reads the log, which holds none of it.
        expect(await b.session.pull()).toEqual({ entries: 0, lost: 0 });
        expect(await rent(b.engine)).toBe(start);

        // ---- the limit resets: every change goes out once, in order, and both devices agree
        viewOnly = false;
        clock += 1000;
        expect(await a.session.flush()).toEqual({ sent: 3, lost: 0 });
        expect(await a.engine.queue()).toEqual([]);
        expect(await logHead(x.db)).toBe(head + 3);
        expect(await a.session.flush()).toEqual({ sent: 0, lost: 0 });
        expect(await b.session.pull()).toEqual({ entries: 3, lost: 0 });
        expect(await rent(b.engine)).toBe(start + 175);
        expect(differences(await rowsOf(a.engine), await rowsOf(b.engine))).toEqual([]);
      },
      { described: false },
    );
  }, 120_000);
});
