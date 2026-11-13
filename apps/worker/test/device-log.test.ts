// Two devices share a budget only through its sealed, signed log (docs/privacy.md 5.3). One device runs an edit,
// records the rows it changed, seals them into an entry and sends it; the server stores the entry without
// reading it; the other device opens the entry and writes the rows, running nothing. Both copies end equal.
import type { Db } from '@ledgerline/db/sql';
import {
  advance,
  deriveBudgetKeys,
  fromStored,
  MAX_PLAIN,
  MAX_WRITE_ENTRIES,
  UpdateNeededError,
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
  toHex,
  ChainError,
  OpenError,
  openEntryBody,
  type BudgetKeys,
  type ChainState,
  type Bytes,
  type Entry,
} from '@ledgerline/seal';
import { beforeAll, describe, expect, it } from 'vitest';
import { deflateChangeSet, encodeChangeSet, MAX_SET_BYTES, openChangeSet } from '../src/local/change-set.js';
import { decodeChangeSet, DeviceLog, LogFormatError, TooLarge } from '../src/local/device-log.js';
import { RowsRefused, type LocalEngine } from '../src/local/engine.js';
import { LogSession, type LogTransport } from '../src/local/log-session.js';
import { logAfter, logAppend, logGenesis, stateFromJson, type LogDeps } from '../src/seal/log-store.js';
import { LOG_SCHEMA_PLAIN, LOG_SCHEMA_VERSION } from '../src/seal/log-versions.js';
import { syncPhone } from './phone.js';
import { storeDb } from './store-db.js';
import { differences, newPhone, rowsOf } from './twin.js';

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
    const taken = await log.read(entries);
    for (const t of taken.sets) await engine.applyRows(t.set.rows);
    taken.commit();
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
    // Each device notes what it last took from the other, inside its own sealed entries: the laptop's entry names
    // the phone's last one, by number and hash.
    const body = decodeChangeSet(await openEntryBody(again.entries[0]!, keys));
    expect(body.seen[PHONE]).toEqual([first.entries[0]!.header.number, toHex(first.entries[0]!.hash)]);
    expect(body.at).toBe(clock);
  });

  it('a large change set travels as parts and arrives whole; a changed entry is refused', async () => {
    // 600 rows of random text: more than one entry's 65,535 bytes even compressed.
    const budget = (await a.db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    const rows = Array.from({ length: 600 }, (_, i) => ({
      t: 'setting',
      k: [budget, `bulk-${i}`],
      d: { budget_id: budget, key: `bulk-${i}`, value: toHex(randomBytes(150)), updated_at: clock },
    }));
    clock += 1000;
    const entries = await logA.build(KIND.edit, { at: clock, rows });
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[0]!.header.schemaVersion).toBe(LOG_SCHEMA_VERSION);
    expect(new Set(entries.map((e) => e.header.parts)).size).toBe(1);
    expect((await logAppend(deps(), logA.number, entries.map(encodeEntry))).ok).toBe(true);
    await a.applyRows(rows);
    await logA.take(entries);
    await read(b, logB);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);

    expect(() => decodeChangeSet(new Uint8Array([1, 2, 3]))).toThrow(LogFormatError);
  });

  it('a set larger than one part is compressed; one part stays plain; an app from before asks for an update', async () => {
    const budget = await budgetOf(a);
    const setting = (key: string, value: string) => ({
      t: 'setting',
      k: [budget, key],
      d: { budget_id: budget, key, value, updated_at: clock },
    });
    // A small change: plain JSON, under the version an app from before reads.
    clock += 1000;
    const small = await logA.build(KIND.edit, { at: clock, rows: [setting('small', '1')] });
    expect(small.map((e) => e.header.schemaVersion)).toEqual([LOG_SCHEMA_PLAIN]);
    expect((await openEntryBody(small[0]!, keys))[0]).toBe('{'.charCodeAt(0));

    // About 2.4 MB of rows that repeat, as bank rows do: 37 parts plain, a few compressed.
    const rows = Array.from({ length: 8000 }, (_, i) =>
      setting(
        `many-${i}`,
        `{"amount":${(i * 37) % 9000},"name":"BLUE BOTTLE COFFEE ${i % 40}","pending":false}`,
      ),
    );
    const plain = encodeChangeSet({ v: 1, at: clock, rows, seen: {} }).length;
    expect(Math.ceil(plain / MAX_PLAIN)).toBeGreaterThan(MAX_WRITE_ENTRIES);
    clock += 1000;
    const entries = await logA.build(KIND.edit, { at: clock, rows });
    expect(entries.length).toBeLessThanOrEqual(4);
    expect(new Set(entries.map((e) => e.header.schemaVersion))).toEqual(new Set([LOG_SCHEMA_VERSION]));
    expect((await openEntryBody(entries[0]!, keys))[0]).toBe(1);

    // An app that knows only version 2 stops at the entry before it opens the body: nothing is taken.
    await read(b, logB);
    const before = await fromStored(stateFromJson((JSON.parse(logB.save()) as { state: string }).state));
    await expect(advance(before, entries[0]!, { now: clock, schemaVersion: 2 })).rejects.toThrow(
      UpdateNeededError,
    );

    // The server stores it as it stores any entry; the other device opens it and has the same rows.
    expect(await logAppend(deps(), logA.number, entries.map(encodeEntry))).toMatchObject({ ok: true });
    await a.applyRows(rows);
    await logA.take(entries);
    await read(b, logB);
    expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    expect(
      await b.db.prepare(`SELECT count(*) AS n FROM setting WHERE key LIKE 'many-%'`).first<{ n: number }>(),
    ).toEqual({ n: 8000 });
  });

  it('a set too large even compressed is refused before it is sent; a bad compressed body never opens', async () => {
    const budget = await budgetOf(a);
    // About 2.7 MB of random hex (1.2 MB of entropy): deflate can’t make it fit 16 parts.
    const rows = Array.from({ length: 4000 }, (_, i) => ({
      t: 'setting',
      k: [budget, `random-${i}`],
      d: { budget_id: budget, key: `random-${i}`, value: toHex(randomBytes(300)), updated_at: clock },
    }));
    clock += 1000;
    const head = logA.number;
    await expect(logA.build(KIND.edit, { at: clock, rows })).rejects.toThrow(TooLarge);
    expect(logA.number).toBe(head);

    const json = encodeChangeSet({ v: 1, at: clock, rows: rows.slice(0, 2), seen: {} });
    const packed = await deflateChangeSet(json);
    expect(await openChangeSet(packed, 3)).toMatchObject({ v: 1, at: clock });
    // Compressed under a version that is always plain; changed bytes; a length that is not the body's; one too
    // large to open.
    await expect(openChangeSet(packed, 2)).rejects.toThrow(LogFormatError);
    const changed = new Uint8Array(packed);
    changed[changed.length - 3]! ^= 0xff;
    await expect(openChangeSet(changed, 3)).rejects.toThrow(LogFormatError);
    const wrongLength = new Uint8Array(packed);
    new DataView(wrongLength.buffer).setUint32(1, json.length - 1);
    await expect(openChangeSet(wrongLength, 3)).rejects.toThrow(LogFormatError);
    const huge = new Uint8Array(packed);
    new DataView(huge.buffer).setUint32(1, MAX_SET_BYTES + 1);
    await expect(openChangeSet(huge, 3)).rejects.toThrow(LogFormatError);
  });

  it('one bad entry among good ones: the device takes none of them, and stays where it was', async () => {
    clock += 1000;
    const good = await logA.build(KIND.edit, {
      at: clock,
      rows: [
        {
          t: 'setting',
          k: [await budgetOf(a), 'kept'],
          d: { budget_id: await budgetOf(a), key: 'kept', value: '1', updated_at: clock },
        },
      ],
    });
    expect((await logAppend(deps(), logA.number, good.map(encodeEntry))).ok).toBe(true);
    for (const t of await logA.take(good)) await a.applyRows(t.set.rows);
    clock += 1000;
    const [next] = await logA.build(KIND.edit, { at: clock, rows: [] });
    const at = logB.number;

    // A signature that is not the budget's.
    const forged = { ...next!, signature: next!.signature.slice() as Bytes };
    forged.signature[3] = forged.signature[3]! ^ 1;
    await expect(logB.read([...good, forged])).rejects.toThrow(ChainError);
    expect(logB.number).toBe(at);

    // Signed by the budget's key, but sealed with a key that is not the log's: it doesn't open.
    const otherKeys = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
    const [sealedWrong] = await new DeviceLog(
      { ...keys, log: otherKeys.log },
      stateOf(logA),
      PHONE,
      () => clock,
    ).build(KIND.edit, { at: clock, rows: [] });
    await expect(logB.read([...good, sealedWrong!])).rejects.toThrow(OpenError);
    expect(logB.number).toBe(at);

    // The good entry alone is taken, with its rows, as if nothing had happened.
    const taken = await logB.read(good);
    expect(taken.sets.map((t) => [t.deviceId, t.kind, t.set.rows.length])).toEqual([[PHONE, KIND.edit, 1]]);
    for (const t of taken.sets) await b.applyRows(t.set.rows);
    taken.commit();
    expect(logB.number).toBe(at + 1);
  });

  it('rows no honest device writes are refused before anything is written', async () => {
    const budget = await budgetOf(b);
    const before = JSON.stringify(await rowsOf(b));
    const good = {
      t: 'setting',
      k: [budget, 'fine'],
      d: { budget_id: budget, key: 'fine', value: '1', updated_at: 1 },
    };
    const bad: [string, unknown][] = [
      // A column name that is SQL.
      [
        'column',
        {
          t: 'setting',
          k: [budget, 'x'],
          d: {
            budget_id: budget,
            key: 'x',
            "value, updated_at) SELECT ?1, 'leak', (SELECT value FROM local_state LIMIT 1), 1 --": 'v',
          },
        },
      ],
      ['table', { t: 'local_state', k: ['sync'], d: { key: 'sync', value: '{}' } }],
      ['table', { t: 'setting; DROP TABLE budget', k: [budget, 'x'], d: null }],
      ['key', { t: 'setting', k: [budget], d: null }],
      [
        'not the one',
        { t: 'setting', k: [budget, 'x'], d: { budget_id: budget, key: 'y', value: '1', updated_at: 1 } },
      ],
      [
        'value',
        {
          t: 'setting',
          k: [budget, 'x'],
          d: { budget_id: budget, key: 'x', value: { a: 1 }, updated_at: 1 },
        },
      ],
    ];
    for (const [why, row] of bad) {
      // A good row first: it must not be written when a later row of the same set is refused.
      await expect(b.applyRows([good, row] as never), why).rejects.toThrow(RowsRefused);
      expect(JSON.stringify(await rowsOf(b)), why).toBe(before);
    }
    expect((await b.db.prepare(`SELECT count(*) AS n FROM budget`).first<{ n: number }>())!.n).toBe(1);
  });

  // The copy as a base plus a queue (local/log-session.ts): edits made with no connection wait in the engine's
  // queue; the session sends each as an entry, and reads the other device's entries under the queue.
  describe('a session: base plus queue', () => {
    const transport: LogTransport = {
      after: async (number) => (await logAfter(server, number, 100)).map((e) => e.bytes),
      append: (base, entries) => logAppend(deps(), base, entries),
    };
    let sa: LogSession;
    let sb: LogSession;
    const offline = async (engine: LocalEngine, method: string, path: string, body: unknown) => {
      clock += 1000;
      const r = await engine.enqueue({ id: `session-edit-${++n}-xxx`, at: clock, method, path, body });
      expect(r.response.status, await r.response.clone().text()).toBeLessThan(300);
    };
    const rent = async (e: LocalEngine) =>
      (await e.db
        .prepare(`SELECT amount FROM assignment WHERE month = '2026-11' AND category_id = 'rent'`)
        .first<{ amount: number }>())!.amount;

    beforeAll(async () => {
      sa = new LogSession(a, logA, transport, encodeEntry);
      sb = new LogSession(b, logB, transport, encodeEntry);
      // Both copies stand at the log's last entry (what the tests above left).
      await read(a, logA);
      await read(b, logB);
      for (const [engine, log] of [
        [a, logA],
        [b, logB],
      ] as const) {
        const st = await engine.state();
        await engine.apply({ ...basePage(st), through: log.number }, Date.now());
      }
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

    it('waiting edits go to the log one by one, and the other device reads them', async () => {
      await offline(a, 'POST', '/api/budget/assign', {
        month: '2026-11',
        items: [{ categoryId: 'rent', amount: 100 }],
      });
      await offline(a, 'POST', '/api/transactions', {
        kind: 'pending',
        accountId: 'checking',
        date: '2026-11-11',
        amount: -450,
        payee: 'Queued lunch',
        categoryId: 'electric',
        repeats: 'never',
      });
      expect((await a.queue()).length).toBe(2);
      expect(await sa.flush()).toEqual({ sent: 2, lost: 0 });
      expect((await a.queue()).length).toBe(0);
      expect((await a.state()).through).toBe(logA.number);
      expect(await sb.pull()).toMatchObject({ entries: 2, lost: 0 });
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

    it('the log moved on: the queue comes out, the newer entries go in, the queue runs again', async () => {
      const start = await rent(a);
      // The phone adds 500 to Rent with no connection. Meanwhile the laptop sets Rent to 90,000 and sends it.
      await offline(a, 'POST', '/api/budget/assign', {
        month: '2026-11',
        items: [{ categoryId: 'rent', amount: 500 }],
      });
      expect(await rent(a)).toBe(start + 500);
      await offline(b, 'POST', '/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 90_000 });
      expect(await sb.flush()).toEqual({ sent: 1, lost: 0 });
      // The phone sends: behind, so it reads the laptop's entry under its queue and sends its edit on top.
      expect(await sa.flush()).toEqual({ sent: 1, lost: 0 });
      expect(await rent(a)).toBe(90_500);
      await sb.pull();
      expect(await rent(b)).toBe(90_500);
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
    });

    it('an edit of a row another device removed is lost, and says so', async () => {
      await offline(b, 'POST', '/api/transactions', {
        kind: 'pending',
        accountId: 'checking',
        date: '2026-11-12',
        amount: -200,
        payee: 'Gone soon',
        categoryId: 'electric',
        repeats: 'never',
      });
      await sb.flush();
      await sa.pull();
      const key = (await a.db
        .prepare(`SELECT txn_key FROM manual_pending WHERE payee_name = 'Gone soon'`)
        .first<{ txn_key: string }>())!.txn_key;
      // The phone writes a note on it with no connection; the laptop deletes it and sends that.
      await offline(a, 'PATCH', `/api/transactions/${key}`, { note: 'too late' });
      await offline(a, 'POST', '/api/budget/assign', {
        month: '2026-11',
        items: [{ categoryId: 'internet', amount: 7 }],
      });
      await offline(b, 'DELETE', `/api/transactions/${key}`, undefined);
      expect(await sb.flush()).toEqual({ sent: 1, lost: 0 });
      // The note has nothing to act on any more; the other edit goes through.
      expect(await sa.flush()).toEqual({ sent: 1, lost: 1 });
      await sb.pull();
      expect(differences(await rowsOf(a), await rowsOf(b))).toEqual([]);
      expect(await other(b)).toBe(await other(a));
    });
  });
});

/** The budget a copy holds. */
async function budgetOf(e: LocalEngine): Promise<string> {
  return (await e.db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
}

/** Where a device's log stands (for a second writer on the same place, in a test). */
function stateOf(log: DeviceLog): ChainState {
  return (log as unknown as { state: ChainState }).state;
}

/** An empty page of changes for a copy, to set where it stands. */
function basePage(st: { format: number; epoch: string | null; offset: number }) {
  return {
    format: st.format,
    epoch: st.epoch ?? 'log',
    serverTime: Date.now() + st.offset,
    through: 0,
    more: false,
    cursor: null,
    rows: [],
  };
}
