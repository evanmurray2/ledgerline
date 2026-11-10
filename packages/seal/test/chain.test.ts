// Log entries and the chain a device checks (docs/privacy-keys.md sections 4.4, 6 and 7): a small budget is written
// entry by entry the way a device would, then read back, changed, cut, reordered and forged.
import { describe, expect, it } from 'vitest';
import {
  advance,
  type BudgetKeys,
  type Bytes,
  ChainError,
  type ChainState,
  concat,
  deriveBudgetKeys,
  encodeCancel,
  encodeEntry,
  encodeGenesis,
  encodeHeader,
  encodeIntent,
  encodeKeyChange,
  encodeSlotChange,
  type Entry,
  type EntryFields,
  equal,
  FormatError,
  INTENT_WAIT_MS,
  isWhole,
  type KeyChange,
  KIND,
  type Kind,
  newInbox,
  newSlotRecord,
  olderKeys,
  openBudget,
  openEntryBody,
  passkeySlot,
  publicEntry,
  randomBytes,
  readEntry,
  readHeader,
  recoverySlot,
  resealSlotRecord,
  rewrapInbox,
  sealedEntry,
  type SlotSecrets,
  startChain,
  toHex,
  u8,
  utf8,
  verifyEntry,
  walkPublic,
  wrapPrevKey,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PHONE = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const T0 = 1_800_000_000_000;

/** A budget being written: its keys, its log, and where the chain stands. */
class Budget {
  bk!: Bytes;
  keys!: BudgetKeys;
  entries: Entry[] = [];
  state!: ChainState;
  counters = new Map<string, number>();
  time = T0;
  passkey!: SlotSecrets;
  recovery!: SlotSecrets;

  static async create(): Promise<Budget> {
    const b = new Budget();
    b.bk = randomBytes(32);
    b.keys = await deriveBudgetKeys(b.bk, BUDGET, 1);
    b.passkey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(16));
    b.recovery = await recoverySlot(randomBytes(32), 1);
    const inbox = await newInbox(b.keys, BUDGET, 1);
    const body = encodeGenesis({
      signPub: b.keys.sign.pub,
      inboxPub: inbox.pair.pub,
      wrappedInbox: inbox.wrapped,
      slots: [
        await newSlotRecord(b.passkey, b.bk, b.keys, BUDGET, b.keys.sign.pub),
        await newSlotRecord(b.recovery, b.bk, b.keys, BUDGET, b.keys.sign.pub),
      ],
    });
    const e = await publicEntry(b.fields(KIND.genesis, PHONE), body, b.keys);
    b.entries.push(e);
    b.state = await startChain(e);
    return b;
  }

  /** The header fields of the next entry from `device`. */
  fields(kind: Kind, device: string, over: Partial<EntryFields> = {}): EntryFields {
    const counter = (this.counters.get(device) ?? 0) + 1;
    this.counters.set(device, counter);
    this.time += 1000;
    const prev = this.entries.at(-1);
    return {
      kind,
      budgetId: BUDGET,
      number: (prev?.header.number ?? 0) + 1,
      prevHash: prev?.hash ?? (new Uint8Array(32) as Bytes),
      entryId: randomBytes(16),
      time: this.time,
      deviceId: device,
      deviceCounter: counter,
      keyVersion: this.keys?.version ?? 1,
      schemaVersion: 1,
      processingVersion: 1,
      part: 1,
      parts: 1,
      filedThrough: prev?.header.filedThrough ?? 0,
      receipts: [],
      scanThrough: prev?.header.scanThrough ?? 0,
      ...over,
    };
  }

  async take(e: Entry): Promise<Entry> {
    this.state = await advance(this.state, e);
    this.entries.push(e);
    return e;
  }

  edit(device = PHONE, text = 'an edit'): Promise<Entry> {
    return sealedEntry(this.fields(KIND.edit, device), utf8(text), this.keys).then((e) => this.take(e));
  }

  get lastPublic() {
    return this.state.public.lastPublic;
  }

  /** A key change that keeps the slots in `keep` (by id). */
  async keyChange(
    keep: string[],
    over: { intent?: { number: number; hash: Bytes } | null } = {},
  ): Promise<Entry> {
    const p = this.state.public;
    const newBk = randomBytes(32);
    const newKeys = await deriveBudgetKeys(newBk, BUDGET, this.keys.version + 1);
    const inbox = await newInbox(newKeys, BUDGET, p.inboxVersion + 1);
    const inboxes = [{ version: p.inboxVersion + 1, wrapped: inbox.wrapped }];
    for (const [v, w] of p.inboxes)
      inboxes.push({ version: v, wrapped: await rewrapInbox(this.keys, newKeys, BUDGET, v, w) });
    const slots = await Promise.all(
      keep.map((id) => resealSlotRecord(p.slots.get(id)!, this.keys, newBk, newKeys, BUDGET)),
    );
    const body = encodeKeyChange({
      prevPublic: this.lastPublic,
      version: newKeys.version,
      signPub: newKeys.sign.pub,
      wrappedPrevKey: await wrapPrevKey(this.keys, newKeys, BUDGET, this.bk),
      inboxVersion: p.inboxVersion + 1,
      inboxPub: inbox.pair.pub,
      lastOldRun: this.state.filedThrough,
      inboxes,
      slots,
      intent: over.intent ?? null,
    });
    const e = await this.take(await publicEntry(this.fields(KIND.keyChange, PHONE), body, this.keys));
    this.bk = newBk;
    this.keys = newKeys;
    return e;
  }
}

const bad = async (p: Promise<unknown>, why: string) => {
  await expect(p).rejects.toThrow(ChainError);
  await expect(p).rejects.toThrow(why);
};

describe('an entry', () => {
  it('is written and read exactly, and its body opens only with its key and its header', async () => {
    const b = await Budget.create();
    const e = await b.edit(PHONE, 'groceries');
    const back = await readEntry(encodeEntry(e));
    expect(toHex(back.hash)).toBe(toHex(e.hash));
    expect(back.header).toEqual(e.header);
    expect(toHex(encodeEntry(back))).toBe(toHex(encodeEntry(e)));
    expect(await verifyEntry(back, b.keys.sign.pub)).toBe(true);
    expect(equal(await openEntryBody(back, b.keys), utf8('groceries'))).toBe(true);
    // A 9-byte body is sealed at the smallest step: 12 + 256 + 16 bytes.
    expect(e.body.length).toBe(284);

    // The body is bound to its header: the same sealed bytes under another number don't open.
    const moved = { ...e, header: { ...e.header, number: e.header.number + 1, prevHash: e.hash } };
    await expect(openEntryBody(moved, b.keys)).rejects.toThrow();
    await expect(openEntryBody(e, await deriveBudgetKeys(randomBytes(32), BUDGET, 1))).rejects.toThrow();
    // A changed body no longer matches the header, and a changed header no longer matches the signature.
    const bytes = encodeEntry(e);
    const flipped = bytes.slice();
    flipped[bytes.length - 100]! ^= 1;
    await expect(readEntry(flipped)).rejects.toThrow(FormatError);
    const other = await readEntry(encodeEntry({ ...e, header: { ...e.header, time: e.header.time + 1 } }));
    expect(await verifyEntry(other, b.keys.sign.pub)).toBe(false);
    await expect(readEntry(concat(bytes, u8(0)))).rejects.toThrow(FormatError);
  });

  it('a header that breaks the format is refused by writers and readers', async () => {
    const b = await Budget.create();
    const e = await b.edit();
    const h = e.header;
    const broken: Partial<typeof h>[] = [
      { kind: 7 as Kind },
      { kind: KIND.genesis },
      { number: 0 },
      { number: 1 },
      { budgetId: 'nope' },
      { deviceId: 'nope' },
      { deviceCounter: 0 },
      { keyVersion: 0 },
      { part: 0 },
      { part: 2, parts: 1 },
      { receipts: [randomBytes(32)] },
      { prevHash: new Uint8Array(32) as Bytes },
      { entryId: randomBytes(15) },
    ];
    for (const change of broken)
      expect(() => encodeHeader({ ...h, ...change }), JSON.stringify(change)).toThrow();
    expect(() => readHeader(encodeHeader(h).subarray(1))).toThrow(FormatError);
    expect(readHeader(encodeHeader(h))).toEqual(h);
    // A public kind is never split, and a sealed kind takes no public body.
    await expect(publicEntry(b.fields(KIND.edit, PHONE), utf8('x'), b.keys)).rejects.toThrow(RangeError);
    await expect(sealedEntry(b.fields(KIND.slotChange, PHONE), utf8('x'), b.keys)).rejects.toThrow(
      RangeError,
    );
    await expect(sealedEntry(b.fields(KIND.edit, PHONE), randomBytes(65536), b.keys)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('the chain a device checks', () => {
  it('takes entries in order from two devices', async () => {
    const b = await Budget.create();
    await b.edit(PHONE);
    await b.edit(LAPTOP);
    await b.edit(PHONE);
    expect(b.state.number).toBe(4);
    expect([b.state.counters.get(PHONE), b.state.counters.get(LAPTOP)]).toEqual([3, 1]);
    expect(isWhole(b.state)).toBe(true);
  });

  it('refuses an entry that is not the next one, in any way', async () => {
    const b = await Budget.create();
    const first = await b.edit();
    const make = (over: Partial<EntryFields>) =>
      sealedEntry({ ...b.fields(KIND.edit, PHONE), ...over }, utf8('x'), b.keys);
    // The same entry again, a gap, and the wrong previous hash.
    await bad(advance(b.state, first), 'not the next entry');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ number: 4 })), 'not the next entry');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ prevHash: randomBytes(32) })), 'not the next entry');
    // Another budget, a key version not in force, time running backwards, a counter that skips or repeats.
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ budgetId: '01DX5ZZKBKACTAV9WEVGEMMVRZ' })), 'another budget');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ time: first.header.time - 1 })), 'time runs backwards');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ deviceCounter: 4 })), 'device counter');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await make({ deviceCounter: 2 })), 'device counter');
    // A device never seen starts at 1.
    await bad(advance(b.state, await make({ deviceId: LAPTOP, deviceCounter: 5 })), 'device counter');
    // The scan date never goes down.
    b.counters.set(PHONE, 2);
    const scanned = await b.take(
      await sealedEntry(b.fields(KIND.scan, PHONE, { scanThrough: 20500 }), utf8('scan'), b.keys),
    );
    expect(scanned.header.scanThrough).toBe(20500);
    await bad(advance(b.state, await make({ scanThrough: 20499 })), 'scan date goes down');
  });

  it('refuses a signature from another key', async () => {
    const b = await Budget.create();
    const stranger = await deriveBudgetKeys(randomBytes(32), BUDGET, 1);
    const e = await sealedEntry(b.fields(KIND.edit, PHONE), utf8('x'), stranger);
    await bad(advance(b.state, e), 'signature');
  });

  it('only a bank entry files runs, the next ones, with one receipt each', async () => {
    const b = await Budget.create();
    const bank = (filedThrough: number, receipts: number, kind: Kind = KIND.bank) =>
      sealedEntry(
        b.fields(kind, PHONE, {
          filedThrough,
          receipts: Array.from({ length: receipts }, () => randomBytes(32)),
        }),
        utf8('bank rows'),
        b.keys,
      );
    const ok = await b.take(await bank(3, 3));
    expect(ok.header.filedThrough).toBe(3);
    const retry = () => b.counters.set(PHONE, b.state.counters.get(PHONE)!);
    await bad(advance(b.state, await bank(5, 1)), 'filed runs');
    retry();
    await bad(advance(b.state, await bank(3, 0)), 'filed runs');
    retry();
    await bad(advance(b.state, await bank(2, 0, KIND.edit)), 'filed runs');
    retry();
    await bad(advance(b.state, await bank(4, 0, KIND.edit)), 'filed runs');
  });

  it('a part set arrives whole: same writer, same time, receipts in part 1, nothing in between', async () => {
    const b = await Budget.create();
    const id = randomBytes(16);
    const t = b.time + 1000;
    const part = (n: number, over: Partial<EntryFields> = {}) =>
      sealedEntry(
        b.fields(KIND.bank, PHONE, {
          entryId: id,
          time: t,
          part: n,
          parts: 3,
          filedThrough: 2,
          receipts: n === 1 ? [randomBytes(32), randomBytes(32)] : [],
          ...over,
        }),
        utf8(`part ${n}`),
        b.keys,
      );
    await b.take(await part(1));
    expect(isWhole(b.state)).toBe(false);
    // Another device's entry can't land inside the set, and the set can't change shape.
    const intruder = await sealedEntry(b.fields(KIND.edit, LAPTOP, { filedThrough: 2 }), utf8('x'), b.keys);
    await bad(advance(b.state, intruder), 'part set broken');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await part(3)), 'part set broken');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await part(2, { entryId: randomBytes(16) })), 'part set broken');
    b.counters.set(PHONE, 2);
    await bad(advance(b.state, await part(2, { time: t + 1 })), 'part set broken');
    b.counters.set(PHONE, 2);
    await b.take(await part(2));
    await b.take(await part(3));
    expect(isWhole(b.state)).toBe(true);
    expect(b.state.filedThrough).toBe(2);
    // A set starts at part 1.
    await bad(
      advance(b.state, await part(2, { entryId: randomBytes(16), time: t + 5000, filedThrough: 2 })),
      'part 1',
    );
  });
});

describe('public entries', () => {
  it('a new way in is added by a slot change, and can then open the budget', async () => {
    const b = await Budget.create();
    await b.edit();
    const laptopKey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(20));
    const record = await newSlotRecord(laptopKey, b.bk, b.keys, BUDGET, b.state.public.genesisSignPub);
    const body = encodeSlotChange({ prevPublic: b.lastPublic, slots: [record] });
    await b.take(await publicEntry(b.fields(KIND.slotChange, LAPTOP), body, b.keys));
    expect(b.state.public.slots.size).toBe(3);
    expect(toHex((await openBudget(b.state.public, laptopKey)).bk)).toBe(toHex(b.bk));
    // The same slot can't be added twice, and it must name the public entry before it.
    const again = encodeSlotChange({ prevPublic: b.lastPublic, slots: [record] });
    await bad(
      advance(b.state, await publicEntry(b.fields(KIND.slotChange, LAPTOP), again, b.keys)),
      'already there',
    );
    b.counters.set(LAPTOP, 1);
    const stale = encodeSlotChange({ prevPublic: { number: 1, hash: b.entries[0]!.hash }, slots: [record] });
    await bad(
      advance(b.state, await publicEntry(b.fields(KIND.slotChange, LAPTOP), stale, b.keys)),
      'previous public entry',
    );
  });

  it('a key change puts a new key in force, for every way in that stays', async () => {
    const b = await Budget.create();
    await b.edit();
    const before = { bk: b.bk, keys: b.keys };
    const old = await b.edit(PHONE, 'sealed under version 1');
    await b.keyChange([b.passkey.slotId, b.recovery.slotId]);
    expect(b.state.public.keyVersion).toBe(2);
    const after = await b.edit(PHONE, 'sealed under version 2');
    expect(after.header.keyVersion).toBe(2);
    // Both ways in open the new key.
    for (const who of [b.passkey, b.recovery])
      expect(toHex((await openBudget(b.state.public, who)).bk)).toBe(toHex(b.bk));
    // An entry under the old version is refused now, though its signature is real.
    const late = await sealedEntry(
      { ...b.fields(KIND.edit, PHONE), keyVersion: 1 },
      utf8('late'),
      before.keys,
    );
    await bad(advance(b.state, late), 'key version not in force');
    // A device that holds only the new key walks back to read what was sealed before.
    const opened = await openBudget(b.state.public, b.recovery);
    const v1 = await olderKeys(b.state.public, opened, 1);
    expect(toHex(v1.bk)).toBe(toHex(before.bk));
    expect(equal(await openEntryBody(old, v1.keys), utf8('sealed under version 1'))).toBe(true);
    expect((await olderKeys(b.state.public, opened, 2)).keys.version).toBe(2);
  });

  it('a key change removes a way in, and that way in no longer opens the budget', async () => {
    const b = await Budget.create();
    await b.keyChange([b.passkey.slotId]);
    expect([...b.state.public.slots.keys()]).toEqual([b.passkey.slotId]);
    await expect(openBudget(b.state.public, b.recovery)).rejects.toThrow('removed');
    expect(toHex((await openBudget(b.state.public, b.passkey)).bk)).toBe(toHex(b.bk));
  });

  it('a key change adds no way in, steps the versions by one, and keeps each anchor', async () => {
    const b = await Budget.create();
    const p = b.state.public;
    const newBk = randomBytes(32);
    const newKeys = await deriveBudgetKeys(newBk, BUDGET, 2);
    const inbox = await newInbox(newKeys, BUDGET, 2);
    const kept = await resealSlotRecord(p.slots.get(b.passkey.slotId)!, b.keys, newBk, newKeys, BUDGET);
    const base: KeyChange = {
      prevPublic: b.lastPublic,
      version: 2,
      signPub: newKeys.sign.pub,
      wrappedPrevKey: await wrapPrevKey(b.keys, newKeys, BUDGET, b.bk),
      inboxVersion: 2,
      inboxPub: inbox.pair.pub,
      lastOldRun: 0,
      inboxes: [{ version: 2, wrapped: inbox.wrapped }],
      slots: [kept],
      intent: null,
    };
    const tryIt = async (over: Partial<KeyChange>, why: string) => {
      const e = await publicEntry(
        b.fields(KIND.keyChange, PHONE),
        encodeKeyChange({ ...base, ...over }),
        b.keys,
      );
      b.counters.set(PHONE, 1);
      b.time -= 1000;
      await bad(advance(b.state, e), why);
    };
    await tryIt({ version: 3 }, 'key version must step by 1');
    await tryIt({ inboxVersion: 3, inboxes: [{ version: 3, wrapped: inbox.wrapped }] }, 'inbox version');
    await tryIt({ inboxes: [{ version: 1, wrapped: inbox.wrapped }] }, 'new inbox key is missing');
    await tryIt(
      {
        inboxes: [
          { version: 2, wrapped: inbox.wrapped },
          { version: 2, wrapped: inbox.wrapped },
        ],
      },
      'inbox twice',
    );
    await tryIt({ inboxes: [base.inboxes[0]!, { version: 9, wrapped: inbox.wrapped }] }, 'unknown inbox');
    const stranger = await passkeySlot(randomBytes(32), BUDGET, randomBytes(16));
    const added = await newSlotRecord(stranger, newBk, newKeys, BUDGET, p.genesisSignPub);
    await tryIt({ slots: [kept, added] }, 'adds no slot');
    await tryIt({ slots: [{ ...kept, anchor: randomBytes(32) }] }, 'anchor changed');
    await tryIt({ prevPublic: { number: 9, hash: randomBytes(32) } }, 'previous public entry');
    await tryIt({ intent: { number: 5, hash: randomBytes(32) } }, 'unknown intent');
  });

  it('an intent to remove a way in waits 7 days, can be cancelled, and is used once', async () => {
    const b = await Budget.create();
    const intent = (notBefore: number, slotIds = [b.recovery.slotId]) =>
      publicEntry(
        b.fields(KIND.intent, PHONE),
        encodeIntent({ prevPublic: b.lastPublic, notBefore, slotIds }),
        b.keys,
      );
    const redo = () => {
      b.counters.set(PHONE, b.state.counters.get(PHONE)!);
      b.time -= 1000;
    };
    // Too short a wait, and a slot that isn't there.
    await bad(advance(b.state, await intent(b.time + 1000 + INTENT_WAIT_MS - 1)), 'wait too short');
    redo();
    await bad(advance(b.state, await intent(b.time + 1000 + INTENT_WAIT_MS, ['r:9'])), 'unknown slot');
    redo();
    const first = await b.take(await intent(b.time + 1000 + INTENT_WAIT_MS));
    const ref = { number: first.header.number, hash: first.hash };

    // The key change can't come before the wait is over, and must remove exactly the slots the intent names.
    const state = b.state;
    await bad(b.keyChange([b.passkey.slotId], { intent: ref }), 'not yet due');
    redo();
    b.time += INTENT_WAIT_MS;
    await bad(b.keyChange([b.passkey.slotId, b.recovery.slotId], { intent: ref }), 'names other slots');
    redo();
    expect(b.state).toBe(state);

    // Any holder of the key can cancel it; a cancelled intent can't be used or cancelled again.
    const cancel = () =>
      publicEntry(
        b.fields(KIND.cancel, LAPTOP),
        encodeCancel({ prevPublic: b.lastPublic, intent: ref }),
        b.keys,
      );
    await b.take(await cancel());
    await bad(b.keyChange([b.passkey.slotId], { intent: ref }), 'cancelled or used');
    redo();
    await bad(advance(b.state, await cancel()), 'cancelled or used');
    b.counters.set(LAPTOP, 1);
    b.time -= 1000;

    // A second intent, carried out when it is due.
    const second = await b.take(await intent(b.time + 1000 + INTENT_WAIT_MS));
    b.time += INTENT_WAIT_MS;
    await b.keyChange([b.passkey.slotId], { intent: { number: second.header.number, hash: second.hash } });
    expect(b.state.public.keyVersion).toBe(2);
    expect(b.state.public.slots.has(b.recovery.slotId)).toBe(false);
  });
});

describe('a device that holds nothing yet', () => {
  async function story() {
    const b = await Budget.create();
    await b.edit();
    const laptopKey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(20));
    const record = await newSlotRecord(laptopKey, b.bk, b.keys, BUDGET, b.state.public.genesisSignPub);
    await b.take(
      await publicEntry(
        b.fields(KIND.slotChange, LAPTOP),
        encodeSlotChange({ prevPublic: b.lastPublic, slots: [record] }),
        b.keys,
      ),
    );
    await b.edit(LAPTOP);
    await b.keyChange([b.passkey.slotId, b.recovery.slotId, laptopKey.slotId]);
    await b.edit();
    await b.keyChange([b.recovery.slotId, laptopKey.slotId]);
    await b.edit(LAPTOP);
    const publics = b.entries.filter((e) => [0, 4, 5, 9, 10].includes(e.header.kind));
    return { b, laptopKey, publics };
  }

  it('walks the public entries alone and reaches the same state as the whole log', async () => {
    const { b, laptopKey, publics } = await story();
    expect(publics.length).toBe(4);
    const p = await walkPublic(publics);
    expect(p.keyVersion).toBe(3);
    expect(toHex(p.signPub)).toBe(toHex(b.state.public.signPub));
    expect(p.lastPublic).toEqual(b.state.public.lastPublic);
    expect([...p.slots.keys()].sort()).toEqual([b.recovery.slotId, laptopKey.slotId].sort());
    // The recovery key, typed on a new device, opens the key in force and walks back to the first.
    const opened = await openBudget(p, b.recovery);
    expect(toHex(opened.bk)).toBe(toHex(b.bk));
    expect((await olderKeys(p, opened, 1)).keys.version).toBe(1);
    // The passkey that was removed gets nothing.
    await expect(openBudget(p, b.passkey)).rejects.toThrow('removed');
  });

  it('catches a public entry left out, reordered or cut off the front', async () => {
    const { publics } = await story();
    const [g, slot, k2, k3] = publics as [Entry, Entry, Entry, Entry];
    await bad(walkPublic([g, k2, k3]), 'previous public entry');
    await bad(walkPublic([g, slot, k3]), 'key version not in force');
    await bad(walkPublic([g, k2, slot, k3]), 'previous public entry');
    await bad(walkPublic([slot, k2, k3]), 'not a genesis entry');
    await bad(walkPublic([]), 'no genesis entry');
    // Cut off the end, the walk can't tell by itself: the newest snapshot's header names the last public entry
    // (section 8), which is checked there.
    expect((await walkPublic([g, slot, k2])).keyVersion).toBe(2);
  });

  it('a budget of the server’s own making is refused by the slot’s anchor', async () => {
    const real = await Budget.create();
    // The server makes its own budget with the same id, and seals its key to a slot with the victim's slot id.
    const fake = await Budget.create();
    const fakeGenesis = fake.entries[0]!;
    const p = await walkPublic([fakeGenesis]);
    // The victim's passkey isn't a slot of that budget at all...
    await expect(openBudget(p, real.passkey)).rejects.toThrow();
    // ...and if the server copies the victim's slot id onto a record of its own, the anchor fails.
    const record = { ...[...p.slots.values()][0]!, slotId: real.passkey.slotId };
    const forged = { ...p, slots: new Map([[real.passkey.slotId, record]]) };
    await expect(openBudget(forged, real.passkey)).rejects.toMatchObject({ why: 'anchor' });
  });
});
