// The server's side of the device check (D-116; src/seal/device-checks.ts, log-routes.ts): it keeps each device's
// latest record in store_note, hands every record back with the log, and reads none of them.
import { encodeEntry } from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHECK_KEPT_MS,
  deviceChecks,
  keepDeviceCheck,
  MAX_CHECKS,
  type DeviceCheckRecord,
} from '../src/seal/device-checks.js';
import { logGenesis } from '../src/seal/log-store.js';
import { Writer } from './log-writer.js';
import { budgetOf } from './phone.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const record = (o: Partial<DeviceCheckRecord> = {}): DeviceCheckRecord => ({
  deviceId: PHONE,
  number: 1,
  month: '2026-11',
  mac: 'ab'.repeat(32),
  ...o,
});

describe('the device checks the server keeps', () => {
  let budget: string;
  const seal = (on: boolean) =>
    on
      ? storeDb(budget)
          .prepare(`INSERT OR IGNORE INTO store_mark (key, at) VALUES ('sealed', ?1)`)
          .bind(NOW)
          .run()
      : storeDb(budget).prepare(`DELETE FROM store_mark`).run();

  beforeAll(async () => {
    budget = (await budgetOf()).budgetId;
    const w = new Writer(budget, NOW - 60_000);
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

  it('are kept and handed back with the log, one per device', async () => {
    expect((await post('/api/log/check', record())).status).toBe(409);
    await seal(true);
    try {
      expect(((await (await get('/api/log?after=0')).json()) as { checks: unknown }).checks).toEqual([]);
      const kept = await post('/api/log/check', record());
      expect(kept.status).toBe(200);
      expect(await kept.json()).toEqual({ ok: true });
      // A second one within a minute is refused; the first stays.
      const soon = await post('/api/log/check', record({ mac: 'cd'.repeat(32) }));
      expect(soon.status).toBe(409);
      expect(await soon.json()).toMatchObject({ ok: false, why: 'too soon' });
      // Another device's goes beside it.
      expect((await post('/api/log/check', record({ deviceId: LAPTOP }))).status).toBe(200);
      const page = (await (await get('/api/log?after=1')).json()) as { checks: DeviceCheckRecord[] };
      expect(page.checks.sort((a, b) => a.deviceId.localeCompare(b.deviceId))).toEqual([
        record(),
        record({ deviceId: LAPTOP }),
      ]);
    } finally {
      await seal(false);
    }
  });

  it('refuse a record in the wrong form, or past the end of the log', async () => {
    await seal(true);
    try {
      for (const bad of [
        record({ deviceId: 'phone' }),
        record({ month: '2026-13' }),
        record({ mac: 'AB'.repeat(32) }),
        record({ number: 0 }),
        { ...record(), mac: undefined },
      ]) {
        const r = await post('/api/log/check', bad);
        expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      }
      const past = await post(
        '/api/log/check',
        record({ deviceId: '01DX5ZZKBKACTAV9WEVGEMMVRZ', number: 2 }),
      );
      expect(past.status).toBe(409);
      expect(await past.json()).toMatchObject({ ok: false, why: 'invalid' });
    } finally {
      await seal(false);
    }
  });

  it("replace a device's last record, drop old ones, and keep at most 16", async () => {
    const db = storeDb('device-checks-store');
    const d = (now: number) => ({ db, now, resting: false, head: 100 });
    const t = NOW;
    expect(await keepDeviceCheck(d(t), record({ number: 5 }))).toEqual({ ok: true });
    expect(await keepDeviceCheck(d(t + 60_000), record({ number: 9, month: '2026-12' }))).toEqual({
      ok: true,
    });
    expect(await deviceChecks(db)).toEqual([record({ number: 9, month: '2026-12' })]);
    // Resting: refused, kept for later.
    expect(await keepDeviceCheck({ ...d(t + 120_000), resting: true }, record({ number: 10 }))).toMatchObject(
      {
        ok: false,
        why: 'resting',
      },
    );
    // Another device's, 31 days later: the phone's is gone.
    const later = t + CHECK_KEPT_MS + 120_000;
    expect(await keepDeviceCheck(d(later), record({ deviceId: LAPTOP, number: 11 }))).toEqual({ ok: true });
    expect(await deviceChecks(db)).toEqual([record({ deviceId: LAPTOP, number: 11 })]);
    // Many devices: the newest 16 stay.
    for (let i = 0; i < MAX_CHECKS + 3; i++) {
      const id = `01EX5ZZKBKACTAV9WEVGEM${String(i).padStart(4, '0')}`;
      expect(await keepDeviceCheck(d(later + 1000 + i), record({ deviceId: id }))).toEqual({ ok: true });
    }
    const all = await deviceChecks(db);
    expect(all.length).toBe(MAX_CHECKS);
    expect(all.some((r) => r.deviceId === LAPTOP)).toBe(false);
    // The server keeps nothing else for a check: each is one row of store_note.
    const rows = await db.prepare(`SELECT count(*) AS n FROM store_note WHERE key LIKE 'check:%'`).first('n');
    expect(rows).toBe(MAX_CHECKS);
  });
});
