// The server's store of a budget's sealed, signed log (src/seal/log-store.ts; docs/privacy.md 5.3). A device
// writes real entries with the package's own code; the store takes a whole write or none of it, in order, once.
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
  sealedEntry,
  toHex,
  utf8,
  type BudgetKeys,
  type Bytes,
  type Entry,
} from '@ledgerline/seal';
import { describe, expect, it } from 'vitest';
import {
  logAfter,
  logAppend,
  logGenesis,
  logHead,
  stateFromJson,
  stateToJson,
  type LogDeps,
} from '../src/seal/log-store.js';
import { storeDb } from './store-db.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;

/** A device writing a budget's log, entry on entry (as packages/seal/test/budget.ts does). */
class Writer {
  keys!: BudgetKeys;
  bk = randomBytes(32);
  last: Entry | null = null;
  time = T0;
  counter = 0;

  fields(kind: number, over: Record<string, unknown> = {}) {
    this.time += 1000;
    return {
      kind,
      budgetId: BUDGET,
      number: (this.last?.header.number ?? 0) + 1,
      prevHash: this.last?.hash ?? (new Uint8Array(32) as Bytes),
      entryId: randomBytes(16),
      time: this.time,
      deviceId: PHONE,
      deviceCounter: ++this.counter,
      keyVersion: 1,
      schemaVersion: 1,
      processingVersion: 1,
      part: 1,
      parts: 1,
      filedThrough: 0,
      receipts: [],
      scanThrough: 0,
      ...over,
    };
  }

  async genesis(): Promise<Entry> {
    this.keys = await deriveBudgetKeys(this.bk, BUDGET, 1);
    const inbox = await newInbox(this.keys, BUDGET, 1);
    const pub = this.keys.sign.pub;
    const body = encodeGenesis({
      signPub: pub,
      inboxPub: inbox.pair.pub,
      wrappedInbox: inbox.wrapped,
      slots: [
        await newSlotRecord(
          await passkeySlot(randomBytes(32), BUDGET, randomBytes(16)),
          this.bk,
          this.keys,
          BUDGET,
          pub,
        ),
        await newSlotRecord(await recoverySlot(randomBytes(32), 1), this.bk, this.keys, BUDGET, pub),
      ],
    });
    return (this.last = await publicEntry(this.fields(KIND.genesis), body, this.keys));
  }

  async edit(text: string, over: Record<string, unknown> = {}): Promise<Entry> {
    return (this.last = await sealedEntry(this.fields(KIND.edit, over), utf8(text), this.keys));
  }
}

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
    const back = stateFromJson(stateToJson(state)) as typeof state;
    expect(back).toEqual(state);
    expect(back.hash).toBeInstanceOf(Uint8Array);
    expect(back.public.signPubs.get(1)).toEqual(new Uint8Array([9]));
  });
});
