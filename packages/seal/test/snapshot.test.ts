// Snapshots (docs/privacy-keys.md section 8): chunks, a sealed manifest, a clear signed header and a check record.
import { describe, expect, it } from 'vitest';
import {
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
  SnapshotError,
  toHex,
  u8,
  utf8,
  verifySnapshotCheck,
  verifySnapshotHeader,
} from '../src/index.js';

const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const SNAP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const DEVICE = '01DX5ZZKBKACTAV9WEVGEMMVRZ';

async function make(version = 1) {
  const keys = await deriveBudgetKeys(randomBytes(32), BUDGET, version);
  const at = {
    budgetId: BUDGET,
    snapshotId: SNAP,
    number: 2500,
    entryHash: randomBytes(32),
    lastPublic: { number: 40, hash: randomBytes(32) },
    tables: [
      { name: 'account', hash: randomBytes(32) },
      { name: 'bank_txn', hash: randomBytes(32) },
    ],
    checkpoints: [
      { number: 1000, hash: randomBytes(32) },
      { number: 2000, hash: randomBytes(32) },
      { number: 2500, hash: randomBytes(32) },
    ],
  };
  const plain = [randomBytes(5000), randomBytes(5000), randomBytes(123)];
  return { keys, at, plain, snap: await sealSnapshot(keys, at, plain) };
}

describe('a snapshot', () => {
  it('opens to what was sealed: the header names the manifest, the manifest names the chunks', async () => {
    const { keys, at, plain, snap } = await make();
    expect(await verifySnapshotHeader(snap.header, snap.signature, keys.sign.pub)).toBe(true);
    const { header, manifest } = await openSnapshotManifest(keys, snap, BUDGET);
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

  it('the header has exactly the bytes the formats give', async () => {
    const { at, snap } = await make();
    const sha = async (b: Uint8Array) =>
      toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as Bytes)));
    const expected =
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
      (await sha(snap.manifest));
    expect(toHex(snap.header)).toBe(expected);
    expect(encodeSnapshotHeader(readSnapshotHeader(snap.header))).toEqual(snap.header);
  });

  it('chunks can’t be swapped, cut, or moved between snapshots or budgets', async () => {
    const { keys, snap } = await make();
    const { manifest } = await openSnapshotManifest(keys, snap, BUDGET);
    // Chunk 2's bytes in chunk 1's place: the manifest's hash catches it.
    await expect(openSnapshotChunk(keys, BUDGET, manifest, 1, snap.chunks[1]!)).rejects.toThrow(
      SnapshotError,
    );
    // Even with a manifest that named them the other way round, a chunk opens only as its own number.
    await expect(openChunk(keys, BUDGET, SNAP, 1, 3, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, BUDGET, SNAP, 2, 4, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, OTHER, SNAP, 2, 3, snap.chunks[1]!)).rejects.toThrow();
    await expect(openChunk(keys, BUDGET, DEVICE, 2, 3, snap.chunks[1]!)).rejects.toThrow();
    expect((await openChunk(keys, BUDGET, SNAP, 2, 3, snap.chunks[1]!)).length).toBe(5000);
    await expect(openSnapshotChunk(keys, BUDGET, manifest, 4, snap.chunks[0]!)).rejects.toThrow(RangeError);
    const bad = snap.chunks[0]!.slice();
    bad[100]! ^= 1;
    await expect(openSnapshotChunk(keys, BUDGET, manifest, 1, bad)).rejects.toThrow(SnapshotError);
  });

  it('a header, a manifest or a signature that isn’t this snapshot’s is refused', async () => {
    const { keys, snap } = await make();
    const other = await make();
    const open = (over: Partial<typeof snap>, k = keys, budgetId = BUDGET) =>
      openSnapshotManifest(k, { ...snap, ...over }, budgetId);
    await expect(open({ signature: other.snap.signature })).rejects.toThrow('signature');
    await expect(open({ manifest: other.snap.manifest })).rejects.toThrow('manifest hash');
    await expect(open({}, other.keys)).rejects.toThrow('signature');
    await expect(open({}, keys, OTHER)).rejects.toThrow('another budget');
    await expect(open({}, await deriveBudgetKeys(randomBytes(32), BUDGET, 2))).rejects.toThrow('key version');
    // A header changed after signing.
    const changed = snap.header.slice();
    changed[70]! ^= 1;
    await expect(open({ header: changed })).rejects.toThrow();
    await expect(open({ header: concat(snap.header, u8(0)) })).rejects.toThrow(FormatError);
  });

  it('the check record is one device’s signature over this header', async () => {
    const { keys, snap } = await make();
    const check = await signSnapshotCheck(keys, snap.header, DEVICE);
    expect(await verifySnapshotCheck(snap.header, DEVICE, check, keys.sign.pub)).toBe(true);
    expect(await verifySnapshotCheck(snap.header, OTHER, check, keys.sign.pub)).toBe(false);
    const other = await make();
    expect(await verifySnapshotCheck(other.snap.header, DEVICE, check, keys.sign.pub)).toBe(false);
    // A check is not a header signature, and a header signature is not a check.
    expect(await verifySnapshotHeader(snap.header, check, keys.sign.pub)).toBe(false);
    expect(await verifySnapshotCheck(snap.header, DEVICE, snap.signature, keys.sign.pub)).toBe(false);
    await expect(
      signSnapshotCheck(await deriveBudgetKeys(randomBytes(32), BUDGET, 2), snap.header, DEVICE),
    ).rejects.toThrow(RangeError);
  });

  it('a manifest is written and read exactly, and odd ones are refused', async () => {
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
    expect(toHex(bytes)).toBe(
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
        'ab'.repeat(32),
    );
    expect(() => encodeManifest({ ...m, chunkHashes: [] })).toThrow(RangeError);
    expect(() => encodeManifest({ ...m, tables: [m.tables[0]!, m.tables[0]!] })).toThrow(RangeError);
    expect(() => encodeManifest({ ...m, tables: [{ name: '', hash: m.tables[0]!.hash }] })).toThrow(
      RangeError,
    );
    expect(() => readManifest(concat(bytes, u8(0)))).toThrow(FormatError);
    expect(() => readManifest(bytes.subarray(0, bytes.length - 1))).toThrow(FormatError);
    // A chunk count the bytes can't hold is refused before anything is read.
    const huge = bytes.slice();
    huge.set([0xff, 0xff, 0xff, 0xff], 4 + 4 + 26 + 4 + 8 + 32);
    expect(() => readManifest(huge)).toThrow(FormatError);
  });
});
