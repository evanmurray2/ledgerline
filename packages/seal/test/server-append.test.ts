// The server's own rules for a write (docs/privacy-keys.md 7.2).
import { describe, expect, it } from 'vitest';
import {
  type AppendContext,
  AppendRefused,
  type ChainState,
  checkGenesisWrite,
  checkWrite,
  encodeSlotChange,
  type Entry,
  type EntryFields,
  INTENT_WAIT_MS,
  KIND,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  type RefusedWhy,
  sealedEntry,
  sha256,
  toHex,
  utf8,
} from '../src/index.js';
import { Budget, BUDGET, LAPTOP, PHONE } from './budget.js';

const MIN = 60_000;

/** What the server knows; by default its clock is the writer's and nothing waits. */
function ctx(b: Budget, over: Partial<AppendContext> = {}): AppendContext {
  return {
    now: b.time,
    freshWay: false,
    holds: () => Promise.resolve(false),
    lastCompleteRun: b.state.filedThrough,
    receiptHashes: () => Promise.resolve(null),
    resting: false,
    ...over,
  };
}

/** Makes the entries of one write, each on top of the one before, without taking them. */
async function build(b: Budget, makers: (() => Promise<Entry>)[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const make of makers) {
    const e = await make();
    b.entries.push(e);
    out.push(e);
  }
  return out;
}

/** Forgets entries that were built and not stored. */
function drop(b: Budget, entries: Entry[]): void {
  b.entries.length -= entries.length;
  b.undo();
}

const edit = (b: Budget, over: Partial<EntryFields> = {}, device = PHONE) =>
  sealedEntry(b.fields(KIND.edit, device, over), utf8('an edit'), b.keys);

async function refused(p: Promise<unknown>): Promise<RefusedWhy> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppendRefused) return e.why;
    throw e;
  }
  throw new Error('not refused');
}

async function store(b: Budget, entries: Entry[], c: AppendContext): Promise<ChainState> {
  const s = await checkWrite(b.state, entries, c);
  if (s === 'already stored') throw new Error('already stored');
  b.state = s;
  return s;
}

/** Runs that wait at the Worker: a receipt for each, and the hashes the server holds. */
async function runs(n: number) {
  const receipts = Array.from({ length: n }, () => randomBytes(32));
  const hashes = await Promise.all(receipts.map((r) => sha256(r)));
  return { receipts, hashes };
}

describe("the server's rules for a write", () => {
  it('takes a genesis entry near its clock only', async () => {
    const b = await Budget.create();
    const g = b.entries[0]!;
    const s = await checkGenesisWrite(g, BUDGET, ctx(b, { now: g.header.time + 4 * MIN }));
    expect(s.number).toBe(1);
    expect(await refused(checkGenesisWrite(g, BUDGET, ctx(b, { now: g.header.time + 6 * MIN })))).toBe(
      'clock',
    );
    expect(await refused(checkGenesisWrite(g, BUDGET, ctx(b, { now: g.header.time - 6 * MIN })))).toBe(
      'clock',
    );
    expect(await refused(checkGenesisWrite(g, '01BX5ZZKBKACTAV9WEVGEMMVRZ', ctx(b)))).toBe('rules');
  });

  it('takes a write of several entries, all or none', async () => {
    const b = await Budget.create();
    const w = await build(b, [() => edit(b), () => edit(b, {}, LAPTOP), () => edit(b)]);
    const s = await store(b, w, ctx(b));
    expect(s.number).toBe(4);

    // A write whose second entry breaks a rule stores nothing: the state is unchanged.
    const before = b.state;
    const bad = await build(b, [() => edit(b), () => edit(b, { number: 9 })]);
    expect(await refused(checkWrite(b.state, bad, ctx(b)))).toBe('rules');
    expect(b.state).toBe(before);
    drop(b, bad);

    expect(await refused(checkWrite(b.state, [], ctx(b)))).toBe('empty');
  });

  it("keeps an entry's time within 5 minutes of its clock, either way", async () => {
    const b = await Budget.create();
    const w = await build(b, [() => edit(b)]);
    expect(await refused(checkWrite(b.state, w, ctx(b, { now: b.time + 5 * MIN + 1 })))).toBe('clock');
    expect(await refused(checkWrite(b.state, w, ctx(b, { now: b.time - 5 * MIN - 1 })))).toBe('clock');
    await store(b, w, ctx(b, { now: b.time - 5 * MIN }));
  });

  it('answers "already stored" for a write sent again, and refuses a half-stored one', async () => {
    const b = await Budget.create();
    const w = await build(b, [() => edit(b), () => edit(b)]);
    const first = toHex(w[0]!.header.entryId);
    expect(await checkWrite(b.state, w, ctx(b, { holds: () => Promise.resolve(true) }))).toBe(
      'already stored',
    );
    const half = ctx(b, { holds: (id) => Promise.resolve(toHex(id) === first) });
    expect(await refused(checkWrite(b.state, w, half))).toBe('partly stored');
  });

  it('refuses one entry id for two changes in a write', async () => {
    const b = await Budget.create();
    const id = randomBytes(16);
    const w = await build(b, [() => edit(b, { entryId: id }), () => edit(b), () => edit(b, { entryId: id })]);
    expect(await refused(checkWrite(b.state, w, ctx(b)))).toBe('entry id');
  });

  it('refuses a write that ends inside a part set', async () => {
    const b = await Budget.create();
    const id = randomBytes(16);
    const time = b.time + 1000;
    const w = await build(b, [
      () => edit(b, { entryId: id, part: 1, parts: 2 }),
      () => edit(b, { entryId: id, part: 2, parts: 2, time }),
    ]);
    expect(await refused(checkWrite(b.state, [w[0]!], ctx(b)))).toBe('cut off');
    const s = await store(b, w, ctx(b));
    expect(s.number).toBe(3);
  });

  it('files bank runs only with the receipt of each', async () => {
    const b = await Budget.create();
    const { receipts, hashes } = await runs(3);
    const waiting = (over: Partial<AppendContext> = {}) =>
      ctx(b, {
        lastCompleteRun: 3,
        receiptHashes: (from, to) => Promise.resolve(from === 1 && to <= 3 ? hashes.slice(0, to) : null),
        ...over,
      });
    const file = (through: number, shown: Uint8Array[]) =>
      sealedEntry(
        b.fields(KIND.bank, PHONE, { filedThrough: through, receipts: shown as never }),
        utf8('bank rows'),
        b.keys,
      );

    // A receipt that isn't the run's.
    let w = await build(b, [() => file(2, [receipts[0]!, randomBytes(32)])]);
    expect(await refused(checkWrite(b.state, w, waiting()))).toBe('receipts');
    drop(b, w);
    // Receipts in the wrong order.
    w = await build(b, [() => file(2, [receipts[1]!, receipts[0]!])]);
    expect(await refused(checkWrite(b.state, w, waiting()))).toBe('receipts');
    drop(b, w);
    // A run that isn't complete yet.
    w = await build(b, [() => file(3, receipts)]);
    expect(await refused(checkWrite(b.state, w, waiting({ lastCompleteRun: 2 })))).toBe('receipts');
    // A run the server has no receipt hash for.
    expect(
      await refused(checkWrite(b.state, w, waiting({ receiptHashes: () => Promise.resolve(null) }))),
    ).toBe('receipts');
    const s = await store(b, w, waiting());
    expect(s.filedThrough).toBe(3);
  });

  it('holds an edit back while a complete bank run waits, unless the write files it first', async () => {
    const b = await Budget.create();
    const { receipts, hashes } = await runs(1);
    const c = (): AppendContext =>
      ctx(b, { lastCompleteRun: 1, receiptHashes: () => Promise.resolve(hashes) });
    let w = await build(b, [() => edit(b)]);
    expect(await refused(checkWrite(b.state, w, c()))).toBe('bank runs first');
    drop(b, w);

    // An edit ahead of the filing in the same write is held back too.
    const file = () =>
      sealedEntry(b.fields(KIND.bank, PHONE, { filedThrough: 1, receipts }), utf8('rows'), b.keys);
    w = await build(b, [() => edit(b), file]);
    expect(await refused(checkWrite(b.state, w, c()))).toBe('bank runs first');
    drop(b, w);

    w = await build(b, [file, () => edit(b)]);
    const s = await store(b, w, c());
    expect(s.filedThrough).toBe(1);
  });

  it('rests edits and bank filing at the limit, never key and slot changes', async () => {
    const b = await Budget.create();
    const resting = (over: Partial<AppendContext> = {}) => ctx(b, { resting: true, ...over });
    let w = await build(b, [() => edit(b)]);
    expect(await refused(checkWrite(b.state, w, resting()))).toBe('limit');
    drop(b, w);
    const { receipts, hashes } = await runs(1);
    w = await build(b, [
      () => sealedEntry(b.fields(KIND.bank, PHONE, { filedThrough: 1, receipts }), utf8('rows'), b.keys),
    ]);
    const bank = resting({ lastCompleteRun: 1, receiptHashes: () => Promise.resolve(hashes) });
    expect(await refused(checkWrite(b.state, w, bank))).toBe('limit');
    drop(b, w);

    // A sign-out, a new passkey, an intent and a key change all pass, also while a bank run waits.
    const held = () => resting({ lastCompleteRun: 5 });
    w = await build(b, [() => sealedEntry(b.fields(KIND.signOut, PHONE), utf8('sign out'), b.keys)]);
    await store(b, w, held());
    const laptop = await passkeySlot(randomBytes(32), BUDGET, randomBytes(16));
    const record = await newSlotRecord(laptop, b.bk, b.keys, BUDGET, b.state.public.genesisSignPub);
    w = await build(b, [
      () =>
        publicEntry(
          b.fields(KIND.slotChange, PHONE),
          encodeSlotChange({ prevPublic: b.lastPublic, slots: [record] }),
          b.keys,
        ),
    ]);
    await store(b, w, held());
    w = await build(b, [() => b.intent(b.time + INTENT_WAIT_MS + 1000, [laptop.slotId])]);
    await store(b, w, held());
    const k = await b.keyChangeEntry([b.passkey.slotId, b.recovery.slotId, laptop.slotId]);
    b.entries.push(k.entry);
    const s = await store(b, [k.entry], held());
    expect(s.public.keyVersion).toBe(2);
  });

  it('asks a fresh way in for an intent that has waited before it removes a way in', async () => {
    const b = await Budget.create();
    const fresh = (over: Partial<AppendContext> = {}) => ctx(b, { freshWay: true, ...over });
    const keep = [b.recovery.slotId];

    // No intent: refused for a fresh way in, taken for an old one.
    let k = await b.keyChangeEntry(keep);
    expect(await refused(checkWrite(b.state, [k.entry], fresh()))).toBe('intent needed');
    b.undo();

    // A fresh way in that removes nothing needs no intent.
    k = await b.keyChangeEntry([b.passkey.slotId, b.recovery.slotId]);
    expect(await checkWrite(b.state, [k.entry], fresh())).not.toBe('already stored');
    b.undo();

    // With an intent, 7 days later.
    const wait = INTENT_WAIT_MS;
    const intent = await b.intent(b.time + 1000 + wait, [b.passkey.slotId]);
    b.entries.push(intent);
    await store(b, [intent], fresh());
    const named = { number: intent.header.number, hash: intent.hash };
    b.time += wait;
    k = await b.keyChangeEntry(keep, { intent: named });
    // The server's clock has not reached the intent's date, though the entry's own time has.
    expect(await refused(checkWrite(b.state, [k.entry], fresh({ now: b.time - 2000 })))).toBe(
      'intent not due',
    );
    b.entries.push(k.entry);
    const s = await store(b, [k.entry], fresh());
    expect(s.public.keyVersion).toBe(2);
    expect([...s.public.slots.keys()]).toEqual(keep);
  });

  it('lets an old way in remove a way in at once', async () => {
    const b = await Budget.create();
    const k = await b.keyChangeEntry([b.passkey.slotId]);
    b.entries.push(k.entry);
    const s = await store(b, [k.entry], ctx(b));
    expect(s.public.keyVersion).toBe(2);
  });
});
