// Log entries and the rules of the log (docs/privacy-keys.md sections 4.4, 6 and 7): a small budget is written entry
// by entry the way a device would, then read back, changed, cut, reordered and forged.
import { describe, expect, it } from 'vitest';
import {
  advance,
  type Bytes,
  ChainError,
  concat,
  deriveBudgetKeys,
  encodeCancel,
  encodeEntry,
  encodeGenesis,
  encodeHeader,
  encodeKeyChange,
  encodeSlotChange,
  type Entry,
  type EntryFields,
  equal,
  FormatError,
  fromHex,
  INTENT_WAIT_MS,
  isWhole,
  type KeyChange,
  KIND,
  type Kind,
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
  sealedEntry,
  toHex,
  u8,
  UpdateNeededError,
  utf8,
  verifyEntry,
  walkPublic,
  wrapPrevKey,
} from '../src/index.js';

import { Budget, BUDGET, LAPTOP, PHONE, T0 } from './budget.js';

const ref = (e: Entry) => ({ number: e.header.number, hash: e.hash });

describe('an entry', () => {
  it('has exactly the bytes the formats give', async () => {
    const keys = await deriveBudgetKeys(fromHex('11'.repeat(32)), BUDGET, 1);
    const fields: EntryFields = {
      kind: KIND.bank,
      budgetId: BUDGET,
      number: 7,
      prevHash: fromHex('aa'.repeat(32)),
      entryId: fromHex('bb'.repeat(16)),
      time: T0,
      deviceId: PHONE,
      deviceCounter: 3,
      keyVersion: 1,
      schemaVersion: 2,
      processingVersion: 5,
      part: 1,
      parts: 1,
      filedThrough: 9,
      receipts: [fromHex('cc'.repeat(32)), fromHex('dd'.repeat(32))],
      scanThrough: 20000,
    };
    const e = await sealedEntry(fields, utf8('rows'), keys);
    // Header fields 1 to 16, written out by hand.
    const core =
      toHex(utf8('LLE1')) +
      '02' +
      '0000001a' +
      toHex(utf8(BUDGET)) +
      '0000000000000007' +
      'aa'.repeat(32) +
      'bb'.repeat(16) +
      T0.toString(16).padStart(16, '0') +
      '0000001a' +
      toHex(utf8(PHONE)) +
      '0000000000000003' +
      '00000001' +
      '00000002' +
      '00000005' +
      '0001' +
      '0001' +
      '0000000000000009' +
      '0002' +
      'cc'.repeat(32) +
      'dd'.repeat(32) +
      '00004e20';
    const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as Bytes));
    const header = core + toHex(await sha(e.body));
    expect(toHex(encodeHeader(e.header))).toBe(header);
    expect(toHex(e.hash)).toBe(toHex(await sha(fromHex(header))));
    // The signed message is label || 0x00 || entryHash.
    const message = concat(utf8('ledgerline/v1/entry'), u8(0), e.hash);
    const key = await crypto.subtle.importKey('raw', keys.sign.pub, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', key, e.signature, message)).toBe(true);
    // The body's associated data is label || 0x00 || H(fields 1 to 16); decrypted by hand, the plain text is padded.
    const aad = concat(utf8('ledgerline/v1/body'), u8(0), await sha(fromHex(core)));
    const logKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: concat(Uint8Array.of(0, 0, 0, 26), utf8(BUDGET), Uint8Array.of(0, 0, 0, 1)),
            info: concat(utf8('ledgerline/v1/log'), u8(0)),
          },
          await crypto.subtle.importKey('raw', fromHex('11'.repeat(32)), 'HKDF', false, ['deriveBits']),
          256,
        ),
      ),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: e.body.subarray(0, 12), additionalData: aad },
        logKey,
        e.body.subarray(12),
      ),
    );
    expect(plain.length).toBe(256);
    expect(toHex(plain.subarray(0, 5))).toBe(`${toHex(utf8('rows'))}80`);
    // As sent and stored: str(header) || str(body) || signature.
    const wire = toHex(encodeEntry(e));
    const len = (n: number) => n.toString(16).padStart(8, '0');
    expect(wire).toBe(
      len(header.length / 2) + header + len(e.body.length) + toHex(e.body) + toHex(e.signature),
    );
  });

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
    // A sealed body is exactly a padding step, a nonce and a tag: any other length is refused before any hashing.
    const short = { ...e, body: e.body.subarray(0, 283) as Bytes };
    await expect(readEntry(encodeEntry(short))).rejects.toThrow('sealed body length');
  });

  it('a header that breaks the format is refused by writers and by readers', async () => {
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
      { kind: KIND.signOut, part: 1, parts: 2 },
    ];
    for (const change of broken)
      expect(() => encodeHeader({ ...h, ...change }), JSON.stringify(change)).toThrow();
    expect(readHeader(encodeHeader(h))).toEqual(h);
    // Readers, on bytes built by hand: a cut header, an unknown kind, an entry number of 0, a sign-out in two parts.
    const good = encodeHeader(h);
    const at = (offset: number, ...bytes: number[]) => {
      const x = good.slice();
      x.set(bytes, offset);
      return x;
    };
    expect(() => readHeader(good.subarray(1))).toThrow(FormatError);
    expect(() => readHeader(good.subarray(0, good.length - 1))).toThrow(FormatError);
    expect(() => readHeader(at(4, 7))).toThrow(FormatError);
    expect(() => readHeader(at(4 + 1 + 30, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(FormatError);
    expect(() => readHeader(at(0, 0x4c, 0x4c, 0x45, 0x32))).toThrow(FormatError);
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

describe('the rules of the log', () => {
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
    const make = (over: Partial<EntryFields>, keys = b.keys) =>
      sealedEntry({ ...b.fields(KIND.edit, PHONE), ...over }, utf8('x'), keys);
    // The same entry again, a gap, and the wrong previous hash.
    await b.refuses(first, 'not the next entry');
    await b.refuses(make({ number: 4 }), 'not the next entry');
    await b.refuses(make({ prevHash: randomBytes(32) }), 'not the next entry');
    // Another budget; time that stands still or runs backwards; a counter that skips or repeats.
    await b.refuses(make({ budgetId: '01DX5ZZKBKACTAV9WEVGEMMVRZ' }), 'another budget');
    await b.refuses(make({ time: first.header.time }), 'time must move forward');
    await b.refuses(make({ time: first.header.time - 1 }), 'time must move forward');
    await b.refuses(make({ deviceCounter: 4 }), 'device counter');
    await b.refuses(make({ deviceCounter: 2 }), 'device counter');
    // A device never seen starts at 1.
    await b.refuses(make({ deviceId: LAPTOP, deviceCounter: 5 }), 'device counter');
    // The same entry id twice in a row.
    await b.refuses(make({ entryId: first.header.entryId }), 'entry id repeated');
    // A signature from another key.
    await b.refuses(make({}, await deriveBudgetKeys(randomBytes(32), BUDGET, 1)), 'signature');
  });

  it('refuses an entry dated after the checker’s clock, so one bad clock can’t end the log', async () => {
    const b = await Budget.create();
    const far = await sealedEntry(
      b.fields(KIND.edit, PHONE, { time: b.time + 11 * 60 * 1000 }),
      utf8('x'),
      b.keys,
    );
    await b.refuses(far, 'dated in the future');
    const huge = await sealedEntry(
      b.fields(KIND.edit, PHONE, { time: Number.MAX_SAFE_INTEGER }),
      utf8('x'),
      b.keys,
    );
    await b.refuses(huge, 'dated in the future');
    // Within the slack, it is taken.
    await b.take(
      await sealedEntry(b.fields(KIND.edit, PHONE, { time: b.time + 9 * 60 * 1000 }), utf8('x'), b.keys),
    );
  });

  it('an entry from a newer app asks for an update, and is not called a lie', async () => {
    const b = await Budget.create();
    const e = await sealedEntry(b.fields(KIND.edit, PHONE, { schemaVersion: 2 }), utf8('x'), b.keys);
    await expect(advance(b.state, e, { now: b.time, schemaVersion: 1 })).rejects.toThrow(UpdateNeededError);
    expect((await advance(b.state, e, { now: b.time, schemaVersion: 2 })).number).toBe(2);
  });

  it('an entry whose hash or body is not its own is refused, wherever it came from', async () => {
    const b = await Budget.create();
    const { entry } = await b.keyChangeEntry([b.passkey.slotId, b.recovery.slotId]);
    // A real key change with its body swapped for one that names the attacker's signing key.
    const attacker = await deriveBudgetKeys(randomBytes(32), BUDGET, 2);
    const { change } = await b.keyChangeBody([b.passkey.slotId, b.recovery.slotId]);
    const swapped = { ...entry, body: encodeKeyChange({ ...change, signPub: attacker.sign.pub }) };
    await b.refuses(swapped, 'body hash');
    // A real entry with its header changed and the old hash kept.
    const real = await sealedEntry(b.fields(KIND.edit, PHONE), utf8('x'), b.keys);
    await b.refuses({ ...real, header: { ...real.header, time: real.header.time + 5 } }, 'entry hash');
    // The same holds for the walk of a device with no key.
    const genesis = b.entries[0]!;
    const fake = { ...genesis, body: encodeGenesis({ ...(await genesisOf(b)), signPub: attacker.sign.pub }) };
    await expect(walkPublic([fake], BUDGET)).rejects.toThrow('body hash');
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
    await b.bank(3);
    expect(b.state.filedThrough).toBe(3);
    await b.refuses(bank(5, 1), 'filed runs');
    await b.refuses(bank(3, 0), 'filed runs');
    await b.refuses(bank(2, 0, KIND.edit), 'filed runs');
    await b.refuses(bank(4, 0, KIND.edit), 'filed runs');
    await b.refuses(bank(4, 0, KIND.scan), 'filed runs');
  });

  it('only a scan moves the scan date, forward, and not past tomorrow', async () => {
    const b = await Budget.create();
    const today = Math.floor(b.time / 86_400_000);
    const scan = (scanThrough: number, kind: Kind = KIND.scan) =>
      sealedEntry(b.fields(kind, PHONE, { scanThrough }), utf8('scan'), b.keys);
    await b.take(await scan(today));
    await b.refuses(scan(today - 1), 'scan date');
    await b.refuses(scan(today + 1, KIND.edit), 'scan date');
    await b.refuses(scan(4_000_000_000), 'scan date in the future');
    await b.refuses(scan(today + 3), 'scan date in the future');
    await b.take(await scan(today + 1));
    expect(b.state.scanThrough).toBe(today + 1);
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
    b.time = t;
    // Another device's entry can't land inside the set, and the set can't change shape.
    await b.refuses(
      sealedEntry(b.fields(KIND.edit, LAPTOP, { filedThrough: 2 }), utf8('x'), b.keys),
      'part set broken',
    );
    for (const over of [
      { part: 3 },
      { entryId: randomBytes(16) },
      { time: t + 1 },
      { kind: KIND.edit as Kind },
      { filedThrough: 3 },
      { scanThrough: 1 },
      { parts: 4 },
    ]) {
      await b.refuses(part(2, over), 'part set broken');
      b.time = t;
    }
    // Receipts in a later part: the header format itself refuses that, and so does the chain for a hand-built entry.
    const two = await part(2);
    b.undo();
    b.time = t;
    await b.refuses({ ...two, header: { ...two.header, receipts: [randomBytes(32)] } }, 'header');
    b.time = t;
    // A key change can't land inside a set either.
    const { entry } = await b.keyChangeEntry([b.passkey.slotId]);
    await b.refuses(entry, 'part set broken');
    b.time = t;
    await b.take(await part(2));
    b.time = t;
    await b.take(await part(3));
    expect(isWhole(b.state)).toBe(true);
    expect([b.state.filedThrough, b.state.counters.get(PHONE)]).toEqual([2, 4]);
    // A set starts at part 1.
    await b.refuses(part(2, { entryId: randomBytes(16), time: t + 5000 }), 'part 1');
  });
});

async function genesisOf(b: Budget) {
  const p = b.state.public;
  return {
    signPub: p.genesisSignPub,
    inboxPub: p.inboxPub,
    wrappedInbox: p.inboxes.get(1)!,
    slots: [...p.slots.values()],
  };
}

describe('public entries', () => {
  it('a new way in is added by a slot change, and can then open the budget', async () => {
    const b = await Budget.create();
    await b.edit();
    const laptopKey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(20));
    const added = await b.addSlot(laptopKey, LAPTOP);
    expect(b.state.public.slots.size).toBe(3);
    expect(toHex((await openBudget(b.state.public, laptopKey)).bk)).toBe(toHex(b.bk));
    // The same slot can't be added twice, and a slot change must name the public entry before it.
    const record = b.state.public.slots.get(laptopKey.slotId)!;
    const again = encodeSlotChange({ prevPublic: ref(added), slots: [record] });
    await b.refuses(publicEntry(b.fields(KIND.slotChange, LAPTOP), again, b.keys), 'already there');
    const other = await newSlotRecord(
      await passkeySlot(randomBytes(32), BUDGET, randomBytes(8)),
      b.bk,
      b.keys,
      BUDGET,
      b.state.public.genesisSignPub,
    );
    const stale = encodeSlotChange({ prevPublic: ref(b.entries[0]!), slots: [other] });
    await b.refuses(publicEntry(b.fields(KIND.slotChange, LAPTOP), stale, b.keys), 'previous public entry');
    // A signed body that doesn't parse breaks the rules like any other.
    const junk = concat(encodeSlotChange({ prevPublic: ref(added), slots: [other] }), u8(0));
    await b.refuses(publicEntry(b.fields(KIND.slotChange, LAPTOP), junk, b.keys), 'public body');
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
    const late = sealedEntry({ ...b.fields(KIND.edit, PHONE), keyVersion: 1 }, utf8('late'), before.keys);
    await b.refuses(late, 'key version not in force');
    // A device that holds only the new key walks back to read what was sealed before.
    const opened = await openBudget(b.state.public, b.recovery);
    const v1 = await olderKeys(b.state.public, opened, 1);
    expect(toHex(v1.bk)).toBe(toHex(before.bk));
    expect(equal(await openEntryBody(old, v1.keys), utf8('sealed under version 1'))).toBe(true);
    expect((await olderKeys(b.state.public, opened, 2)).keys.version).toBe(2);
  });

  it('walking back to an older key fails cleanly, and only from the key in force', async () => {
    const b = await Budget.create();
    const v1 = { bk: b.bk, keys: b.keys };
    await b.keyChange([b.passkey.slotId, b.recovery.slotId]);
    const p = b.state.public;
    const current = { bk: b.bk, keys: b.keys };
    await expect(olderKeys(p, current, 3)).rejects.toThrow(RangeError);
    await expect(olderKeys(p, current, 0)).rejects.toThrow(RangeError);
    await expect(olderKeys(p, v1, 1)).rejects.toThrow('not the key in force');
    const noKey = { ...p, prevKeys: new Map<number, Bytes>() };
    await expect(olderKeys(noKey, current, 1)).rejects.toThrow(ChainError);
    const wrongKey = { ...p, prevKeys: new Map([[1, randomBytes(60)]]) };
    await expect(olderKeys(wrongKey, current, 1)).rejects.toThrow(ChainError);
    // A wrapped key that opens but isn't version 1's key: here, the budget key of another budget, wrapped honestly.
    const other = randomBytes(32);
    const otherKeys = await deriveBudgetKeys(other, BUDGET, 1);
    const forged = { ...p, prevKeys: new Map([[1, await wrapPrevKey(otherKeys, b.keys, BUDGET, other)]]) };
    await expect(olderKeys(forged, current, 1)).rejects.toThrow("not that version's key");
  });

  it('a key change removes a way in, and that way in no longer opens the budget', async () => {
    const b = await Budget.create();
    await b.keyChange([b.passkey.slotId]);
    expect([...b.state.public.slots.keys()]).toEqual([b.passkey.slotId]);
    await expect(openBudget(b.state.public, b.recovery)).rejects.toThrow('removed');
    expect(toHex((await openBudget(b.state.public, b.passkey)).bk)).toBe(toHex(b.bk));
  });

  it('a new recovery key is added by a slot change, then the old one is dropped by a key change', async () => {
    const b = await Budget.create();
    const next = await recoverySlot(randomBytes(32), 2);
    await b.addSlot(next);
    await b.keyChange([b.passkey.slotId, next.slotId]);
    expect([...b.state.public.slots.keys()].sort()).toEqual([b.passkey.slotId, 'r:2'].sort());
    expect(toHex((await openBudget(b.state.public, next)).bk)).toBe(toHex(b.bk));
    await expect(openBudget(b.state.public, b.recovery)).rejects.toThrow('removed');
  });

  it('a key change adds no way in, steps the versions by one, and keeps each anchor', async () => {
    const b = await Budget.create();
    const p = b.state.public;
    const { bk, keys, change } = await b.keyChangeBody([b.passkey.slotId]);
    b.undo();
    const tryIt = async (over: Partial<KeyChange>, why: string) => {
      const e = publicEntry(b.fields(KIND.keyChange, PHONE), encodeKeyChange({ ...change, ...over }), b.keys);
      await b.refuses(e, why);
    };
    const inbox = change.inboxes[0]!;
    await tryIt({ version: 3 }, 'key version must step by 1');
    await tryIt({ inboxVersion: 3, inboxes: [{ ...inbox, version: 3 }] }, 'inbox version');
    await tryIt({ inboxes: [{ ...inbox, version: 1 }] }, 'new inbox key is missing');
    await tryIt({ inboxes: [inbox, inbox] }, 'inbox twice');
    await tryIt({ inboxes: [inbox, { ...inbox, version: 9 }] }, 'unknown inbox');
    const stranger = await passkeySlot(randomBytes(32), BUDGET, randomBytes(16));
    const added = await newSlotRecord(stranger, bk, keys, BUDGET, p.genesisSignPub);
    await tryIt({ slots: [...change.slots, added] }, 'adds no slot');
    await tryIt({ slots: [{ ...change.slots[0]!, anchor: randomBytes(32) }] }, 'anchor changed');
    await tryIt({ prevPublic: { number: 9, hash: randomBytes(32) } }, 'previous public entry');
    await tryIt({ intent: { number: 5, hash: randomBytes(32) } }, 'unknown, cancelled or used intent');
  });

  it('a key change carries every inbox key that still has unfiled runs', async () => {
    const b = await Budget.create();
    // Ten runs exist when the first key change is written, and none is filed: inbox key 1 must stay.
    await b.keyChange([b.passkey.slotId, b.recovery.slotId], { lastOldRun: 10 });
    expect([...b.state.public.inboxes.keys()].sort()).toEqual([1, 2]);
    const { change } = await b.keyChangeBody([b.passkey.slotId, b.recovery.slotId], { lastOldRun: 20 });
    b.undo();
    const only3 = change.inboxes.filter((i) => i.version === 3);
    await b.refuses(
      publicEntry(b.fields(KIND.keyChange, PHONE), encodeKeyChange({ ...change, inboxes: only3 }), b.keys),
      'unfiled runs is missing',
    );
    const drop1 = change.inboxes.filter((i) => i.version !== 1);
    await b.refuses(
      publicEntry(b.fields(KIND.keyChange, PHONE), encodeKeyChange({ ...change, inboxes: drop1 }), b.keys),
      'unfiled runs is missing',
    );
    // Once runs 1 to 10 are filed, inbox key 1 is retired and may be left behind.
    await b.bank(10);
    const later = await b.keyChangeBody([b.passkey.slotId, b.recovery.slotId], { lastOldRun: 20 });
    b.undo();
    const without1 = later.change.inboxes.filter((i) => i.version !== 1);
    const e = await publicEntry(
      b.fields(KIND.keyChange, PHONE),
      encodeKeyChange({ ...later.change, inboxes: without1 }),
      b.keys,
    );
    await b.take(e);
    expect([...b.state.public.inboxes.keys()].sort()).toEqual([2, 3]);
    // The last old run can't be behind what is filed.
    b.bk = later.bk;
    b.keys = later.keys;
    const behind = await b.keyChangeBody([b.passkey.slotId, b.recovery.slotId], { lastOldRun: 5 });
    b.undo();
    await b.refuses(
      publicEntry(b.fields(KIND.keyChange, PHONE), encodeKeyChange(behind.change), b.keys),
      'last old run',
    );
  });

  it('an intent to remove a way in waits 7 days, can be cancelled, and is used once', async () => {
    const b = await Budget.create();
    const keep = [b.passkey.slotId];
    // An intent is only recorded: one with too short a wait, or naming a slot that isn't there, doesn't stop the
    // log. It just can't be used.
    const hasty = await b.take(await b.intent(b.time + 1000 + INTENT_WAIT_MS - 1, [b.recovery.slotId]));
    const wrong = await b.take(await b.intent(b.time + 1000 + INTENT_WAIT_MS, ['r:9']));
    const good = await b.take(await b.intent(b.time + 1000 + INTENT_WAIT_MS, [b.recovery.slotId]));
    const due = good.header.time + INTENT_WAIT_MS;

    const use = (intent: Entry, at: number, kept = keep) => {
      b.time = at - 1000;
      return b.keyChangeEntry(kept, { intent: ref(intent) }).then((x) => x.entry);
    };
    await b.refuses(use(hasty, due + 5000), 'intent wait too short');
    await b.refuses(use(wrong, due + 5000), 'intent names other slots');
    // Not before it is due, to the millisecond; and it must remove exactly the slots it names.
    await b.refuses(use(good, due - 1), 'intent not yet due');
    await b.refuses(use(good, due, [b.passkey.slotId, b.recovery.slotId]), 'intent names other slots');

    // Any holder of the key can cancel it; a cancelled intent can't be used or cancelled again.
    const cancel = () =>
      publicEntry(
        b.fields(KIND.cancel, LAPTOP),
        encodeCancel({ prevPublic: b.lastPublic, intent: ref(good) }),
        b.keys,
      );
    await b.take(await cancel());
    await b.refuses(use(good, due), 'unknown, cancelled or used intent');
    await b.refuses(cancel(), 'unknown, cancelled or used intent');

    // A second intent, carried out at the very moment it is due, and then not usable again.
    const second = await b.take(await b.intent(b.time + 1000 + INTENT_WAIT_MS, [b.recovery.slotId]));
    const at = second.header.time + INTENT_WAIT_MS;
    b.time = at - 1000;
    await b.keyChange(keep, { intent: ref(second) });
    expect(b.state.public.keyVersion).toBe(2);
    expect(b.state.public.slots.has(b.recovery.slotId)).toBe(false);
    expect(b.state.public.intents.has(second.header.number)).toBe(false);
    await b.refuses(
      publicEntry(
        b.fields(KIND.cancel, PHONE),
        encodeCancel({ prevPublic: b.lastPublic, intent: ref(second) }),
        b.keys,
      ),
      'unknown, cancelled or used intent',
    );
  });

  it('an intent written after a device with a fast clock still works', async () => {
    const b = await Budget.create();
    // The entry before came from a device 3 minutes ahead; an honest writer sets notBefore from its header time.
    await b.take(
      await sealedEntry(b.fields(KIND.edit, LAPTOP, { time: b.time + 180_000 }), utf8('x'), b.keys),
    );
    b.time = b.state.time;
    const intent = await b.take(await b.intent(b.time + 1000 + INTENT_WAIT_MS, [b.recovery.slotId]));
    b.time = intent.header.time + INTENT_WAIT_MS - 1000;
    await b.keyChange([b.passkey.slotId], { intent: ref(intent) });
    expect(b.state.public.keyVersion).toBe(2);
  });
});

describe('a device that holds nothing yet', () => {
  async function story() {
    const b = await Budget.create();
    await b.edit();
    const laptopKey = await passkeySlot(randomBytes(32), BUDGET, randomBytes(20));
    await b.addSlot(laptopKey, LAPTOP);
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
    const p = await walkPublic(publics, BUDGET);
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
    // The budget the device signed in to is the one it walks.
    await expect(walkPublic(publics, '01DX5ZZKBKACTAV9WEVGEMMVRZ')).rejects.toThrow('another budget');
  });

  it('catches a public entry left out or reordered', async () => {
    const { publics } = await story();
    const [g, slot, k2, k3] = publics as [Entry, Entry, Entry, Entry];
    const bad = async (entries: Entry[], why: string) => {
      const p = walkPublic(entries, BUDGET);
      await expect(p).rejects.toThrow(ChainError);
      await expect(p).rejects.toThrow(why);
    };
    await bad([g, k2, k3], 'previous public entry');
    await bad([g, slot, k3], 'key version not in force');
    await bad([g, slot, k2, slot], 'public entries out of order');
    await bad([g, slot, slot], 'public entries out of order');
    await bad([slot, k2, k3], 'not a genesis entry');
    await bad([], 'no genesis entry');
  });

  it('a walk cut off at the end is caught by what the device knows', async () => {
    const { b, publics } = await story();
    const [g, slot, k2, k3] = publics as [Entry, Entry, Entry, Entry];
    // By itself the walk can't tell: the server serves the log as it was before the passkey was removed.
    const stale = await walkPublic([g, slot, k2], BUDGET);
    expect(stale.keyVersion).toBe(2);
    expect(stale.slots.has(b.passkey.slotId)).toBe(true);
    // The newest snapshot's signed header names the last public entry: the walk must end there.
    await expect(walkPublic([g, slot, k2], BUDGET, { mustEndAt: ref(k3) })).rejects.toThrow(
      'does not end where the snapshot says',
    );
    expect((await walkPublic(publics, BUDGET, { mustEndAt: ref(k3) })).keyVersion).toBe(3);
    // A device that remembers the removal refuses a walk that never reaches it.
    await expect(walkPublic([g, slot, k2], BUDGET, { mustPass: ref(k3) })).rejects.toThrow('does not pass');
    expect((await walkPublic(publics, BUDGET, { mustPass: ref(k2) })).keyVersion).toBe(3);
    expect((await walkPublic(publics, BUDGET, { mustPass: ref(g) })).keyVersion).toBe(3);
  });

  it('a budget of the server’s own making is refused by the slot’s anchor', async () => {
    const real = await Budget.create();
    // The server makes its own budget with the same id.
    const fake = await Budget.create();
    const p = await walkPublic([fake.entries[0]!], BUDGET);
    // The victim's passkey isn't a slot of that budget at all...
    await expect(openBudget(p, real.passkey)).rejects.toThrow('removed, or was never part');
    // ...and if the server copies the victim's slot id onto a record of its own, the anchor fails.
    const record = { ...[...p.slots.values()][0]!, slotId: real.passkey.slotId };
    const forged = { ...p, slots: new Map([[real.passkey.slotId, record]]) };
    await expect(openBudget(forged, real.passkey)).rejects.toMatchObject({ why: 'anchor' });
  });
});
