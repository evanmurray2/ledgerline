// A device's side of the sealed log (docs/privacy.md 5.3; docs/privacy-keys.md 6): it turns the rows an edit, a
// bank update or a scan changed into signed, sealed entries, and turns the entries of other devices back into
// rows. An entry holds results, not operations: a device that takes one writes its rows and runs nothing.
//
// The plain body of a sealed entry (privacy-keys.md 6.2 left its inner layout to this phase) is UTF-8 JSON:
//   { "v": 1, "at": <ms>, "rows": [{ "t": table, "k": [key values], "d": row or null }], "seen": { device: [number, hash] } }
// `at` is the time the person made the edit (or the bank update's or scan's time); `rows` are the changed rows as
// they are after it, in the order they last changed (LocalEngine.record); `seen` is the last entry this device
// has taken from each other device, so that two branches shown to two devices come to light (5.3, "a fork").
// A body over 65,535 bytes is cut into parts (6.4): the bytes of the JSON, in order.
import {
  advance,
  KIND,
  MAX_PLAIN,
  MAX_WRITE_ENTRIES,
  openEntryBody,
  randomBytes,
  sealedEntry,
  toHex,
  type BudgetKeys,
  type Bytes,
  type ChainState,
  type Entry,
  type FullChainState,
} from '@ledgerline/seal';
import type { SyncRow } from '../routes/sync.js';
import { LOG_PROCESSING_VERSION, LOG_SCHEMA_VERSION } from '../seal/log-versions.js';

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

/** The kinds of entry whose sealed body is a change set (a data migration's rows are written like any other's). */
const CHANGE_KINDS: readonly number[] = [KIND.edit, KIND.bank, KIND.scan, KIND.dataMigration];

/** One whole change set of the log, with where it came from. */
export interface Taken {
  /** The number of its last entry (its only one, unless it came in parts). */
  number: number;
  kind: number;
  deviceId: string;
  set: ChangeSet;
}

/** Entries read and checked, not yet part of this device's place in the log. */
export interface Read {
  sets: Taken[];
  /** Where the log stands after them. */
  number: number;
  /** Makes them this device's place. Call it once their rows are in the copy. */
  commit(): void;
}

/** A change set too large for one write of the log (16 parts, about 1 MB). */
export class TooLarge extends Error {}

/** A device writing to, and reading from, one budget's log. */
export class DeviceLog {
  /** The last entry taken from each other device. */
  private seen = new Map<string, [number, string]>();
  /** The parts of a change set that is not whole yet. */
  private parts: Bytes[] = [];
  /** The budget's keys by key version: an entry is opened with the keys of its own version. */
  private readonly keys: Map<number, BudgetKeys>;

  constructor(
    keys: BudgetKeys | readonly BudgetKeys[],
    private state: ChainState,
    readonly deviceId: string,
    private readonly clock: () => number,
  ) {
    this.keys = new Map((Array.isArray(keys) ? keys : [keys as BudgetKeys]).map((k) => [k.version, k]));
  }

  /** The number of the last entry this device has taken. */
  get number(): number {
    return this.state.number;
  }

  /** The keys of the log's current key version. */
  private current(): BudgetKeys {
    const v = (this.state as FullChainState).public.keyVersion;
    const k = this.keys.get(v);
    if (!k) throw new LogFormatError(`this device does not hold key version ${v}`);
    return k;
  }

  /**
   * The entries for one change set, on top of the log as this device knows it: one entry, or a part set. They
   * are not taken: send them, and `take` them once the server has stored them (or read on, when it says "behind").
   */
  async build(
    kind: ChangeKind,
    set: { at: number; rows: SyncRow[] },
    over: { filedThrough?: number; receipts?: Bytes[]; scanThrough?: number } = {},
  ): Promise<Entry[]> {
    const s = this.state as FullChainState;
    const keys = this.current();
    const plain = encodeChangeSet({ v: 1, at: set.at, rows: set.rows, seen: Object.fromEntries(this.seen) });
    const chunks: Bytes[] = [];
    for (let i = 0; i < plain.length; i += MAX_PLAIN) chunks.push(plain.slice(i, i + MAX_PLAIN) as Bytes);
    // One write holds at most 16 entries, and a part set is never split over two writes (privacy-keys.md 7.2).
    if (chunks.length > MAX_WRITE_ENTRIES) throw new TooLarge('this change is too large for one write');
    // For ordering only: the later of this device's clock and one millisecond after the entry before (5.3 check 4).
    const time = Math.max(this.clock(), s.time + 1);
    const entryId = randomBytes(16);
    const counter = s.counters.get(this.deviceId) ?? 0;
    const out: Entry[] = [];
    let prev = { number: s.number, hash: s.hash };
    for (const [i, chunk] of chunks.entries()) {
      const e = await sealedEntry(
        {
          kind,
          budgetId: s.public.budgetId,
          number: prev.number + 1,
          prevHash: prev.hash,
          entryId,
          time,
          deviceId: this.deviceId,
          deviceCounter: counter + 1 + i,
          keyVersion: keys.version,
          schemaVersion: LOG_SCHEMA_VERSION,
          processingVersion: LOG_PROCESSING_VERSION,
          part: i + 1,
          parts: chunks.length,
          filedThrough: over.filedThrough ?? s.filedThrough,
          receipts: i === 0 ? (over.receipts ?? []) : [],
          scanThrough: over.scanThrough ?? s.scanThrough,
        },
        chunk,
        keys,
      );
      out.push(e);
      prev = { number: e.header.number, hash: e.hash };
    }
    return out;
  }

  /**
   * Reads the next entries of the log, in order, and changes nothing: each entry is checked by the log's rules
   * (the chain, the signature, the device's counter), each sealed body is opened with the keys of its version,
   * and each whole change set is given back. All of them pass, or this throws and the device stays where it was:
   * one bad entry among good ones never makes the device skip the good ones. Entries with a public body (a key
   * or slot change) move the chain and carry no rows.
   */
  async read(entries: readonly Entry[]): Promise<Read> {
    let state = this.state;
    let parts = [...this.parts];
    const seen = new Map(this.seen);
    const sets: Taken[] = [];
    for (const e of entries) {
      state = await advance(state, e, { now: this.clock(), schemaVersion: LOG_SCHEMA_VERSION });
      const h = e.header;
      if (!CHANGE_KINDS.includes(h.kind)) continue;
      const keys = this.keys.get(h.keyVersion);
      if (!keys) throw new LogFormatError(`this device does not hold key version ${h.keyVersion}`);
      parts.push(await openEntryBody(e, keys));
      if (h.deviceId !== this.deviceId) seen.set(h.deviceId, [h.number, toHex(e.hash)]);
      if (h.part < h.parts) continue;
      const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        whole.set(p, at);
        at += p.length;
      }
      parts = [];
      sets.push({ number: h.number, kind: h.kind, deviceId: h.deviceId, set: decodeChangeSet(whole) });
    }
    return {
      sets,
      number: state.number,
      commit: () => {
        this.state = state;
        this.parts = parts;
        this.seen = seen;
      },
    };
  }

  /** `read`, then make the entries this device's place at once: for a device's own entries the server stored. */
  async take(entries: readonly Entry[]): Promise<Taken[]> {
    const r = await this.read(entries);
    r.commit();
    return r.sets;
  }
}
