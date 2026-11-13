// A change set: the sealed body of a log entry of kind edit, bank, scan or data migration (local/device-log.ts).
// The plain body of a sealed entry (privacy-keys.md 6.2 left its inner layout to this phase) is UTF-8 JSON:
//   { "v": 1, "at": <ms>, "rows": [{ "t": table, "k": [key values], "d": row or null }], "seen": { device: [number, hash] } }
// `at` is the time the person made the edit (or the bank update's or scan's time); `rows` are the changed rows as
// they are after it, in the order they last changed (LocalEngine.record); `seen` is the last entry this device
// has taken from each other device, so that two branches shown to two devices come to light (5.3, "a fork").
// A body over 65,535 bytes is cut into parts (6.4): the bytes of the body, in order.
//
// Compressed (schema version 3, Nov 13, 2026; D-104): a change set whose JSON needs more than one part is
// compressed before it is sealed (sealed bytes don't compress), so that a bank run of a long history fits the 16
// parts of one write. Its body is one byte 0x01, the length of the JSON (4 bytes, big-endian), then the JSON as
// raw deflate (RFC 1951, `CompressionStream('deflate-raw')`, built into browsers and Workers). A plain body is
// the JSON itself and starts with `{`. Its entries carry schema version 3, so an app that knows only 2 stops and
// asks for an update (packages/seal chain.ts `UpdateNeededError`) before it opens the body; nothing is filed or
// skipped. A set that fits one part stays plain under version 2, so every edit and daily run still reads on an
// app from before.
import { KIND, type Bytes } from '@ledgerline/seal';
import type { SyncRow } from '../sync-tables.js';

/** What one sealed entry (or part set) carries. */
export interface ChangeSet {
  v: 1;
  at: number;
  rows: SyncRow[];
  seen: Record<string, [number, string]>;
}

/** The kinds of entry whose body is a change set. */
export type ChangeKind = typeof KIND.edit | typeof KIND.bank | typeof KIND.scan;

export class LogFormatError extends Error {}

export function encodeChangeSet(c: ChangeSet): Bytes {
  return new TextEncoder().encode(JSON.stringify(c)) as Bytes;
}

export function decodeChangeSet(bytes: Uint8Array): ChangeSet {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new LogFormatError('not a change set');
  }
  const c = v as Partial<ChangeSet> | null;
  const row = (r: unknown): r is SyncRow => {
    const x = r as Partial<SyncRow> | null;
    return (
      !!x &&
      typeof x.t === 'string' &&
      Array.isArray(x.k) &&
      (x.d === null || (typeof x.d === 'object' && !Array.isArray(x.d)))
    );
  };
  if (!c || c.v !== 1 || !Number.isSafeInteger(c.at) || !Array.isArray(c.rows) || !c.rows.every(row))
    throw new LogFormatError('not a change set');
  const seen = c.seen as unknown;
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) throw new LogFormatError('not a change set');
  for (const v of Object.values(seen as Record<string, unknown>))
    if (!Array.isArray(v) || v.length !== 2 || !Number.isSafeInteger(v[0]) || typeof v[1] !== 'string')
      throw new LogFormatError('not a change set');
  return c as ChangeSet;
}

/** The first byte of a compressed change set. A plain one is JSON and starts with `{`. */
const DEFLATED = 0x01;
/**
 * The most bytes a compressed change set may open to: a bound on the memory one entry can take, far above what 16
 * parts hold (deflate makes rows like these 5 to 10 times smaller).
 */
export const MAX_SET_BYTES = 64 * 1024 * 1024;

/** Whether this runtime compresses (every browser since 2023, and Workers). Without it, sets stay plain. */
export const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

/** All of a stream's bytes, refused past `max`. */
async function drain(readable: ReadableStream<Uint8Array>, max: number): Promise<Bytes> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new LogFormatError('a compressed change set too large to open');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out as Bytes;
}

/** Runs `bytes` through a compression or decompression stream. */
async function through(
  stream: CompressionStream | DecompressionStream,
  bytes: Uint8Array,
  max: number,
): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  // Not awaited before reading: the stream holds back the write until its output is read.
  const written = writer.write(bytes).then(() => writer.close());
  written.catch(() => undefined);
  const out = await drain(stream.readable, max);
  await written;
  return out;
}

/** A change set's JSON (`encodeChangeSet`), compressed: the body of an entry of schema version 3. */
export async function deflateChangeSet(plain: Uint8Array): Promise<Bytes> {
  const packed = await through(new CompressionStream('deflate-raw'), plain, Infinity);
  const out = new Uint8Array(5 + packed.length);
  out[0] = DEFLATED;
  new DataView(out.buffer).setUint32(1, plain.length);
  out.set(packed, 5);
  return out as Bytes;
}

/**
 * A change set from a whole body, plain or compressed. `schemaVersion`: the version its entries carry; only 3 and
 * later may be compressed. Throws `LogFormatError`.
 */
export async function openChangeSet(body: Uint8Array, schemaVersion: number): Promise<ChangeSet> {
  if (body[0] !== DEFLATED) return decodeChangeSet(body);
  if (schemaVersion < 3 || body.length < 5) throw new LogFormatError('not a change set');
  const size = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(1);
  if (size > MAX_SET_BYTES) throw new LogFormatError('a compressed change set too large to open');
  if (!canCompress()) throw new LogFormatError('this browser can’t open a compressed change set');
  let plain: Bytes;
  try {
    plain = await through(new DecompressionStream('deflate-raw'), body.subarray(5), size);
  } catch (x) {
    if (x instanceof LogFormatError) throw x;
    throw new LogFormatError('not a change set');
  }
  if (plain.length !== size) throw new LogFormatError('not a change set');
  return decodeChangeSet(plain);
}
