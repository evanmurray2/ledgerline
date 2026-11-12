// Two devices share a budget only through its sealed, signed log (docs/privacy.md 5.3). One device runs an edit,
// records the rows it changed, seals them into an entry and sends it; the server stores the entry without
// reading it; the other device opens the entry and writes the rows, running nothing. Both copies end equal.
import type { Db } from '@ledgerline/db/sql';
import {
  deriveBudgetKeys,
  encodeEntry,
  encodeGenesis,
  KIND,
  newInbox,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  readEntry,
  recoverySlot,
  startChain,
  type BudgetKeys,
  type Bytes,
  type Entry,
} from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeChangeSet, DeviceLog, encodeChangeSet, LogFormatError } from '../src/local/device-log.js';
import type { LocalEngine } from '../src/local/engine.js';
import { logAfter, logAppend, logGenesis, type LogDeps } from '../src/seal/log-store.js';
import { syncPhone } from './phone.js';
import { storeDb } from './store-db.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';

describe('two devices and the sealed log', () => {
  let a: LocalEngine;
  let b: LocalEngine;
  let logA: DeviceLog;
  let logB: DeviceLog;
  let keys: BudgetKeys;
  let server: Db;
  let clock = Date.now();
  let n = 0;
  const deps = (): LogDeps => ({
    db: server,
    budgetId: BUDGET,
    now: clock,
    resting: false,
    freshWay: false,
    lastCompleteRun: 0,
    receiptHashes: async () => null,
  });
  const other = async (e: LocalEngine) =>
    JSON.stringify([
      (await e.db.prepare(`SELECT * FROM audit_log ORDER BY id`).all()).results,
      (await e.db.prepare(`SELECT * FROM txn_key_move ORDER BY old_key`).all()).results,
    ]);

  /** A device takes what the log holds past its own place, and writes the rows. */
  const read = async (engine: LocalEngine, log: DeviceLog) => {
    const fresh = await logAfter(server, log.number, 100);
    const entries: Entry[] = [];
    for (const e of fresh) entries.push(await readEntry(e.bytes));
    for (const set of await log.take(entries)) await engine.applyRows(set.rows);
    if (await engine.needsDerive()) await engine.derive();
  };

  /** A device makes an edit: runs it, seals the rows it changed, and sends the entry. */
  const edit = async (engine: LocalEngine, log: DeviceLog, method: string, path: string, body: unknown) => {
    clock += 1000;
    const stamp = { id: `log-edit-${++n}-xxxxxx`, at: clock };
    const ran = await engine.record(method, path, body, stamp);
    expect(ran.response.status, await ran.response.clone().text()).toBeLessThan(300);
    const entries = await log.build(KIND.edit, { at: stamp.at, rows: ran.rows });
    const answer = await logAppend(deps(), log.number, entries.map(encodeEntry));
    return { ran, entries, answer };
  };

  beforeAll(async () => {
    const r = await SELF.fetch(`${ORIGIN}/__dev/seed-november`, { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    // Both devices start from the same budget (at the cutover: the first snapshot).
    a = await syncPhone(await newPhone());
    b = await syncPhone(await newPhone());
    server = storeDb('device-log-server');

    // The budget's keys and its first entry, made on the phone.
    const bk = randomBytes(32);
    keys = await deriveBudgetKeys(bk, BUDGET, 1);
    const inbox = await newInbox(keys, BUDGET, 1);
    const pub = keys.sign.pub;
    const genesis = await publicEntry(
      {
        kind: KIND.genesis,
        budgetId: BUDGET,
        number: 1,
        prevHash: new Uint8Array(32) as Bytes,
        entryId: randomBytes(16),
        time: clock,
        deviceId: PHONE,
        deviceCounter: 1,
        keyVersion: 1,
        schemaVersion: 1,
        processingVersion: 1,
        part: 1,
        parts: 1,
        filedThrough: 0,
        receipts: [],
        scanThrough: 0,
      },
      encodeGenesis({
        signPub: pub,
        inboxPub: inbox.pair.pub,
        wrappedInbox: inbox.wrapped,
        slots: [
          await newSlotRecord(
            await passkeySlot(randomBytes(32), BUDGET, randomBytes(16)),
            bk,
            keys,
            BUDGET,
            pub,
          ),
          await newSlotRecord(await recoverySlot(randomBytes(32), 1), bk, keys, BUDGET, pub),
        ],
      }),
      keys,
    );
    expect((await logGenesis(deps(), encodeEntry(genesis))).ok).toBe(true);
    const start = () => startChain(genesis, { now: clock, schemaVersion: 1 }, BUDGET);
    logA = new DeviceLog(keys, await start(), PHONE, () => clock);
    logB = new DeviceLog(keys, await start(), LAPTOP, () => clock);
  });

  it('an edit on one device reaches the other as rows, through entries the server can’t read', async () => {
    const steps: [string, string, unknown][] = [
      ['POST', '/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'rent', amount: 1234 }] }],
      ['POST', '/api/settings/categories', { name: 'From the log', groupId: null, kind: 'spending' }],
      [
        'POST',
        '/api/transactions',
        {
          kind: 'pending',
          accountId: 'checking',
          date: '2026-11-10',
          amount: -990,
          payee: 'Sealed cafe',
          categoryId: 'electric',
          repeats: 'never',
        },
      ],
      ['POST', '/api/owed/nopa', { action: 'close' }],
    ];
    for (const [method, path, body] of steps) {
      const { entries, answer } = await edit(a, logA, method, path, body);
      expect(answer).toMatchObject({ ok: true, stored: 'now' });
      await logA.take(entries);
      await read(b, logB);
      expect(differences(await rowsOf(a), await rowsOf(b)), path).toEqual([]);
      expect(await other(b), path).toBe(await other(a));
    }
    // What the server holds says nothing of the edit: the words of the entry are not in its bytes.
    const stored = await logAfter(server, 1, 100);
    const text = stored.map((e) => new TextDecoder().decode(e.bytes)).join('');
    expect(text).not.toContain('Sealed cafe');
    expect(text).not.toContain('From the log');
  });

  it('a device that wrote on an older log is told so, reads on, and writes again', async () => {
    // The laptop edits while it has not read the phone's newest entry.
    const first = await edit(a, logA, 'POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'rent',
      assigned: 50_000,
    });
    expect(first.answer).toMatchObject({ ok: true });
    await logA.take(first.entries);
    const stale = await edit(b, logB, 'POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'electric',
      assigned: 7_000,
    });
    expect(stale.answer).toMatchObject({ ok: false, why: 'behind', retry: true });
    // It takes its own edit out, reads the log, and runs the edit again on top (the redo of a refused write).
    await b.applyRows(stale.ran.undo);
    await read(b, logB);
    const again = await edit(b, logB, 'POST', '/api/budget/set', {
      month: '2026-11',
      categoryId: 'electric',
      assigned: 7_000,
    });
    expect(again.answer).toMatchObject({ ok: true, stored: 'now' });
    await logB.take(again.entries);
    await read(a, logA);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    // Each device noted what it last saw from the other: the laptop's entry names the phone's last one.
    const set = decodeChangeSet(
      encodeChangeSet({ v: 1, at: 1, rows: [], seen: { [PHONE]: [first.entries[0]!.header.number, 'x'] } }),
    );
    expect(set.seen[PHONE]![0]).toBe(first.entries[0]!.header.number);
  });

  it('a large change set travels as parts and arrives whole; a changed entry is refused', async () => {
    // 300 rows of some size: more than one entry's 65,535 bytes.
    const budget = (await a.db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    const rows = Array.from({ length: 300 }, (_, i) => ({
      t: 'setting',
      k: [budget, `bulk-${i}`],
      d: { budget_id: budget, key: `bulk-${i}`, value: 'x'.repeat(300), updated_at: clock },
    }));
    clock += 1000;
    const entries = await logA.build(KIND.edit, { at: clock, rows });
    expect(entries.length).toBeGreaterThan(1);
    expect(new Set(entries.map((e) => e.header.parts)).size).toBe(1);
    expect((await logAppend(deps(), logA.number, entries.map(encodeEntry))).ok).toBe(true);
    await a.applyRows(rows);
    await logA.take(entries);
    await read(b, logB);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);

    // An entry whose sealed body was changed doesn't open, and a device takes nothing from it.
    clock += 1000;
    const [good] = await logA.build(KIND.edit, { at: clock, rows: [] });
    const bad = { ...good!, body: good!.body.slice() as Bytes };
    bad.body[5] = bad.body[5]! ^ 1;
    await expect(logB.take([bad])).rejects.toThrow();
    expect(() => decodeChangeSet(new Uint8Array([1, 2, 3]))).toThrow(LogFormatError);
  });
});
