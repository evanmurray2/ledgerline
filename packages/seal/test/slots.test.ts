// Ways in (docs/privacy-keys.md sections 4 and 5): a passkey's and the recovery key's slot, the slot record and its
// anchor, key changes, and the small wrapped values.
import { describe, expect, it } from 'vitest';
import {
  aeadOpen,
  bytes,
  checkAnchor,
  concat,
  deriveBudgetKeys,
  dhPairFromSeed,
  encodeSlotRecords,
  equal,
  FormatError,
  fromHex,
  hpke,
  isSlotId,
  newInbox,
  newSlotRecord,
  openInbox,
  openSlotRecord,
  passkeySlot,
  passkeySlotId,
  prfInput,
  randomBytes,
  Reader,
  readSlotRecords,
  recoverySlot,
  resealSlotRecord,
  rewrapInbox,
  SlotError,
  toHex,
  u16,
  u32,
  unwrapPrevKey,
  utf8,
  wrapPrevKey,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER_BUDGET = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const PRF = fromHex('a0'.repeat(32));
const CRED = fromHex('0102030405060708090a0b0c0d0e0f10');

async function budget(version = 1, bk = randomBytes(32), budgetId = BUDGET) {
  return { bk, keys: await deriveBudgetKeys(bk, budgetId, version) };
}

describe('a passkey’s slot', () => {
  it('the PRF input is one constant: H(label)', async () => {
    const theirs = new Uint8Array(
      await crypto.subtle.digest('SHA-256', concat(utf8('ledgerline/v1/prf/slot'), Uint8Array.of(0))),
    );
    expect(toHex(await prfInput())).toBe(toHex(theirs));
  });

  it('comes from the PRF output, the budget and the passkey, and is pinned', async () => {
    const s = await passkeySlot(PRF, BUDGET, CRED);
    expect(s.slotId).toBe('p:AQIDBAUGBwgJCgsMDQ4PEA');
    expect(s.slotId).toBe(passkeySlotId(CRED));
    expect(s.pair.privateKey.extractable).toBe(false);
    expect(s.anchorKey.extractable).toBe(false);
    expect(toHex(s.pair.pub)).toBe('7b67b5e596364e55164c88f1cdb029c18fd294162e51f4b4a469e9243ad11863');
    const again = await passkeySlot(PRF, BUDGET, CRED);
    expect(toHex(again.pair.pub)).toBe(toHex(s.pair.pub));
    for (const other of [
      await passkeySlot(fromHex('a1'.repeat(32)), BUDGET, CRED),
      await passkeySlot(PRF, OTHER_BUDGET, CRED),
      await passkeySlot(PRF, BUDGET, fromHex('ff')),
    ])
      expect(toHex(other.pair.pub)).not.toBe(toHex(s.pair.pub));
    await expect(passkeySlot(PRF.subarray(0, 31), BUDGET, CRED)).rejects.toThrow(RangeError);
    expect(() => passkeySlotId(bytes(0))).toThrow(RangeError);
    expect(() => passkeySlotId(bytes(1024))).toThrow(RangeError);
  });
});

describe('the recovery key’s slot', () => {
  it('gives a slot pair, an anchor key and a sign-in pair, each its own, and is pinned', async () => {
    const r = fromHex('5a'.repeat(32));
    const s = await recoverySlot(r, 1);
    expect(s.slotId).toBe('r:1');
    expect((await recoverySlot(r, 12)).slotId).toBe('r:12');
    expect(toHex(s.pair.pub)).toBe('fbc1f881938a587fb8b3fb44c863758082b978ffa8afc7f19b5df469f2f9602d');
    expect(toHex(s.auth.pub)).toBe('cec3258a504f171ea7bf305e01cb9d8caf3cea4b58db0bdc79490af0ef40c088');
    expect(toHex(s.auth.pub)).not.toBe(toHex(s.pair.pub));
    await expect(recoverySlot(r, 0)).rejects.toThrow(RangeError);
    await expect(recoverySlot(r.subarray(0, 16), 1)).rejects.toThrow(RangeError);
  });
});

describe('a slot record', () => {
  it('is opened by its own way in, and gives the budget key the chain names', async () => {
    const { bk, keys } = await budget();
    const s = await passkeySlot(PRF, BUDGET, CRED);
    const record = await newSlotRecord(s, bk, keys, BUDGET, keys.sign.pub);
    expect([record.anchor.length, record.sealedKey.length, record.wrappedPub.length]).toEqual([32, 80, 60]);
    const opened = await openSlotRecord(s, record, BUDGET, 1, keys.sign.pub, keys.sign.pub);
    expect(toHex(opened.bk)).toBe(toHex(bk));
    expect(toHex(opened.keys.sign.pub)).toBe(toHex(keys.sign.pub));
    // The public half is wrapped for holders of the budget key, and the server never sees it in clear.
    const wrapAad = concat(
      utf8('ledgerline/v1/wrap/slot'),
      Uint8Array.of(0, 0, 0, 0, 26),
      utf8(BUDGET),
      Uint8Array.of(0, 0, 0, s.slotId.length),
      utf8(s.slotId),
    );
    expect(toHex(await aeadOpen(keys.wrap, wrapAad, record.wrappedPub))).toBe(toHex(s.pair.pub));
  });

  it('refuses another way in, another budget, another version and another signing key', async () => {
    const { bk, keys } = await budget();
    const s = await passkeySlot(PRF, BUDGET, CRED);
    const record = await newSlotRecord(s, bk, keys, BUDGET, keys.sign.pub);
    const open = (
      who = s,
      rec = record,
      budgetId = BUDGET,
      version = 1,
      genesis = keys.sign.pub,
      chain = keys.sign.pub,
    ) => openSlotRecord(who, rec, budgetId, version, genesis, chain);

    const stranger = await passkeySlot(randomBytes(32), BUDGET, CRED);
    await expect(open(stranger)).rejects.toMatchObject({ why: 'anchor' });
    await expect(open(s, record, OTHER_BUDGET)).rejects.toMatchObject({ why: 'anchor' });
    await expect(open(s, record, BUDGET, 1, randomBytes(32))).rejects.toMatchObject({ why: 'anchor' });
    await expect(open(s, record, BUDGET, 2)).rejects.toMatchObject({ why: 'open' });
    await expect(open(s, record, BUDGET, 1, keys.sign.pub, randomBytes(32))).rejects.toMatchObject({
      why: 'open',
    });
    await expect(open(s, { ...record, slotId: 'p:AAAA' })).rejects.toBeInstanceOf(SlotError);
    const bad = record.sealedKey.slice();
    bad[40]! ^= 1;
    await expect(open(s, { ...record, sealedKey: bad })).rejects.toMatchObject({ why: 'open' });
  });

  it('a budget key someone else sealed to the slot is refused: sealing proves nothing about the sealer', async () => {
    const { bk, keys } = await budget();
    const s = await passkeySlot(PRF, BUDGET, CRED);
    const record = await newSlotRecord(s, bk, keys, BUDGET, keys.sign.pub);
    // A server that knows the slot's public half makes a budget of its own and seals its key to the slot.
    const fake = await budget();
    const info = concat(
      utf8('ledgerline/v1/hpke/slot'),
      Uint8Array.of(0, 0, 0, 0, 26),
      utf8(BUDGET),
      Uint8Array.of(0, 0, 0, s.slotId.length),
      utf8(s.slotId),
      Uint8Array.of(0, 0, 0, 1),
    );
    const forged = {
      ...record,
      sealedKey: await hpke.seal(s.pair.pub, info, fake.keys.sign.pub, fake.bk),
    };
    // With the real budget's anchor and the fake chain's signing keys, the anchor fails: it names the real genesis key.
    await expect(
      openSlotRecord(s, forged, BUDGET, 1, fake.keys.sign.pub, fake.keys.sign.pub),
    ).rejects.toMatchObject({ why: 'anchor' });
    // With the real genesis key but a chain that names the real signing key, the sealed key doesn't open.
    await expect(openSlotRecord(s, forged, BUDGET, 1, keys.sign.pub, keys.sign.pub)).rejects.toMatchObject({
      why: 'open',
    });
    // A key sealed with the right associated data but that derives another signing key is refused too.
    const mismatched = { ...record, sealedKey: await hpke.seal(s.pair.pub, info, keys.sign.pub, fake.bk) };
    await expect(
      openSlotRecord(s, mismatched, BUDGET, 1, keys.sign.pub, keys.sign.pub),
    ).rejects.toMatchObject({
      why: 'signing_key',
    });
    expect(await checkAnchor(s, BUDGET, keys.sign.pub, record.anchor)).toBe(true);
    expect(await checkAnchor(s, BUDGET, keys.sign.pub, record.anchor.subarray(0, 31))).toBe(false);
  });

  it('a key change seals the new key to every slot that stays, without their secrets', async () => {
    const v1 = await budget(1);
    const genesis = v1.keys.sign.pub;
    const passkey = await passkeySlot(PRF, BUDGET, CRED);
    const recovery = await recoverySlot(randomBytes(32), 1);
    const records = [
      await newSlotRecord(passkey, v1.bk, v1.keys, BUDGET, genesis),
      await newSlotRecord(recovery, v1.bk, v1.keys, BUDGET, genesis),
    ];
    const v2 = await budget(2);
    const next = await Promise.all(records.map((r) => resealSlotRecord(r, v1.keys, v2.bk, v2.keys, BUDGET)));
    for (const [who, rec, old] of [
      [passkey, next[0]!, records[0]!],
      [recovery, next[1]!, records[1]!],
    ] as const) {
      expect(toHex(rec.anchor)).toBe(toHex(old.anchor));
      const opened = await openSlotRecord(who, rec, BUDGET, 2, genesis, v2.keys.sign.pub);
      expect(toHex(opened.bk)).toBe(toHex(v2.bk));
      // The old record no longer gives the key in force.
      await expect(openSlotRecord(who, old, BUDGET, 2, genesis, v2.keys.sign.pub)).rejects.toBeInstanceOf(
        SlotError,
      );
    }
    // And again, to version 3: the recovery key still opens after several key changes.
    const v3 = await budget(3);
    const third = await resealSlotRecord(next[1]!, v2.keys, v3.bk, v3.keys, BUDGET);
    expect(toHex((await openSlotRecord(recovery, third, BUDGET, 3, genesis, v3.keys.sign.pub)).bk)).toBe(
      toHex(v3.bk),
    );
    await expect(resealSlotRecord(records[0]!, v1.keys, v3.bk, v3.keys, BUDGET)).rejects.toThrow(RangeError);
  });

  it('is written and read exactly: 1 to 64 slots, none twice, nothing left over', async () => {
    const { bk, keys } = await budget();
    const a = await newSlotRecord(await passkeySlot(PRF, BUDGET, CRED), bk, keys, BUDGET, keys.sign.pub);
    const b = await newSlotRecord(await recoverySlot(randomBytes(32), 1), bk, keys, BUDGET, keys.sign.pub);
    const encoded = encodeSlotRecords([a, b]);
    const r = new Reader(encoded);
    const back = readSlotRecords(r);
    r.end();
    expect(back.map((x) => x.slotId)).toEqual([a.slotId, 'r:1']);
    expect(toHex(back[0]!.sealedKey)).toBe(toHex(a.sealedKey));
    expect(toHex(encodeSlotRecords(back))).toBe(toHex(encoded));

    expect(() => encodeSlotRecords([])).toThrow(RangeError);
    expect(() => encodeSlotRecords([a, a])).toThrow(RangeError);
    expect(() => encodeSlotRecords(Array.from({ length: 65 }, () => a))).toThrow(RangeError);
    expect(() => readSlotRecords(new Reader(u16(0)))).toThrow(FormatError);
    expect(() => readSlotRecords(new Reader(encoded.subarray(0, encoded.length - 1)))).toThrow(FormatError);
    const one = encodeSlotRecords([a]);
    expect(() => readSlotRecords(new Reader(concat(u16(2), one.subarray(2), one.subarray(2))))).toThrow(
      FormatError,
    );
    // 64 slots are allowed, 65 are not.
    const many = Array.from({ length: 64 }, (_, i) => ({ ...b, slotId: `r:${i + 1}` }));
    expect(readSlotRecords(new Reader(encodeSlotRecords(many))).length).toBe(64);
    expect(() => encodeSlotRecords([...many, { ...b, slotId: 'r:65' }])).toThrow(RangeError);
  });

  it('a slot id has one spelling, for writers and readers', async () => {
    const good = ['r:1', 'r:4294967295', 'p:AQ', 'p:AQIDBAUGBwgJCgsMDQ4PEA', `p:${'A'.repeat(1364)}`];
    const bad = [
      'x:1',
      'r:',
      'r:0',
      'r:01',
      'r:4294967296',
      'r:9999999999',
      'p:',
      'p:A', // an impossible base64url length
      'p:AR', // stray trailing bits: the same credential as p:AQ
      'p:AQ==',
      'p:A+',
      `p:${'A'.repeat(1366)}`, // a credential id over 1,023 bytes
      '﻿r:1',
      'r:1 ',
    ];
    for (const id of good) expect(isSlotId(id), id).toBe(true);
    for (const id of bad) expect(isSlotId(id), id).toBe(false);

    const { bk, keys } = await budget();
    const a = await newSlotRecord(await recoverySlot(randomBytes(32), 1), bk, keys, BUDGET, keys.sign.pub);
    // A writer refuses what a reader would refuse.
    for (const id of bad) expect(() => encodeSlotRecords([{ ...a, slotId: id }]), id).toThrow(RangeError);
    // And a reader refuses it in bytes built by hand, a leading byte-order mark included.
    const body = (idBytes: Uint8Array) =>
      concat(u16(1), u32(idBytes.length), idBytes, a.anchor, a.sealedKey, a.wrappedPub);
    expect(readSlotRecords(new Reader(body(utf8('r:1')))).length).toBe(1);
    for (const id of ['x:1', 'r:01', 'p:AR', 'r:4294967296'])
      expect(() => readSlotRecords(new Reader(body(utf8(id)))), id).toThrow(FormatError);
    expect(() =>
      readSlotRecords(new Reader(body(concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('r:1'))))),
    ).toThrow(FormatError);
    // Two spellings of one credential can't both be in one body: the second spelling is refused outright.
    const rest = concat(a.anchor, a.sealedKey, a.wrappedPub);
    const two = concat(u16(2), u32(4), utf8('p:AQ'), rest, u32(4), utf8('p:AR'), rest);
    expect(() => readSlotRecords(new Reader(two))).toThrow(FormatError);
  });

  it('a record sealed with the wrong budget key is refused when it is written, not found out later', async () => {
    const v1 = await budget(1);
    const v2 = await budget(2);
    const s = await passkeySlot(PRF, BUDGET, CRED);
    const record = await newSlotRecord(s, v1.bk, v1.keys, BUDGET, v1.keys.sign.pub);
    // A key change handed the old key by mistake would lock out every other way in for good.
    await expect(resealSlotRecord(record, v1.keys, v1.bk, v2.keys, BUDGET)).rejects.toThrow(RangeError);
    await expect(resealSlotRecord(record, v1.keys, randomBytes(32), v2.keys, BUDGET)).rejects.toThrow(
      RangeError,
    );
    await expect(newSlotRecord(s, randomBytes(32), v1.keys, BUDGET, v1.keys.sign.pub)).rejects.toThrow(
      RangeError,
    );
    // At version 1 the first signing key is the one in force.
    await expect(newSlotRecord(s, v1.bk, v1.keys, BUDGET, randomBytes(32))).rejects.toThrow(RangeError);
    // A mistake in an argument is the caller's error, not "this slot doesn't open".
    await expect(openSlotRecord(s, record, BUDGET, 1.5, v1.keys.sign.pub, v1.keys.sign.pub)).rejects.toThrow(
      RangeError,
    );
  });

  it('the anchor is exactly HMAC(anchorKey, label || str(budgetId) || str(slotId) || genesisSignPub)', async () => {
    const { bk, keys } = await budget();
    const s = await passkeySlot(PRF, BUDGET, CRED);
    const record = await newSlotRecord(s, bk, keys, BUDGET, keys.sign.pub);
    // The anchor key, derived here with WebCrypto's own HKDF from the PRF output.
    const salt = concat(Uint8Array.of(0, 0, 0, 26), utf8(BUDGET), u32(CRED.length), CRED);
    const ikm = await crypto.subtle.importKey('raw', PRF, 'HKDF', false, ['deriveBits']);
    const anchorKey = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt,
          info: concat(utf8('ledgerline/v1/slot/anchor'), Uint8Array.of(0)),
        },
        ikm,
        256,
      ),
    );
    const message = concat(
      utf8('ledgerline/v1/anchor'),
      Uint8Array.of(0, 0, 0, 0, 26),
      utf8(BUDGET),
      u32(s.slotId.length),
      utf8(s.slotId),
      keys.sign.pub,
    );
    const key = await crypto.subtle.importKey('raw', anchorKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const theirs = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    expect(toHex(record.anchor)).toBe(toHex(theirs));
  });
});

describe('small wrapped values', () => {
  it('an inbox private key opens only under its budget, its version and its wrap key', async () => {
    const v1 = await budget(1);
    const inbox = await newInbox(v1.keys, BUDGET, 1);
    expect(inbox.wrapped.length).toBe(60);
    expect(toHex((await openInbox(v1.keys, BUDGET, 1, inbox.wrapped)).pub)).toBe(toHex(inbox.pair.pub));
    // The wrapped value is the pair's seed under AEAD(K_wrap, label || str(budgetId) || u32(i)), written out by hand.
    const aad = concat(utf8('ledgerline/v1/wrap/inbox'), Uint8Array.of(0, 0, 0, 0, 26), utf8(BUDGET), u32(1));
    const seed = await aeadOpen(v1.keys.wrap, aad, inbox.wrapped);
    expect(toHex((await dhPairFromSeed(seed)).pub)).toBe(toHex(inbox.pair.pub));
    await expect(openInbox(v1.keys, BUDGET, 2, inbox.wrapped)).rejects.toThrow();
    await expect(openInbox(v1.keys, OTHER_BUDGET, 1, inbox.wrapped)).rejects.toThrow();
    await expect(openInbox((await budget(1)).keys, BUDGET, 1, inbox.wrapped)).rejects.toThrow();
    // A key change carries it forward under the new wrap key.
    const v2 = await budget(2);
    const carried = await rewrapInbox(v1.keys, v2.keys, BUDGET, 1, inbox.wrapped);
    await expect(rewrapInbox(v2.keys, v1.keys, BUDGET, 1, inbox.wrapped)).rejects.toThrow(RangeError);
    await expect(rewrapInbox(v1.keys, v1.keys, BUDGET, 1, inbox.wrapped)).rejects.toThrow(RangeError);
    expect(toHex((await openInbox(v2.keys, BUDGET, 1, carried)).pub)).toBe(toHex(inbox.pair.pub));
    // What it sealed still opens.
    const sealed = await hpke.seal(inbox.pair.pub, utf8('i'), utf8('a'), utf8('a bank page'));
    const pair = await openInbox(v2.keys, BUDGET, 1, carried);
    expect(equal(await hpke.open(pair, utf8('i'), utf8('a'), sealed), utf8('a bank page'))).toBe(true);
  });

  it('each key change carries the key before it, so a later device can walk back', async () => {
    const v1 = await budget(1);
    const v2 = await budget(2);
    const v3 = await budget(3);
    const w2 = await wrapPrevKey(v1.keys, v2.keys, BUDGET, v1.bk);
    const w3 = await wrapPrevKey(v2.keys, v3.keys, BUDGET, v2.bk);
    expect(w2.length).toBe(60);
    // A device that holds only version 3 reaches version 2, then version 1.
    const bk2 = await unwrapPrevKey(v3.keys, BUDGET, w3);
    expect(toHex(bk2)).toBe(toHex(v2.bk));
    const bk1 = await unwrapPrevKey(await deriveBudgetKeys(bk2, BUDGET, 2), BUDGET, w2);
    expect(toHex(bk1)).toBe(toHex(v1.bk));
    await expect(unwrapPrevKey(v3.keys, BUDGET, w2)).rejects.toThrow();
    await expect(unwrapPrevKey(v2.keys, OTHER_BUDGET, w2)).rejects.toThrow();
    // The key before must be the key before: the wrong 32 bytes, or keys that aren't one version apart, are refused.
    await expect(wrapPrevKey(v1.keys, v2.keys, BUDGET, v2.bk)).rejects.toThrow(RangeError);
    await expect(wrapPrevKey(v1.keys, v2.keys, BUDGET, randomBytes(32))).rejects.toThrow(RangeError);
    await expect(wrapPrevKey(v1.keys, v3.keys, BUDGET, v1.bk)).rejects.toThrow(RangeError);
    await expect(wrapPrevKey(v2.keys, v1.keys, BUDGET, v2.bk)).rejects.toThrow(RangeError);
    // And the wrapped key is exactly AEAD(K_wrap_2, label || str(budgetId) || u32(1), BK_1), written out by hand.
    const aad = concat(
      utf8('ledgerline/v1/wrap/prev-key'),
      Uint8Array.of(0, 0, 0, 0, 26),
      utf8(BUDGET),
      u32(1),
    );
    expect(toHex(await aeadOpen(v2.keys.wrap, aad, w2))).toBe(toHex(v1.bk));
  });
});
