// The server's store of a budget's sealed, signed log (src/seal/log-store.ts; docs/privacy.md 5.3). A device
// writes real entries with the package's own code; the store takes a whole write or none of it, in order, once.
import type { Db } from '@ledgerline/db/sql';
import { encodeEntry, KIND, readEntry, toHex, type Entry } from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  KEY_ENTRIES_A_DAY,
  logAfter,
  logAppend,
  logGenesis,
  logHead,
  stateFromJson,
  stateToJson,
  type LogDeps,
} from '../src/seal/log-store.js';
import { BUDGET, PHONE, T0, Writer } from './log-writer.js';

const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
import { storeDb } from './store-db.js';

const deps = (db: Db, now: number, over: Partial<LogDeps> = {}): LogDeps => ({
  db,
  budgetId: BUDGET,
  now,
  resting: false,
  freshWay: false,
  lastCompleteRun: 0,
  receiptHashes: async () => null,
  ...over,
});

describe('the sealed log on the server', () => {
  it('takes a genesis entry once, then writes in order, each whole or not at all', async () => {
    const db = storeDb('log-store-1');
    const w = new Writer();
    expect(await logHead(db)).toBe(0);
    // No log yet: nothing can be appended.
    expect(await logAppend(deps(db, T0), 0, [])).toMatchObject({ ok: false, why: 'rules' });

    const g = await w.genesis();
    expect(await logGenesis(deps(db, w.time), encodeEntry(g))).toEqual({
      ok: true,
      number: 1,
      stored: 'now',
    });
    // Sent again after a lost answer: stored already. Another budget's start: refused.
    expect(await logGenesis(deps(db, w.time), encodeEntry(g))).toEqual({
      ok: true,
      number: 1,
      stored: 'already',
    });
    const other = await new Writer().genesis();
    // A budget starts once: another first entry is refused for good, so a device doesn't try it again.
    expect(await logGenesis(deps(db, w.time), encodeEntry(other))).toEqual({
      ok: false,
      why: 'rules',
      detail: 'a log exists',
      retry: false,
    });

    // A write of two entries on top of entry 1.
    const a = await w.edit('one');
    const b = await w.edit('two');
    const write = [encodeEntry(a), encodeEntry(b)];
    expect(await logAppend(deps(db, w.time), 1, write)).toEqual({ ok: true, number: 3, stored: 'now' });
    expect(await logHead(db)).toBe(3);
    // The same write again (its answer was lost): nothing is stored twice.
    expect(await logAppend(deps(db, w.time), 1, write)).toEqual({ ok: true, number: 3, stored: 'already' });
    expect((await logAfter(db, 0, 10)).map((e) => e.number)).toEqual([1, 2, 3]);

    // What the server keeps is what the device signed, byte for byte.
    const stored = await logAfter(db, 1, 10);
    expect(toHex(stored[0]!.bytes)).toBe(toHex(write[0]!));
    expect(toHex((await readEntry(stored[1]!.bytes)).hash)).toBe(toHex(b.hash));
  });

  it('refuses a write made on an older log, a changed entry, and a wrong clock, and stores none of it', async () => {
    const db = storeDb('log-store-2');
    const w = new Writer();
    expect((await logGenesis(deps(db, T0 + 1000), encodeEntry(await w.genesis()))).ok).toBe(true);
    const first = await w.edit('first');
    expect((await logAppend(deps(db, w.time), 1, [encodeEntry(first)])).ok).toBe(true);

    // A second device wrote on entry 1 too: it is behind, and reads on.
    const late = new Writer();
    late.keys = w.keys;
    late.last = (await readEntry((await logAfter(db, 0, 1))[0]!.bytes)) as Entry;
    late.time = w.time;
    late.counter = 5;
    const stale = await late.edit('made on entry 1');
    expect(await logAppend(deps(db, late.time), 1, [encodeEntry(stale)])).toEqual({
      ok: false,
      why: 'behind',
      number: 2,
      retry: true,
    });

    // One good entry and one whose body was changed after signing: neither is stored.
    const good = await w.edit('good');
    const bad = await w.edit('bad');
    const bytes = encodeEntry(bad);
    bytes[bytes.length - 80] = bytes[bytes.length - 80]! ^ 1;
    expect(await logAppend(deps(db, w.time), 2, [encodeEntry(good), bytes])).toMatchObject({
      ok: false,
      why: 'rules',
      retry: false,
    });
    expect(await logHead(db)).toBe(2);
    // A signature that is not the budget's.
    const forged = encodeEntry(good);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    expect(await logAppend(deps(db, w.time), 2, [forged])).toMatchObject({
      ok: false,
      why: 'rules',
      retry: false,
    });
    expect(await logHead(db)).toBe(2);

    // The server's clock is more than 5 minutes from the entry's.
    expect(await logAppend(deps(db, w.time + 6 * 60_000), 2, [encodeEntry(good)])).toMatchObject({
      ok: false,
      why: 'clock',
      retry: true,
    });
    // An edit is held while writes rest (90% of a daily limit).
    expect(await logAppend(deps(db, w.time, { resting: true }), 2, [encodeEntry(good)])).toMatchObject({
      ok: false,
      why: 'limit',
    });
    // Bytes that are no entry.
    expect(await logAppend(deps(db, w.time), 2, [new Uint8Array([1, 2, 3])])).toEqual({
      ok: false,
      why: 'rules',
      detail: 'not an entry',
      retry: false,
    });
    // A fault that is not a refusal (here: the store can't be read) is thrown on, never answered as "refused
    // for good".
    const down = {
      ...deps(db, w.time),
      receiptHashes: async () => null,
      db: new Proxy(db, {
        get: (t, k) =>
          k === 'prepare'
            ? (sql: string) => {
                if (sql.includes('count(*)')) throw new Error('database is down');
                return t.prepare(sql);
              }
            : Reflect.get(t, k),
      }),
    };
    await expect(logAppend(down, 2, [encodeEntry(good)])).rejects.toThrow('database is down');
    expect(await logHead(db)).toBe(2);
    expect((await logAppend(deps(db, w.time), 2, [encodeEntry(good)])).ok).toBe(true);
  });

  it('stores one of two writes that race on the same entry, and tells the other it is behind', async () => {
    const db = storeDb('log-store-race');
    const w = new Writer();
    expect((await logGenesis(deps(db, T0 + 1000), encodeEntry(await w.genesis()))).ok).toBe(true);
    const genesis = w.last!;
    // Two devices write on entry 1 at once; each write is checked against the same state.
    const a = await w.edit('from the phone');
    const other = new Writer();
    other.keys = w.keys;
    other.last = genesis;
    other.time = w.time;
    const b = await other.edit('from the laptop', { deviceId: LAPTOP, deviceCounter: 1 });
    // The phone's write is checked and waits at its storing step; the laptop's is checked and stored meanwhile.
    let reached!: () => void;
    let release!: () => void;
    const atStore = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const slow = new Proxy(db, {
      get: (t, k) =>
        k === 'batch'
          ? async (stmts: Parameters<Db['batch']>[0]) => {
              reached();
              await gate;
              return t.batch(stmts);
            }
          : Reflect.get(t, k),
    });
    const phone = logAppend(deps(slow, w.time), 1, [encodeEntry(a)]);
    await atStore;
    expect(await logAppend(deps(db, w.time), 1, [encodeEntry(b)])).toEqual({
      ok: true,
      number: 2,
      stored: 'now',
    });
    release();
    // The phone's write passed its check, but the log moved on before it was stored: it is behind, and nothing of
    // it is stored.
    expect(await phone).toEqual({ ok: false, why: 'behind', number: 2, retry: true });
    expect(await logHead(db)).toBe(2);
    expect(toHex((await readEntry((await logAfter(db, 1, 1))[0]!.bytes)).hash)).toBe(toHex(b.hash));

    // Two writes sent at once, with no gate: one is stored, the other is told it is behind.
    const c = await other.edit('the laptop again');
    w.last = b;
    w.counter = 1;
    w.time = other.time;
    const d = await w.edit('the phone, on entry 2 too');
    const answers = await Promise.all([
      logAppend(deps(db, other.time), 2, [encodeEntry(c)]),
      logAppend(deps(db, other.time), 2, [encodeEntry(d)]),
    ]);
    expect(answers.filter((x) => x.ok)).toHaveLength(1);
    expect(await logHead(db)).toBe(3);
  });

  it('keeps device counters as rows, and takes a state stored as one value before Nov 13, 2026', async () => {
    const db = storeDb('log-store-old-state');
    const w = new Writer();
    expect((await logGenesis(deps(db, T0 + 1000), encodeEntry(await w.genesis()))).ok).toBe(true);
    expect((await logAppend(deps(db, w.time), 1, [encodeEntry(await w.edit('one'))])).ok).toBe(true);
    const note = async (key: string) =>
      (await db.prepare(`SELECT value FROM store_note WHERE key = ?1`).bind(key).first<{ value: number }>())
        ?.value;
    expect(await note(`device:${PHONE}`)).toBe(2);
    // The JSON value no longer holds the parts that grow: counters and the public entries are empty.
    const now = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
    const parsed = stateFromJson(now!.state) as unknown as {
      counters: Map<string, number>;
      public: { publics: unknown[] };
    };
    expect(parsed.counters.size).toBe(0);
    expect(parsed.public.publics).toEqual([]);

    // Today's format: every counter in the JSON value and no rows (the owner's store on Nov 13, 2026), with an
    // entry stored as base64 text.
    const old = stateFromJson(now!.state) as unknown as Record<string, unknown> & {
      public: Record<string, unknown>;
    };
    old.counters = new Map([
      [PHONE, 2],
      [LAPTOP, 7],
    ]);
    old.public.publics = [{ number: 1, hash: new Uint8Array(32), keyVersion: 1 }];
    await db.batch([
      db.prepare(`DELETE FROM store_note WHERE key LIKE 'device:%'`),
      db.prepare(`UPDATE log_state SET state = ?1 WHERE id = 1`).bind(stateToJson(old as never)),
      db
        .prepare(`UPDATE log_entry SET bytes = ?1 WHERE number = 2`)
        .bind(btoa(String.fromCharCode(...(await logAfter(db, 1, 1))[0]!.bytes))),
    ]);
    expect((await logAfter(db, 1, 1))[0]!.number).toBe(2);
    expect((await readEntry((await logAfter(db, 1, 1))[0]!.bytes)).header.number).toBe(2);
    // A device counter must follow the one in the JSON value.
    expect((await logAppend(deps(db, w.time), 2, [encodeEntry(await w.edit('two'))])).ok).toBe(true);
    expect(await note(`device:${PHONE}`)).toBe(3);
    // Every counter of the JSON value moved to a row, and the value holds none now.
    expect(await note(`device:${LAPTOP}`)).toBe(7);
    const after = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
    expect((stateFromJson(after!.state) as unknown as { counters: Map<string, number> }).counters.size).toBe(
      0,
    );
    // The laptop goes on from its counter in the row.
    const laptop = new Writer();
    laptop.keys = w.keys;
    laptop.last = w.last;
    laptop.time = w.time;
    const stale = await laptop.edit('a counter from the start', { deviceId: LAPTOP, deviceCounter: 1 });
    expect(await logAppend(deps(db, laptop.time), 3, [encodeEntry(stale)])).toMatchObject({
      ok: false,
      why: 'rules',
    });
    laptop.last = w.last;
    const next = await laptop.edit('its next counter', { deviceId: LAPTOP, deviceCounter: 8 });
    expect((await logAppend(deps(db, laptop.time), 3, [encodeEntry(next)])).ok).toBe(true);
    expect(await note(`device:${LAPTOP}`)).toBe(8);
  });

  it('refuses a new device past the most devices a budget has', async () => {
    const db = storeDb('log-store-devices');
    const w = new Writer();
    expect((await logGenesis(deps(db, T0 + 1000), encodeEntry(await w.genesis()))).ok).toBe(true);
    // 4,095 more devices have written (the genesis device is the first).
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4095)
         INSERT INTO store_note (key, value) SELECT 'device:other-' || i, 1 FROM n`,
      )
      .run();
    const late = await w.edit('one device too many', { deviceId: LAPTOP, deviceCounter: 1 });
    expect(await logAppend(deps(db, w.time), 1, [encodeEntry(late)])).toEqual({
      ok: false,
      why: 'rules',
      detail: 'too many devices',
      retry: false,
    });
    // A device that has written before goes on.
    w.last = (await readEntry((await logAfter(db, 0, 1))[0]!.bytes)) as Entry;
    w.counter = 1;
    expect((await logAppend(deps(db, w.time), 1, [encodeEntry(await w.edit('the phone'))])).ok).toBe(true);
  });

  it('counts the never-held kinds per day in a note the delete rule does not touch', async () => {
    const db = storeDb('log-store-key-day');
    const w = new Writer();
    expect((await logGenesis(deps(db, T0 + 1000), encodeEntry(await w.genesis()))).ok).toBe(true);
    const signOut = () => w.entry(KIND.signOut, '');
    expect((await logAppend(deps(db, w.time), 1, [encodeEntry(await signOut())])).ok).toBe(true);
    const note = async (key: string) =>
      (await db.prepare(`SELECT value FROM store_note WHERE key = ?1`).bind(key).first<{ value: number }>())
        ?.value;
    expect(await note('key_entries')).toBe(1);
    expect(await note('key_day')).toBe(Math.floor(w.time / 86_400_000));
    // The entry is gone (as the delete rule removes a sealed one); the day's count is not.
    await db.prepare(`UPDATE log_entry SET created_at = 0 WHERE number = 2`).run();
    await db
      .prepare(`UPDATE store_note SET value = ?1 WHERE key = 'key_entries'`)
      .bind(KEY_ENTRIES_A_DAY)
      .run();
    expect(await logAppend(deps(db, w.time), 2, [encodeEntry(await signOut())])).toMatchObject({
      ok: false,
      why: 'limit',
    });
    // A new day has a new count. (The entry is dated by the server's clock of that day.)
    w.last = (await readEntry((await logAfter(db, 1, 1))[0]!.bytes)) as Entry;
    w.counter = 2;
    w.time += 86_400_000;
    expect((await logAppend(deps(db, w.time), 2, [encodeEntry(await signOut())])).ok).toBe(true);
    expect(await note('key_entries')).toBe(1);
  });

  it('keeps the chain state whole through storage', () => {
    const state = {
      number: 7,
      hash: new Uint8Array([1, 2, 255]),
      counters: new Map([['dev', 3]]),
      public: {
        signPubs: new Map([[1, new Uint8Array([9])]]),
        publics: [{ number: 1, hash: new Uint8Array([4]) }],
      },
      pending: null,
    };
    const back = stateFromJson(stateToJson(state as never)) as unknown as typeof state;
    expect(back).toEqual(state);
    expect(back.hash).toBeInstanceOf(Uint8Array);
    expect(back.public.signPubs.get(1)).toEqual(new Uint8Array([9]));
  });
});
