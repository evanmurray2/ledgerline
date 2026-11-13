// A change set: the sealed body of a log entry of kind edit, bank, scan or data migration (local/device-log.ts).
// The plain body of a sealed entry (privacy-keys.md 6.2 left its inner layout to this phase) is UTF-8 JSON:
//   { "v": 1, "at": <ms>, "rows": [{ "t": table, "k": [key values], "d": row or null }], "seen": { device: [number, hash] } }
// `at` is the time the person made the edit (or the bank update's or scan's time); `rows` are the changed rows as
// they are after it, in the order they last changed (LocalEngine.record); `seen` is the last entry this device
// has taken from each other device, so that two branches shown to two devices come to light (5.3, "a fork").
// A body over 65,535 bytes is cut into parts (6.4): the bytes of the JSON, in order.
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
