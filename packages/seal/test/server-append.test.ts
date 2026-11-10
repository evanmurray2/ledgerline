// The server's own rules for a write (docs/privacy-keys.md 7.2).
import { describe, expect, it } from 'vitest';
import {
  type AppendContext,
  AppendRefused,
  type ChainState,
  checkGenesisWrite,
  checkWrite,
  encodeCancel,
  encodeKeyChange,
  encodeSlotChange,
  encodeSnapshotHeader,
  type Entry,
  type EntryFields,
  INTENT_WAIT_MS,
  KIND,
  type Kind,
  MAX_KEY_ENTRIES_PER_WRITE,
  MAX_WRITE_ENTRIES,
  newSlotRecord,
  passkeySlot,
  publicEntry,
  randomBytes,
  type RefusedWhy,
  sealedEntry,
  sha256,
  snapshotStandsAt,
  SIGN_OUT_BODY_LEN,
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
    schemaVersion: 1,
    processingVersion: 1,
    stored: () => Promise.resolve(null),
    keyEntriesLeft: 20,
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

async function refusedAs(p: Promise<unknown>): Promise<AppendRefused> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppendRefused) return e;
    throw e;
  }
  throw new Error('not refused');
}
const refused = async (p: Promise<unknown>): Promise<RefusedWhy> => (await refusedAs(p)).why;

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
    // A genesis entry is never part of a later write.
    expect(await refused(checkWrite(b.state, [g], ctx(b)))).toBe('rules');
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

  it('answers "already stored" only for a write that is in the log byte for byte', async () => {
    const b = await Budget.create();
    const id = randomBytes(16);
    const time = b.time + 1000;
    const w = await build(b, [
      () => edit(b),
      () => edit(b, { entryId: id, part: 1, parts: 2, time }),
      () => edit(b, { entryId: id, part: 2, parts: 2, time }),
    ]);
    const log = new Map<string, Uint8Array[]>();
    const stored = (x: Uint8Array) => Promise.resolve(log.get(toHex(x)) ?? null);
    log.set(toHex(w[0]!.header.entryId), [w[0]!.hash]);
    log.set(toHex(id), [w[1]!.hash, w[2]!.hash]);
    expect(await checkWrite(b.state, w, ctx(b, { stored }))).toBe('already stored');

    // Some of it stored and some not.
    log.delete(toHex(id));
    const half = await refusedAs(checkWrite(b.state, w, ctx(b, { stored })));
    expect(half.why).toBe('partly stored');
    expect(half.retry).toBe(true);

    // The id is in the log with other content, or with another number of parts: not the same change.
    log.set(toHex(id), [w[1]!.hash, randomBytes(32)]);
    expect(await refused(checkWrite(b.state, w, ctx(b, { stored })))).toBe('entry id');
    log.set(toHex(id), [w[1]!.hash]);
    expect(await refused(checkWrite(b.state, w, ctx(b, { stored })))).toBe('entry id');
    // An entry that is nothing like the stored one, under a stored id.
    const junk = { ...w[0]!, signature: new Uint8Array(64) as never, hash: randomBytes(32) };
    expect(await refused(checkWrite(b.state, [junk], ctx(b, { stored })))).toBe('entry id');
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
        receiptHashes: (from, to) =>
          Promise.resolve(from >= 1 && from <= to && to <= 3 ? hashes.slice(from - 1, to) : null),
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
    drop(b, w);

    // Two filings, one after the other: the second starts at run 2.
    w = await build(b, [() => file(1, [receipts[0]!])]);
    expect((await store(b, w, waiting())).filedThrough).toBe(1);
    w = await build(b, [() => file(3, [receipts[0]!, receipts[1]!])]);
    expect(await refused(checkWrite(b.state, w, waiting()))).toBe('receipts');
    drop(b, w);
    w = await build(b, [() => file(3, [receipts[1]!, receipts[2]!])]);
    expect((await store(b, w, waiting())).filedThrough).toBe(3);
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
    const k = await b.keyChangeEntry([b.passkey.slotId, b.recovery.slotId, laptop.slotId], { lastOldRun: 5 });
    b.entries.push(k.entry);
    const s = await store(b, [k.entry], held());
    expect(s.public.keyVersion).toBe(2);
  });

  it('rests scans, data migrations and every part of a part set at the limit', async () => {
    const b = await Budget.create();
    const sealed = (kind: Kind, over: Partial<EntryFields> = {}) =>
      sealedEntry(b.fields(kind, PHONE, over), utf8('x'), b.keys);
    for (const kind of [KIND.scan, KIND.dataMigration]) {
      const w = await build(b, [() => sealed(kind)]);
      expect(await refused(checkWrite(b.state, w, ctx(b, { resting: true })))).toBe('limit');
      await store(b, w, ctx(b));
    }
    const id = randomBytes(16);
    const time = b.time + 1000;
    const w = await build(b, [
      () => sealed(KIND.edit, { entryId: id, part: 1, parts: 2, time }),
      () => sealed(KIND.edit, { entryId: id, part: 2, parts: 2, time }),
    ]);
    expect(await refused(checkWrite(b.state, w, ctx(b, { resting: true })))).toBe('limit');
    expect(await refused(checkWrite(b.state, w, ctx(b, { lastCompleteRun: 1 })))).toBe('bank runs first');
  });

  it('gives the kinds no limit holds back a small limit of their own', async () => {
    const b = await Budget.create();
    const signOut =
      (text = 'out') =>
      () =>
        sealedEntry(b.fields(KIND.signOut, PHONE), utf8(text), b.keys);
    // At most 4 in a write.
    let w = await build(
      b,
      Array.from({ length: MAX_KEY_ENTRIES_PER_WRITE + 1 }, () => signOut()),
    );
    const over = await refusedAs(checkWrite(b.state, w, ctx(b)));
    expect(over.why).toBe('limit');
    expect(over.retry).toBe(true);
    // And only as many as the budget has left today, resting or not.
    expect(await refused(checkWrite(b.state, w.slice(0, 2), ctx(b, { keyEntriesLeft: 1 })))).toBe('limit');
    await store(b, w.slice(0, 2), ctx(b, { keyEntriesLeft: 2, resting: true }));
    b.entries.length -= 3;
    b.undo();
    // A sign-out carries nothing: a body past the smallest step is refused.
    w = await build(b, [signOut('x'.repeat(300))]);
    expect(w[0]!.body.length).toBeGreaterThan(SIGN_OUT_BODY_LEN);
    expect(await refused(checkWrite(b.state, w, ctx(b)))).toBe('too large');
  });

  it('takes at most 16 entries in a write', async () => {
    const b = await Budget.create();
    const w = await build(
      b,
      Array.from({ length: MAX_WRITE_ENTRIES + 1 }, () => () => edit(b)),
    );
    expect(await refused(checkWrite(b.state, w, ctx(b)))).toBe('too many entries');
    expect((await store(b, w.slice(0, MAX_WRITE_ENTRIES), ctx(b))).number).toBe(MAX_WRITE_ENTRIES + 1);
  });

  it('refuses a schema or processing version newer than the released app, which would stop every device', async () => {
    const b = await Budget.create();
    for (const over of [{ schemaVersion: 2 }, { schemaVersion: 0xffffffff }, { processingVersion: 2 }]) {
      const w = await build(b, [() => edit(b, over)]);
      expect(await refused(checkWrite(b.state, w, ctx(b)))).toBe('version');
      drop(b, w);
    }
    const w = await build(b, [() => edit(b, { schemaVersion: 2, processingVersion: 3 })]);
    await store(b, w, ctx(b, { schemaVersion: 2, processingVersion: 3 }));
  });

  it('keeps the scan date to tomorrow by its own clock', async () => {
    const b = await Budget.create();
    const scan = (day: number) => () =>
      sealedEntry(b.fields(KIND.scan, PHONE, { scanThrough: day }), utf8('x'), b.keys);
    const tomorrow = Math.floor(b.time / 86_400_000) + 1;
    let w = await build(b, [scan(tomorrow + 1)]);
    expect(await refused(checkWrite(b.state, w, ctx(b)))).toBe('clock');
    drop(b, w);
    w = await build(b, [scan(tomorrow)]);
    await store(b, w, ctx(b));
  });

  it('a key change names the last complete run exactly', async () => {
    const b = await Budget.create();
    const keep = [b.passkey.slotId, b.recovery.slotId];
    // A run is complete and not filed. Leaving it out would end bank filing, and with it every edit, for good.
    let k = await b.keyChangeEntry(keep);
    const low = await refusedAs(checkWrite(b.state, [k.entry], ctx(b, { lastCompleteRun: 1 })));
    expect(low.why).toBe('last old run');
    expect(low.retry).toBe(true);
    b.undo();
    // A number no run has: the replaced inbox key would never retire, and 15 of those end key changes.
    k = await b.keyChangeEntry(keep, { lastOldRun: Number.MAX_SAFE_INTEGER });
    expect(await refused(checkWrite(b.state, [k.entry], ctx(b, { lastCompleteRun: 1 })))).toBe(
      'last old run',
    );
    b.undo();
    k = await b.keyChangeEntry(keep, { lastOldRun: 1 });
    const s = await checkWrite(b.state, [k.entry], ctx(b, { lastCompleteRun: 1 }));
    expect(s).not.toBe('already stored');
    expect([...(s as ChainState).public.retiredAt]).toEqual([[1, 1]]);
  });

  it('asks a fresh way in for an intent that has waited before any key change', async () => {
    const b = await Budget.create();
    const fresh = (over: Partial<AppendContext> = {}) => ctx(b, { freshWay: true, ...over });
    const keep = [b.recovery.slotId];

    // No intent: refused for a fresh way in.
    let k = await b.keyChangeEntry(keep);
    expect(await refused(checkWrite(b.state, [k.entry], fresh()))).toBe('intent needed');
    b.undo();

    // Also when it seems to remove nothing. It keeps both slot ids and anchors, but the passkey's sealed record is
    // noise: the passkey is locked out at once, and the server can't see that.
    const body = await b.keyChangeBody([b.passkey.slotId, b.recovery.slotId]);
    const slots = body.change.slots.map((r) =>
      r.slotId === b.passkey.slotId ? { ...r, sealedKey: randomBytes(80), wrappedPub: randomBytes(60) } : r,
    );
    const lockOut = await publicEntry(
      b.fields(KIND.keyChange, PHONE),
      encodeKeyChange({ ...body.change, slots }),
      b.keys,
    );
    expect(await refused(checkWrite(b.state, [lockOut], fresh()))).toBe('intent needed');
    b.undo();

    // An intent and its use in one write: the wait is judged by the rules of the log.
    let w = await build(b, [() => b.intent(b.time + 1000, [b.passkey.slotId])]);
    const early = { number: w[0]!.header.number, hash: w[0]!.hash };
    k = await b.keyChangeEntry(keep, { intent: early });
    expect(await refused(checkWrite(b.state, [w[0]!, k.entry], fresh()))).toBe('rules');
    drop(b, w);

    // With an intent, 7 days later.
    const wait = INTENT_WAIT_MS;
    const intent = await b.intent(b.time + 1000 + wait, [b.passkey.slotId]);
    b.entries.push(intent);
    await store(b, [intent], fresh());
    const named = { number: intent.header.number, hash: intent.hash };
    const later = b.time + wait;
    b.time = later;
    k = await b.keyChangeEntry(keep, { intent: named });
    // The server's clock has not reached the intent's date, though the entry's own time has.
    const notDue = await refusedAs(checkWrite(b.state, [k.entry], fresh({ now: b.time - 2000 })));
    expect(notDue.why).toBe('intent not due');
    expect(notDue.retry).toBe(true);
    b.undo();
    b.time = later;

    // A cancel, then the use: the intent is gone.
    w = await build(b, [
      () =>
        publicEntry(
          b.fields(KIND.cancel, LAPTOP),
          encodeCancel({ prevPublic: b.lastPublic, intent: named }),
          b.keys,
        ),
    ]);
    const prevPublic = { number: w[0]!.header.number, hash: w[0]!.hash };
    k = await b.keyChangeEntry(keep, { intent: named, prevPublic });
    expect(await refused(checkWrite(b.state, [w[0]!, k.entry], fresh()))).toBe('rules');
    drop(b, w);
    b.time = later;

    k = await b.keyChangeEntry(keep, { intent: named });
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

describe('where a snapshot may stand', () => {
  it('is at an entry of the log that ends a change, and nowhere else', async () => {
    const b = await Budget.create();
    const id = randomBytes(16);
    const time = b.time + 1000;
    const w = await build(b, [
      () => edit(b),
      () => edit(b, { entryId: id, part: 1, parts: 2, time }),
      () => edit(b, { entryId: id, part: 2, parts: 2, time }),
    ]);
    const header = (
      e: Entry,
      over: Partial<{ number: number; entryHash: Uint8Array; budgetId: string }> = {},
    ) =>
      encodeSnapshotHeader({
        budgetId: BUDGET,
        snapshotId: '01CX5ZZKBKACTAV9WEVGEMMVRZ',
        version: 1,
        number: e.header.number,
        entryHash: e.hash,
        lastPublic: { number: 1, hash: b.entries[0]!.hash },
        manifestHash: randomBytes(32),
        ...over,
      } as never);
    expect(snapshotStandsAt(header(w[0]!), w[0]!)).toBe(true);
    expect(snapshotStandsAt(header(w[2]!), w[2]!)).toBe(true);
    expect(snapshotStandsAt(header(w[1]!), w[1]!)).toBe(false);
    expect(snapshotStandsAt(header(w[0]!), w[2]!)).toBe(false);
    expect(snapshotStandsAt(header(w[0]!, { entryHash: randomBytes(32) }), w[0]!)).toBe(false);
    expect(snapshotStandsAt(header(w[0]!, { budgetId: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }), w[0]!)).toBe(false);
    expect(snapshotStandsAt(randomBytes(40), w[0]!)).toBe(false);
  });
});
