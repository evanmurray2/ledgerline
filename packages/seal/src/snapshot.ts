// Snapshots (docs/privacy-keys.md section 8): the whole budget, sealed in chunks, with a sealed manifest, a clear
// signed header that the server acts on, and a check record that says a device rebuilt the budget and got the same.
import {
  type Bytes,
  concat,
  equal,
  FormatError,
  isUlid,
  label,
  Reader,
  str,
  u16,
  u32,
  u64,
  utf8,
} from './bytes.js';
import { aeadOpen, aeadSeal, OpenError } from './aead.js';
import type { BudgetKeys } from './budget-key.js';
import { sign, verify } from './curve.js';
import type { PublicRef } from './entry.js';
import { sha256 } from './hash.js';

export const MAX_TABLES = 4096;
export const MAX_TABLE_NAME = 255;
export const MAX_CHECKPOINTS = 65535;
/** Every entry whose number is a multiple of this is a checkpoint. */
export const CHECKPOINT_EVERY = 1000;
/** The most devices a snapshot's position names. */
export const MAX_DEVICES = 4096;

/**
 * Where the snapshot stands in the log, beyond its number and hash: what a device needs to check the entry after it
 * (chain.ts `resumeChain`). The devices are in ascending order of id.
 */
export interface SnapshotPosition {
  /** Of the entry the snapshot stands at. */
  time: number;
  entryId: Bytes;
  filedThrough: number;
  scanThrough: number;
  /** Each device's last counter. Every entry raised one of them by 1, so they add up to the snapshot's number. */
  counters: { deviceId: string; counter: number }[];
}

export interface Manifest {
  snapshotId: string;
  /** The key version it is sealed under. */
  version: number;
  /** The entry the snapshot stands at. */
  number: number;
  entryHash: Bytes;
  /** H(chunk as stored), in order. */
  chunkHashes: Bytes[];
  tables: { name: string; hash: Bytes }[];
  /** The hash of every entry whose number is a multiple of 1,000, in order, then the snapshot's own entry. */
  checkpoints: PublicRef[];
  position: SnapshotPosition;
}

const ulid = (id: string, what: string): string => {
  if (!isUlid(id)) throw new RangeError(what);
  return id;
};
const hash32 = (h: Uint8Array): Uint8Array => {
  if (h.length !== 32) throw new RangeError('hash');
  return h;
};

function chunkAad(budgetId: string, snapshotId: string, k: number, count: number): Bytes {
  if (!Number.isInteger(k) || !Number.isInteger(count) || k < 1 || k > count)
    throw new RangeError('chunk number');
  return concat(
    label('ledgerline/v1/snap/chunk'),
    str(ulid(budgetId, 'budget id')),
    str(ulid(snapshotId, 'snapshot id')),
    u32(k),
    u32(count),
  );
}
const manifestAad = (budgetId: string, snapshotId: string): Bytes =>
  concat(
    label('ledgerline/v1/snap/manifest'),
    str(ulid(budgetId, 'budget id')),
    str(ulid(snapshotId, 'snapshot id')),
  );

/** Chunk `k` of `count` (from 1), sealed: it opens only as that chunk of that snapshot of that budget. */
export async function sealChunk(
  keys: BudgetKeys,
  budgetId: string,
  snapshotId: string,
  k: number,
  count: number,
  plain: Uint8Array,
): Promise<Bytes> {
  return aeadSeal(keys.snapshot, chunkAad(budgetId, snapshotId, k, count), plain);
}

export async function openChunk(
  keys: BudgetKeys,
  budgetId: string,
  snapshotId: string,
  k: number,
  count: number,
  sealed: Uint8Array,
): Promise<Bytes> {
  return aeadOpen(keys.snapshot, chunkAad(budgetId, snapshotId, k, count), sealed);
}

/** The checkpoints a snapshot at `number` must carry: how many there are. */
const checkpointCount = (number: number): number => Math.floor((number - 1) / CHECKPOINT_EVERY) + 1;

/** What is wrong with a manifest's numbers and checkpoints, or null. */
function manifestFault(m: Manifest): string | null {
  if (!Number.isInteger(m.version) || m.version < 1 || m.version > 0xffffffff) return 'key version';
  if (!Number.isSafeInteger(m.number) || m.number < 1) return 'number';
  const c = m.checkpoints;
  if (c.length !== checkpointCount(m.number) || c.length > MAX_CHECKPOINTS) return 'checkpoint count';
  for (let i = 0; i < c.length - 1; i++)
    if (c[i]!.number !== (i + 1) * CHECKPOINT_EVERY || c[i]!.hash.length !== 32) return 'checkpoint';
  const last = c[c.length - 1]!;
  if (last.number !== m.number || !equal(last.hash, m.entryHash))
    return 'the last checkpoint is the snapshot itself';
  return positionFault(m.position, m.number);
}

function positionFault(p: SnapshotPosition, number: number): string | null {
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!whole(p.time, Number.MAX_SAFE_INTEGER) || p.entryId.length !== 16) return 'position';
  if (!whole(p.filedThrough, Number.MAX_SAFE_INTEGER) || !whole(p.scanThrough, 0xffffffff)) return 'position';
  if (p.counters.length < 1 || p.counters.length > MAX_DEVICES) return 'device count';
  let total = 0;
  for (let i = 0; i < p.counters.length; i++) {
    const c = p.counters[i]!;
    if (!isUlid(c.deviceId) || !whole(c.counter, Number.MAX_SAFE_INTEGER) || c.counter < 1)
      return 'device counter';
    if (i > 0 && !(p.counters[i - 1]!.deviceId < c.deviceId)) return 'device order';
    total += c.counter;
  }
  if (total !== number) return 'device counters do not add up to the number';
  return null;
}

export function encodeManifest(m: Manifest): Bytes {
  const fault = manifestFault(m);
  if (fault) throw new RangeError(`manifest: ${fault}`);
  if (m.chunkHashes.length < 1 || m.chunkHashes.length > 0xffffffff) throw new RangeError('chunk count');
  if (m.tables.length > MAX_TABLES) throw new RangeError('table count');
  const names = m.tables.map((t) => t.name);
  if (new Set(names).size !== names.length) throw new RangeError('table twice');
  for (const t of m.tables) {
    const n = utf8(t.name);
    if (n.length < 1 || n.length > MAX_TABLE_NAME) throw new RangeError('table name');
  }
  return concat(
    utf8('LLM1'),
    str(ulid(m.snapshotId, 'snapshot id')),
    u32(m.version),
    u64(m.number),
    hash32(m.entryHash),
    u32(m.chunkHashes.length),
    ...m.chunkHashes.map(hash32),
    u16(m.tables.length),
    ...m.tables.map((t) => concat(str(t.name), hash32(t.hash))),
    u16(m.checkpoints.length),
    ...m.checkpoints.map((c) => concat(u64(c.number), hash32(c.hash))),
    u64(m.position.time),
    m.position.entryId,
    u64(m.position.filedThrough),
    u32(m.position.scanThrough),
    u16(m.position.counters.length),
    ...m.position.counters.map((c) => concat(str(c.deviceId), u64(c.counter))),
  );
}

export function readManifest(bytes: Uint8Array): Manifest {
  const r = new Reader(bytes);
  r.magic('LLM1');
  const snapshotId = r.text(26);
  if (!isUlid(snapshotId)) throw new FormatError('snapshot id');
  const version = r.u32();
  const number = r.u64();
  const entryHash = r.take(32);
  const count = r.u32();
  // Each hash is 32 bytes of the manifest itself, so a count the bytes can't hold is refused before any loop.
  if (count < 1 || count > Math.floor(bytes.length / 32)) throw new FormatError('chunk count');
  const chunkHashes: Bytes[] = [];
  for (let i = 0; i < count; i++) chunkHashes.push(r.take(32));
  const nt = r.u16();
  if (nt > MAX_TABLES) throw new FormatError('table count');
  const tables: Manifest['tables'] = [];
  for (let i = 0; i < nt; i++) {
    const name = r.text(MAX_TABLE_NAME);
    if (name.length === 0) throw new FormatError('table name');
    tables.push({ name, hash: r.take(32) });
  }
  if (new Set(tables.map((t) => t.name)).size !== nt) throw new FormatError('table twice');
  const nc = r.u16();
  const checkpoints: PublicRef[] = [];
  for (let i = 0; i < nc; i++) checkpoints.push({ number: r.u64(), hash: r.take(32) });
  const time = r.u64();
  const entryId = r.take(16);
  const filedThrough = r.u64();
  const scanThrough = r.u32();
  const nd = r.u16();
  if (nd < 1 || nd > MAX_DEVICES) throw new FormatError('device count');
  const counters: SnapshotPosition['counters'] = [];
  for (let i = 0; i < nd; i++) counters.push({ deviceId: r.text(26), counter: r.u64() });
  r.end();
  const position = { time, entryId, filedThrough, scanThrough, counters };
  const m = { snapshotId, version, number, entryHash, chunkHashes, tables, checkpoints, position };
  const fault = manifestFault(m);
  if (fault) throw new FormatError(fault);
  return m;
}

/** The clear header: what the server acts on. */
export interface SnapshotHeader {
  budgetId: string;
  snapshotId: string;
  version: number;
  number: number;
  entryHash: Bytes;
  /** The last public entry at or before `number`. */
  lastPublic: PublicRef;
  /** H(manifest as stored). */
  manifestHash: Bytes;
}

/** What is wrong with a header's numbers, or null. */
function headerFault(h: SnapshotHeader): string | null {
  if (!Number.isInteger(h.version) || h.version < 1 || h.version > 0xffffffff) return 'key version';
  if (!Number.isSafeInteger(h.number) || !Number.isSafeInteger(h.lastPublic.number)) return 'number';
  if (h.number < 1 || h.lastPublic.number < 1 || h.lastPublic.number > h.number) return 'number';
  // A snapshot that stands at a public entry names that entry.
  if (h.lastPublic.number === h.number && !equal(h.lastPublic.hash, h.entryHash)) return 'last public entry';
  return null;
}

export function encodeSnapshotHeader(h: SnapshotHeader): Bytes {
  const fault = headerFault(h);
  if (fault) throw new RangeError(`snapshot header: ${fault}`);
  return concat(
    utf8('LLN1'),
    str(ulid(h.budgetId, 'budget id')),
    str(ulid(h.snapshotId, 'snapshot id')),
    u32(h.version),
    u64(h.number),
    hash32(h.entryHash),
    u64(h.lastPublic.number),
    hash32(h.lastPublic.hash),
    hash32(h.manifestHash),
  );
}

export function readSnapshotHeader(bytes: Uint8Array): SnapshotHeader {
  const r = new Reader(bytes);
  r.magic('LLN1');
  const budgetId = r.text(26);
  const snapshotId = r.text(26);
  const version = r.u32();
  const number = r.u64();
  const entryHash = r.take(32);
  const lastPublic = { number: r.u64(), hash: r.take(32) };
  const manifestHash = r.take(32);
  r.end();
  if (!isUlid(budgetId) || !isUlid(snapshotId)) throw new FormatError('id');
  const h = { budgetId, snapshotId, version, number, entryHash, lastPublic, manifestHash };
  const fault = headerFault(h);
  if (fault) throw new FormatError(fault);
  return h;
}

const headerMessage = async (header: Uint8Array): Promise<Bytes> =>
  concat(label('ledgerline/v1/snap'), await sha256(header));
const checkMessage = async (header: Uint8Array, deviceId: string): Promise<Bytes> =>
  concat(label('ledgerline/v1/snap-checked'), await sha256(header), str(ulid(deviceId, 'device id')));

/** A stored value that couldn't have been signed at all simply doesn't verify. */
async function verifies(
  message: () => Promise<Bytes>,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean> {
  let m: Bytes;
  try {
    m = await message();
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
  return verify(signPub, m, signature);
}

/** Whether a snapshot header's signature is good for the signing key of its key version. */
export async function verifySnapshotHeader(
  header: Uint8Array,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean> {
  return verifies(() => headerMessage(header), signature, signPub);
}

/** A snapshot as stored. */
export interface SealedSnapshot {
  header: Bytes;
  signature: Bytes;
  manifest: Bytes;
  chunks: Bytes[];
}

/**
 * The check record: this device rebuilt the budget from the snapshot before plus the entries since, and got the same.
 * It is signed only for a header that is this budget's and carries a good signature of its own.
 */
export async function signSnapshotCheck(
  keys: BudgetKeys,
  s: Pick<SealedSnapshot, 'header' | 'signature'>,
  budgetId: string,
  deviceId: string,
): Promise<Bytes> {
  const header = readSnapshotHeader(s.header);
  if (header.budgetId !== budgetId) throw new RangeError('another budget');
  if (header.version !== keys.version) throw new RangeError('key version');
  if (!(await verifySnapshotHeader(s.header, s.signature, keys.sign.pub)))
    throw new RangeError('header signature');
  return sign(keys.sign.privateKey, await checkMessage(s.header, deviceId));
}

export async function verifySnapshotCheck(
  header: Uint8Array,
  deviceId: string,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean> {
  return verifies(() => checkMessage(header, deviceId), signature, signPub);
}

/** Seals a snapshot: the chunks, the manifest that names them, and the signed header that names the manifest. */
export async function sealSnapshot(
  keys: BudgetKeys,
  at: {
    budgetId: string;
    snapshotId: string;
    number: number;
    entryHash: Bytes;
    lastPublic: PublicRef;
    tables: Manifest['tables'];
    checkpoints: PublicRef[];
    position: SnapshotPosition;
  },
  plainChunks: Uint8Array[],
): Promise<SealedSnapshot> {
  if (plainChunks.length < 1) throw new RangeError('chunk count');
  // Everything a reader would refuse is refused here, before anything is sealed.
  const shape: Manifest = {
    snapshotId: at.snapshotId,
    version: keys.version,
    number: at.number,
    entryHash: at.entryHash,
    chunkHashes: plainChunks.map(() => new Uint8Array(32) as Bytes),
    tables: at.tables,
    checkpoints: at.checkpoints,
    position: at.position,
  };
  encodeManifest(shape);
  encodeSnapshotHeader({ ...at, version: keys.version, manifestHash: new Uint8Array(32) as Bytes });

  const chunks: Bytes[] = [];
  for (let k = 0; k < plainChunks.length; k++)
    chunks.push(
      await sealChunk(keys, at.budgetId, at.snapshotId, k + 1, plainChunks.length, plainChunks[k]!),
    );
  const chunkHashes: Bytes[] = [];
  for (const c of chunks) chunkHashes.push(await sha256(c));
  const manifest = await aeadSeal(
    keys.snapshot,
    manifestAad(at.budgetId, at.snapshotId),
    encodeManifest({ ...shape, chunkHashes }),
  );
  const header = encodeSnapshotHeader({
    budgetId: at.budgetId,
    snapshotId: at.snapshotId,
    version: keys.version,
    number: at.number,
    entryHash: at.entryHash,
    lastPublic: at.lastPublic,
    manifestHash: await sha256(manifest),
  });
  return {
    header,
    manifest,
    chunks,
    signature: await sign(keys.sign.privateKey, await headerMessage(header)),
  };
}

/** A snapshot that doesn't hold together, or doesn't fit what the device knows of the chain. */
export class SnapshotError extends Error {
  constructor(readonly why: string) {
    super(`snapshot: ${why}`);
  }
}

/** What a device knows that a snapshot must agree with. */
export interface SnapshotBounds {
  /**
   * The public entries the device walked (chain.ts `PublicState.publics`). The snapshot must name one of them as its
   * last public entry, be sealed under the key version that was in force after it, and stand before the next one.
   * This is what stops a snapshot signed with a key version that was since replaced.
   */
  publics: { number: number; hash: Uint8Array; keyVersion: number }[];
  /** The highest entry this device has applied: a snapshot that stands before it is an older one shown as the newest. */
  minNumber?: number;
  /** A checkpoint this device remembers: the snapshot's chain must hold it. */
  checkpoint?: PublicRef;
}

/**
 * Opens the manifest of a snapshot: the header against what the device knows of the chain; its signature against the
 * signing key of its key version (`keys` are that version's, which the caller gets from the chain); then the
 * manifest the header names, which must say the same as the header.
 */
export async function openSnapshotManifest(
  keys: BudgetKeys,
  s: Pick<SealedSnapshot, 'header' | 'signature' | 'manifest'>,
  budgetId: string,
  bounds: SnapshotBounds,
): Promise<{ header: SnapshotHeader; manifest: Manifest }> {
  let header: SnapshotHeader;
  try {
    header = readSnapshotHeader(s.header);
  } catch (e) {
    if (e instanceof FormatError) throw new SnapshotError(`header: ${e.message}`);
    throw e;
  }
  if (header.budgetId !== budgetId) throw new SnapshotError('another budget');
  const at = bounds.publics.findIndex((p) => p.number === header.lastPublic.number);
  const named = bounds.publics[at];
  if (!named || !equal(named.hash, header.lastPublic.hash))
    throw new SnapshotError('not on the public chain');
  if (named.keyVersion !== header.version) throw new SnapshotError('not the key version in force there');
  const next = bounds.publics[at + 1];
  if (next && next.number <= header.number) throw new SnapshotError('a later public entry comes before it');
  if (bounds.minNumber !== undefined && header.number < bounds.minNumber)
    throw new SnapshotError('older than this device');
  if (header.version !== keys.version) throw new SnapshotError('key version');
  if (!(await verifySnapshotHeader(s.header, s.signature, keys.sign.pub)))
    throw new SnapshotError('signature');
  if (!equal(await sha256(s.manifest), header.manifestHash)) throw new SnapshotError('manifest hash');
  let manifest: Manifest;
  try {
    manifest = readManifest(
      await aeadOpen(keys.snapshot, manifestAad(budgetId, header.snapshotId), s.manifest),
    );
  } catch (e) {
    if (e instanceof FormatError || e instanceof OpenError) throw new SnapshotError(`manifest: ${e.message}`);
    throw e;
  }
  if (
    manifest.snapshotId !== header.snapshotId ||
    manifest.version !== header.version ||
    manifest.number !== header.number ||
    !equal(manifest.entryHash, header.entryHash)
  )
    throw new SnapshotError('the manifest and the header differ');
  const c = bounds.checkpoint;
  if (c && !manifest.checkpoints.some((x) => x.number === c.number && equal(x.hash, c.hash)))
    throw new SnapshotError('the checkpoint this device remembers is missing');
  return { header, manifest };
}

/** Opens one chunk of a snapshot whose manifest is open: the stored bytes must be the ones the manifest names. */
export async function openSnapshotChunk(
  keys: BudgetKeys,
  budgetId: string,
  manifest: Manifest,
  k: number,
  sealed: Uint8Array,
): Promise<Bytes> {
  const count = manifest.chunkHashes.length;
  if (!Number.isInteger(k) || k < 1 || k > count) throw new SnapshotError('chunk number');
  if (!equal(await sha256(sealed), manifest.chunkHashes[k - 1]!)) throw new SnapshotError('chunk hash');
  try {
    return await openChunk(keys, budgetId, manifest.snapshotId, k, count, sealed);
  } catch (e) {
    if (e instanceof OpenError) throw new SnapshotError('a chunk does not open');
    throw e;
  }
}
