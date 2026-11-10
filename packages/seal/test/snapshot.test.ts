// Snapshots (docs/privacy-keys.md section 8): chunks, a sealed manifest, a clear signed header and a check record.
import { describe, expect, it } from 'vitest';
import {
  type BudgetKeys,
  type Bytes,
  concat,
  deriveBudgetKeys,
  encodeManifest,
  encodeSnapshotHeader,
  FormatError,
  fromHex,
  openChunk,
  openSnapshotChunk,
  openSnapshotManifest,
  randomBytes,
  readManifest,
  readSnapshotHeader,
  sealSnapshot,
  signSnapshotCheck,
  type SnapshotBounds,
  SnapshotError,
  toHex,
  u8,
  utf8,
  verify,
  verifySnapshotCheck,
  verifySnapshotHeader,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SNAP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const DEVICE = '01DX5ZZKBKACTAV9WEVGEMMVRZ';
const sha = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as Bytes));

async function make(version = 1, number = 2500, keys?: BudgetKeys) {
  const k = keys ?? (await deriveBudgetKeys(randomBytes(32), BUDGET, version));
  const entryHash = randomBytes(32);
  const at = {
    budgetId: BUDGET,
    snapshotId: SNAP,
    number,
    entryHash,
    lastPublic: { number: 40, hash: randomBytes(32) },
    tables: [
      { name: 'account', hash: randomBytes(32) },
      { name: 'bank_txn', hash: randomBytes(32) },
    ],
    checkpoints: [
      ...Array.from({ length: Math.floor((number - 1) / 1000) }, (_, i) => ({
        number: (i + 1) * 1000,
        hash: randomBytes(32),
      })),
      { number, hash: entryHash },
    ],
  };
  const plain = [randomBytes(5000), randomBytes(5000), randomBytes(123)];
  const snap = await sealSnapshot(k, at, plain);
  // What the device walked: the genesis entry, and the public entry the snapshot names, both under this key version.
  const bounds: SnapshotBounds = {
    publics: [
      { number: 1, hash: randomBytes(32), keyVersion: k.version },
      { number: 40, hash: at.lastPublic.hash, keyVersion: k.version },
    ],
  };
  return { keys: k, at, plain, snap, bounds };
}

const refused = async (p: Promise<unknown>, why: string) => {
  await expect(p).rejects.toBeInstanceOf(SnapshotError);
  await expect(p).rejects.toMatchObject({ why });
};

describe('a snapshot', () => {
  it('opens to what was sealed: the header names the manifest, the manifest names the chunks', async () => {
    const { keys, at, plain, snap, bounds } = await make();
    expect(await verifySnapshotHeader(snap.header, snap.signature, keys.sign.pub)).toBe(true);
    const { header, manifest } = await openSnapshotManifest(keys, snap, BUDGET, bounds);
    expect(header).toMatchObject({ budgetId: BUDGET, snapshotId: SNAP, version: 1, number: 2500 });
    expect(header.lastPublic).toEqual(at.lastPublic);
    expect(manifest.tables).toEqual(at.tables);
    expect(manifest.checkpoints).toEqual(at.checkpoints);
    expect(manifest.chunkHashes.length).toBe(3);
    for (let k = 1; k <= 3; k++)
      expect(toHex(await openSnapshotChunk(keys, BUDGET, manifest, k, snap.chunks[k - 1]!))).toBe(
        toHex(plain[k - 1]!),
      );
    // A chunk is sealed as chunk k of n of this snapshot: a 12-byte nonce, the bytes, a 16-byte tag.
    expect(snap.chunks[2]!.length).toBe(12 + 123 + 16);
  });

  it('the header, its signed message and a chunk’s associated data are exactly what the formats give', async () => {
    const { keys, at, plain, snap } = await make();
    const header =
      toHex(utf8('LLN1')) +
      '0000001a' +
      toHex(utf8(BUDGET)) +
      '0000001a' +
      toHex(utf8(SNAP)) +
      '00000001' +
      '00000000000009c4' +
      toHex(at.entryHash) +
      '0000000000000028' +
      toHex(at.lastPublic.hash) +
      toHex(await sha(snap.manifest));
    expect(toHex(snap.header)).toBe(header);
    expect(encodeSnapshotHeader(readSnapshotHeader(snap.header))).toEqual(snap.header);
    // The signature is over label || 0x00 || H(header); the check record over label || 0x00 || H(header) || str(device).
    const signed = concat(utf8('ledgerline/v1/snap'), u8(0), await sha(snap.header));
    expect(await verify(keys.sign.pub, signed, snap.signature)).toBe(true);
    const check = await signSnapshotCheck(keys, snap, BUDGET, DEVICE);
    const checked = concat(
      utf8('ledgerline/v1/snap-checked'),
      u8(0),
      await sha(snap.header),
      Uint8Array.of(0, 0, 0, 26),
      utf8(DEVICE),
    );
    expect(await verify(keys.sign.pub, checked, check)).toBe(true);
    // Chunk 2 of 3, opened by hand: the snapshot key derived with WebCrypto's HKDF, and the associated data written out.
    // (The budget key isn't kept, so this uses a budget whose key is known.)
    const bk = fromHex('22'.repeat(32));
    const known = await make(1, 2500, await deriveBudgetKeys(bk, BUDGET, 1));
    const snapKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: concat(Uint8Array.of(0, 0, 0, 26), utf8(BUDGET), Uint8Array.of(0, 0, 0, 1)),
            info: concat(utf8('ledgerline/v1/snapshot'), u8(0)),
          },
          await crypto.subtle.importKey('raw', bk, 'HKDF', false, ['deriveBits']),
          256,
        ),
      ),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const aad = concat(
      utf8('ledgerline/v1/snap/chunk'),
      u8(0),
      Uint8Array.of(0, 0, 0, 26),
      utf8(BUDGET),
      Uint8Array.of(0, 0, 0, 26),
      utf8(SNAP),
      Uint8Array.of(0, 0, 0, 2),
      Uint8Array.of(0, 0, 0, 3),
    );
    const sealed = known.snap.chunks[1]!;
    const opened = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad },
        snapKey,
        sealed.subarray(12),
      ),
    );
    expect(toHex(opened)).toBe(toHex(known.plain[1]!));
    expect(plain.length).toBe(3);
  });

  it('chunks can’t be swapped, cut, or moved between snapshots or budgets', async () => {
    const { keys, snap, bounds } = await make();
    const { manifest } = await openSnapshotManifest(keys, snap, BUDGET, bounds);
    // Chunk 2's bytes in chunk 1's place: the manifest's hash catches it.
    await refused(openSnapshotChunk(keys, BUDGET, manifest, 1, snap.chunks[1]!), 'chunk hash');
    // Even with a manifest that named them the other way round, a chunk opens only as its own number.
    await expect(openChunk(keys, BUDGET, SNAP, 1, 3, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, BUDGET, SNAP, 2, 4, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, OTHER, SNAP, 2, 3, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, BUDGET, DEVICE, 2, 3, snap.chunks[1]!)).rejects.toThrow();
    expect((await openChunk(keys, BUDGET, SNAP, 2, 3, snap.chunks[1]!)).length).toBe(5000);
    // More chunks than the manifest counts, and a changed chunk.
    await refused(openSnapshotChunk(keys, BUDGET, manifest, 4, snap.chunks[0]!), 'chunk number');
    const bad = snap.chunks[0]!.slice();
    bad[100]! ^= 1;
    await refused(openSnapshotChunk(keys, BUDGET, manifest, 1, bad), 'chunk hash');
    // A manifest that names a chunk another snapshot sealed: the hash matches, the seal doesn't.
    const other = await make(1, 2500, keys);
    const mixed = { ...manifest, snapshotId: DEVICE };
    await refused(openSnapshotChunk(keys, BUDGET, mixed, 1, snap.chunks[0]!), 'a chunk does not open');
    expect(other.snap.chunks.length).toBe(3);
  });

  it('a header, a manifest or a signature that isn’t this snapshot’s is refused', async () => {
    const { keys, snap, bounds } = await make();
    const other = await make();
    const open = (over: Partial<typeof snap>, k = keys, budgetId = BUDGET) =>
      openSnapshotManifest(k, { ...snap, ...over }, budgetId, bounds);
    await refused(open({ signature: other.snap.signature }), 'signature');
    await refused(open({ manifest: other.snap.manifest }), 'manifest hash');
    await refused(open({}, other.keys), 'signature');
    await refused(open({}, keys, OTHER), 'another budget');
    await refused(open({}, await deriveBudgetKeys(randomBytes(32), BUDGET, 2)), 'key version');
    // A header changed after signing, and one with a byte too many.
    const changed = snap.header.slice();
    changed[70]! ^= 1;
    await refused(open({ header: changed }), 'signature');
    await refused(open({ header: concat(snap.header, u8(0)) }), 'header: format: bytes left over');
  });

  it('must fit what the device knows: the public chain, the key version there, and how far the device has got', async () => {
    const { keys, snap, bounds, at } = await make();
    const open = (b: SnapshotBounds) => openSnapshotManifest(keys, snap, BUDGET, b);
    const [genesis, named] = bounds.publics as [SnapshotBounds['publics'][0], SnapshotBounds['publics'][0]];
    // The public entry it names isn't on the chain the device walked, or has another hash there.
    await refused(open({ publics: [genesis] }), 'not on the public chain');
    await refused(
      open({ publics: [genesis, { ...named, hash: randomBytes(32) }] }),
      'not on the public chain',
    );
    // A snapshot signed under a key version that wasn't in force at that point: a removed way in holds old keys.
    await refused(
      open({ publics: [genesis, { ...named, keyVersion: 2 }] }),
      'not the key version in force there',
    );
    // A later public entry (a key change, say) stands before the snapshot's entry: the header lies about its last one.
    await refused(
      open({ publics: [...bounds.publics, { number: 2000, hash: randomBytes(32), keyVersion: 2 }] }),
      'a later public entry comes before it',
    );
    // A later public entry after the snapshot is fine: the snapshot is simply older than the chain's end.
    await open({ publics: [...bounds.publics, { number: 3000, hash: randomBytes(32), keyVersion: 2 }] });
    // An older valid snapshot shown to a device that has got further.
    await refused(open({ ...bounds, minNumber: 2501 }), 'older than this device');
    await open({ ...bounds, minNumber: 2500 });
    // The checkpoint the device remembers must be in the snapshot's chain.
    await open({ ...bounds, checkpoint: at.checkpoints[1]! });
    await refused(
      open({ ...bounds, checkpoint: { number: 2000, hash: randomBytes(32) } }),
      'the checkpoint this device remembers is missing',
    );
  });

  it('the check record is one device’s signature over this header, made only for a header that verifies', async () => {
    const { keys, snap } = await make();
    const check = await signSnapshotCheck(keys, snap, BUDGET, DEVICE);
    expect(await verifySnapshotCheck(snap.header, DEVICE, check, keys.sign.pub)).toBe(true);
    expect(await verifySnapshotCheck(snap.header, OTHER, check, keys.sign.pub)).toBe(false);
    const other = await make();
    expect(await verifySnapshotCheck(other.snap.header, DEVICE, check, keys.sign.pub)).toBe(false);
    // A check is not a header signature, and a header signature is not a check.
    expect(await verifySnapshotHeader(snap.header, check, keys.sign.pub)).toBe(false);
    expect(await verifySnapshotCheck(snap.header, DEVICE, snap.signature, keys.sign.pub)).toBe(false);
    // A device id that isn't one simply doesn't verify.
    expect(await verifySnapshotCheck(snap.header, 'nope', check, keys.sign.pub)).toBe(false);
    // No check for another budget's header, another key version's, or one whose signature is bad.
    await expect(signSnapshotCheck(keys, snap, OTHER, DEVICE)).rejects.toThrow('another budget');
    await expect(
      signSnapshotCheck(await deriveBudgetKeys(randomBytes(32), BUDGET, 2), snap, BUDGET, DEVICE),
    ).rejects.toThrow('key version');
    await expect(
      signSnapshotCheck(keys, { header: snap.header, signature: other.snap.signature }, BUDGET, DEVICE),
    ).rejects.toThrow('header signature');
  });

  it('a manifest is written and read exactly, and odd ones are refused by writers and readers', async () => {
    const m = {
      snapshotId: SNAP,
      version: 2,
      number: 10,
      entryHash: fromHex('ab'.repeat(32)),
      chunkHashes: [fromHex('01'.repeat(32))],
      tables: [{ name: 'payee', hash: fromHex('02'.repeat(32)) }],
      checkpoints: [{ number: 10, hash: fromHex('ab'.repeat(32)) }],
    };
    const bytes = encodeManifest(m);
    expect(readManifest(bytes)).toEqual(m);
    const hex =
      toHex(utf8('LLM1')) +
      '0000001a' +
      toHex(utf8(SNAP)) +
      '00000002' +
      '000000000000000a' +
      'ab'.repeat(32) +
      '00000001' +
      '01'.repeat(32) +
      '0001' +
      '00000005' +
      toHex(utf8('payee')) +
      '02'.repeat(32) +
      '0001' +
      '000000000000000a' +
      'ab'.repeat(32);
    expect(toHex(bytes)).toBe(hex);
    for (const change of [
      { chunkHashes: [] },
      { tables: [m.tables[0]!, m.tables[0]!] },
      { tables: [{ name: '', hash: m.tables[0]!.hash }] },
      { version: 0 },
      { number: 0 },
      { checkpoints: [] },
      { checkpoints: [{ number: 9, hash: m.entryHash }] },
      { checkpoints: [{ number: 10, hash: randomBytes(32) }] },
      { checkpoints: [m.checkpoints[0]!, m.checkpoints[0]!] },
    ])
      expect(() => encodeManifest({ ...m, ...change }), JSON.stringify(Object.keys(change))).toThrow(
        RangeError,
      );
    // Readers, on bytes built by hand: a byte too many or too few, and checkpoints that don't follow the rule.
    expect(() => readManifest(concat(bytes, u8(0)))).toThrow(FormatError);
    expect(() => readManifest(bytes.subarray(0, bytes.length - 1))).toThrow(FormatError);
    const tail = '0001' + '000000000000000a' + 'ab'.repeat(32);
    const withTail = (t: string) => fromHex(hex.slice(0, hex.length - tail.length) + t);
    expect(() => readManifest(withTail('0001' + '0000000000000009' + 'ab'.repeat(32)))).toThrow(FormatError);
    expect(() => readManifest(withTail('0001' + '000000000000000a' + 'cd'.repeat(32)))).toThrow(FormatError);
    expect(() => readManifest(withTail('0000'))).toThrow(FormatError);
    // A snapshot at entry 2,500 carries the checkpoints 1,000 and 2,000 and its own, in that order.
    const big = (await make()).at;
    const good = { ...m, number: 2500, entryHash: big.entryHash, checkpoints: big.checkpoints };
    expect(readManifest(encodeManifest(good)).checkpoints.map((c) => c.number)).toEqual([1000, 2000, 2500]);
    type Point = { number: number; hash: Bytes };
    const [c1, c2, c3] = big.checkpoints as [Point, Point, Point];
    for (const checkpoints of [
      [c1, c3],
      [c2, c1, c3],
      [c1, { ...c2, number: 2001 }, c3],
      [c1, c2],
    ])
      expect(() => encodeManifest({ ...good, checkpoints })).toThrow(RangeError);
    // A chunk count the bytes can't hold is refused by its own guard, on a manifest long enough to pass the others.
    const many = encodeManifest({ ...m, chunkHashes: Array.from({ length: 40 }, () => randomBytes(32)) });
    const huge = many.slice();
    huge.set([0x7f, 0xff, 0xff, 0xff], 4 + 4 + 26 + 4 + 8 + 32);
    expect(() => readManifest(huge)).toThrow('chunk count');
  });

  it('a header that breaks the format is refused by writers and readers', async () => {
    const { snap } = await make();
    const h = readSnapshotHeader(snap.header);
    for (const change of [
      { version: 0 },
      { number: 0 },
      { lastPublic: { number: 0, hash: h.lastPublic.hash } },
      { lastPublic: { number: 2501, hash: h.lastPublic.hash } },
      // A snapshot that stands at a public entry names that entry.
      { lastPublic: { number: 2500, hash: randomBytes(32) } },
      { budgetId: 'nope' },
    ])
      expect(() => encodeSnapshotHeader({ ...h, ...change }), JSON.stringify(change)).toThrow(RangeError);
    expect(encodeSnapshotHeader({ ...h, lastPublic: { number: 2500, hash: h.entryHash } }).length).toBe(
      snap.header.length,
    );
    // The reader, on a header whose last public number is past its own.
    const bad = snap.header.slice();
    bad.set([0, 0, 0, 0, 0, 0, 0x27, 0x10], 4 + 30 + 30 + 4 + 8 + 32);
    expect(() => readSnapshotHeader(bad)).toThrow(FormatError);
  });
});
