// The device's network layer for a sealed budget (src/local/http-transport.ts) against the real routes
// (src/seal/log-routes.ts): an edit goes out as an entry, a snapshot is written and read back, and a second
// device opens it, all over HTTP.
import { ulid } from '@ledgerline/platform';
import { encodeEntry, startChain } from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeviceLog } from '../src/local/device-log.js';
import { openSnapshot, writeSnapshot } from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { httpTransport, TransportError } from '../src/local/http-transport.js';
import { LogSession } from '../src/local/log-session.js';
import { logGenesis } from '../src/seal/log-store.js';
import { PHONE, Writer } from './log-writer.js';
import { syncPhone, budgetOf } from './phone.js';
import { storeDb } from './store-db.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('a sealed budget over HTTP', () => {
  let budget: string;
  let w: Writer;
  let phone: LocalEngine;
  let second: LocalEngine;
  const t = httpTransport((path, init) =>
    SELF.fetch(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init?.headers ?? {}) } }),
  );

  beforeAll(async () => {
    budget = (await budgetOf()).budgetId;
    // The phone has the budget before it is sealed (at the cutover: the first snapshot).
    phone = await syncPhone(await newPhone());
    // A second device's empty copy (made now: the old routes that say who it is close when the budget is sealed).
    second = await newPhone();
    w = new Writer(budget, NOW - 60_000);
    const stored = await logGenesis(
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
    expect(stored).toMatchObject({ ok: true, number: 1 });
  });

  it('an edit, a snapshot and a second device', async () => {
    const db = storeDb(budget);
    await db.prepare(`INSERT OR IGNORE INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(NOW).run();
    try {
      const clock = () => NOW;
      const st = await phone.state();
      await phone.apply(
        {
          format: st.format,
          epoch: st.epoch!,
          serverTime: NOW,
          through: 1,
          more: false,
          cursor: null,
          rows: [],
        },
        NOW,
      );
      const log = new DeviceLog(
        w.keys,
        await startChain(w.last!, { now: NOW, schemaVersion: 1 }, budget),
        PHONE,
        clock,
      );
      const session = new LogSession(phone, log, t, encodeEntry);

      expect((await t.after(0)).length).toBe(1);
      expect((await t.publics()).length).toBe(1);
      expect(await t.runs(0)).toEqual([]);
      expect(await t.list()).toEqual([]);
      expect(await t.manifest(ulid(NOW))).toBeNull();
      expect((await t.page(1, 0)).length).toBe(0);

      const r = await phone.enqueue({
        id: 'http-edit-1-xxxxxx',
        at: NOW,
        method: 'POST',
        path: '/api/budget/assign',
        body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 100 }] },
      });
      expect(r.response.status).toBe(200);
      expect(await session.flush()).toEqual({ sent: 1, lost: 0 });
      expect((await t.after(1)).length).toBe(1);
      // Sent a second time by hand, the server says it holds it.
      expect(await session.pull()).toEqual({ entries: 0, lost: 0 });

      const written = await writeSnapshot(phone, log, t, ulid(NOW));
      expect(written).toMatchObject({ written: true, number: 2 });
      expect(await t.list()).toMatchObject([{ number: 2, chunks: 1, check: null }]);

      const log2 = await openSnapshot(second, t, {
        keys: [w.keys],
        budgetId: budget,
        deviceId: LAPTOP,
        clock,
      });
      expect(log2.number).toBe(2);
      expect(differences(await rowsOf(second), await rowsOf(phone))).toEqual([]);

      // A check record the server refuses comes back as its answer, not as a fault.
      expect(await t.check(ulid(NOW), LAPTOP, new Uint8Array(64), ulid(NOW))).toMatchObject({ ok: false });
      // A fault is a fault: a path the server doesn't have.
      await expect(
        httpTransport((path, init) =>
          SELF.fetch(`${ORIGIN}${path.replace('/api/log', '/api/nothing')}`, init),
        ).after(0),
      ).rejects.toBeInstanceOf(TransportError);
    } finally {
      await db.prepare(`DELETE FROM store_mark`).run();
    }
  }, 60_000);
});
