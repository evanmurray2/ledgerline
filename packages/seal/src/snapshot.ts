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
import { aeadOpen, aeadSeal } from './aead.js';
import type { BudgetKeys } from './budget-key.js';
import { sign, verify } from './curve.js';
import type { PublicRef } from './entry.js';
import { sha256 } from './hash.js';

export const MAX_TABLES = 4096;
export const MAX_TABLE_NAME = 255;
export const MAX_CHECKPOINTS = 65535;
/** Every entry whose number is a multiple of this is a checkpoint. */
export const CHECKPOINT_EVERY = 1000;

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
  checkpoints: PublicRef[];
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
export function sealChunk(
  keys: BudgetKeys,
  budgetId: string,
  snapshotId: string,
  k: number,
  count: number,
  plain: Uint8Array,
): Promise<Bytes> {
  return aeadSeal(keys.snapshot, chunkAad(budgetId, snapshotId, k, count), plain);
}

export function openChunk(
  keys: BudgetKeys,
  budgetId: string,
  snapshotId: string,
  k: number,
  count: number,
  sealed: Uint8Array,
): Promise<Bytes> {
  return aeadOpen(keys.snapshot, chunkAad(budgetId, snapshotId, k, count), sealed);
}

export function encodeManifest(m: Manifest): Bytes {
  if (m.chunkHashes.length < 1 || m.chunkHashes.length > 0xffffffff) throw new RangeError('chunk count');
  if (m.tables.length > MAX_TABLES || m.checkpoints.length > MAX_CHECKPOINTS) throw new RangeError('count');
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
  r.end();
  if (version < 1 || number < 1) throw new FormatError('version');
  return { snapshotId, version, number, entryHash, chunkHashes, tables, checkpoints };
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

export function encodeSnapshotHeader(h: SnapshotHeader): Bytes {
  if (!Number.isInteger(h.version) || h.version < 1) throw new RangeError('key version');
  if (h.number < 1 || h.lastPublic.number < 1 || h.lastPublic.number > h.number)
    throw new RangeError('number');
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
  if (version < 1 || number < 1 || lastPublic.number < 1 || lastPublic.number > number)
    throw new FormatError('number');
  return { budgetId, snapshotId, version, number, entryHash, lastPublic, manifestHash };
}

const headerMessage = async (header: Uint8Array): Promise<Bytes> =>
  concat(label('ledgerline/v1/snap'), await sha256(header));
const checkMessage = async (header: Uint8Array, deviceId: string): Promise<Bytes> =>
  concat(label('ledgerline/v1/snap-checked'), await sha256(header), str(ulid(deviceId, 'device id')));

/** Whether a snapshot header's signature is good for the signing key of its key version. */
export async function verifySnapshotHeader(
  header: Uint8Array,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean> {
  return verify(signPub, await headerMessage(header), signature);
}

/** The check record: this device rebuilt the budget from the snapshot before plus the entries since, and got the same. */
export async function signSnapshotCheck(
  keys: BudgetKeys,
  header: Uint8Array,
  deviceId: string,
): Promise<Bytes> {
  if (readSnapshotHeader(header).version !== keys.version) throw new RangeError('key version');
  return sign(keys.sign.privateKey, await checkMessage(header, deviceId));
}

export async function verifySnapshotCheck(
  header: Uint8Array,
  deviceId: string,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean> {
  return verify(signPub, await checkMessage(header, deviceId), signature);
}

/** A snapshot as stored. */
export interface SealedSnapshot {
  header: Bytes;
  signature: Bytes;
  manifest: Bytes;
  chunks: Bytes[];
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
  },
  plainChunks: Uint8Array[],
): Promise<SealedSnapshot> {
  if (plainChunks.length < 1) throw new RangeError('chunk count');
  const chunks: Bytes[] = [];
  for (let k = 0; k < plainChunks.length; k++)
    chunks.push(
      await sealChunk(keys, at.budgetId, at.snapshotId, k + 1, plainChunks.length, plainChunks[k]!),
    );
  const m = encodeManifest({
    snapshotId: at.snapshotId,
    version: keys.version,
    number: at.number,
    entryHash: at.entryHash,
    chunkHashes: await Promise.all(chunks.map((c) => sha256(c))),
    tables: at.tables,
    checkpoints: at.checkpoints,
  });
  const manifest = await aeadSeal(keys.snapshot, manifestAad(at.budgetId, at.snapshotId), m);
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

/** A snapshot that doesn't hold together: the header, the manifest and the chunks don't name each other. */
export class SnapshotError extends Error {
  constructor(why: string) {
    super(`snapshot: ${why}`);
  }
}

/**
 * Opens the manifest of a snapshot: the header's signature against the signing key the chain names for its key
 * version, then the manifest the header names, which must say the same as the header.
 */
export async function openSnapshotManifest(
  keys: BudgetKeys,
  s: Pick<SealedSnapshot, 'header' | 'signature' | 'manifest'>,
  budgetId: string,
): Promise<{ header: SnapshotHeader; manifest: Manifest }> {
  const header = readSnapshotHeader(s.header);
  if (header.budgetId !== budgetId) throw new SnapshotError('another budget');
  if (header.version !== keys.version) throw new SnapshotError('key version');
  if (!(await verifySnapshotHeader(s.header, s.signature, keys.sign.pub)))
    throw new SnapshotError('signature');
  if (!equal(await sha256(s.manifest), header.manifestHash)) throw new SnapshotError('manifest hash');
  const manifest = readManifest(
    await aeadOpen(keys.snapshot, manifestAad(budgetId, header.snapshotId), s.manifest),
  );
  if (
    manifest.snapshotId !== header.snapshotId ||
    manifest.version !== header.version ||
    manifest.number !== header.number ||
    !equal(manifest.entryHash, header.entryHash)
  )
    throw new SnapshotError('the manifest and the header differ');
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
  if (!Number.isInteger(k) || k < 1 || k > count) throw new RangeError('chunk number');
  if (!equal(await sha256(sealed), manifest.chunkHashes[k - 1]!)) throw new SnapshotError('chunk hash');
  return openChunk(keys, budgetId, manifest.snapshotId, k, count, sealed);
}
