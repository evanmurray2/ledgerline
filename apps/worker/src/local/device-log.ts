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
  fromHex,
  fromStored,
  openEntryBody,
  openInbox,
  openSnapshotChunk,
  openSnapshotManifest,
  sealSnapshot,
  signSnapshotCheck,
  randomBytes,
  sealedEntry,
  toHex,
  type BudgetKeys,
  type Bytes,
  type ChainState,
  type DhPair,
  type PublicRef,
  type PublicState,
  type SealedSnapshot,
  type SnapshotHeader,
  type SnapshotManifest,
  type Entry,
  type FullChainState,
  sha256,
  toStored,
} from '@ledgerline/seal';
import type { SyncRow } from '../sync-tables.js';
import { stateFromJson, stateToJson } from '../seal/log-store.js';
import { LOG_PROCESSING_VERSION, LOG_SCHEMA_VERSION } from '../seal/log-versions.js';

/** A snapshot's manifest lists the hash of every entry whose number is a multiple of this (privacy-keys.md 8). */
const CHECKPOINT_EVERY = 1000;

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
  /** The id its entries share, hex: for a device's own change, the id `entryIdOf` gives its edit. */
  entryId: string;
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

/**
 * The entry id of a change this device made, from the change's own id (an edit's id, or a filed set of bank
 * runs'). The same change always gets the same entry id: sent again after a lost answer, the server says it holds
 * it already, and when the entry comes back from the log the device knows its own change and does not run it
 * twice.
 */
export async function entryIdOf(changeId: string): Promise<Bytes> {
  return (await sha256(new TextEncoder().encode(`ledgerline/v1/entry-id\u0000${changeId}`))).slice(
    0,
    16,
  ) as Bytes;
}

/** A change set too large for one write of the log (16 parts, about 1 MB). */
export class TooLarge extends Error {}

/**
 * The server showed this device a history that is not the one it saw (docs/privacy.md 5.3, "A lying server";
 * privacy-keys.md 7.2): an entry that does not continue its place, a log that does not pass through an entry it
 * remembers, or an entry whose writer says it saw another entry at a number this device knows. `older`: the log
 * ends before the place this device had reached. Nothing of it was written; the device stops.
 */
export class LogFork extends Error {
  constructor(
    readonly why: string,
    readonly older = false,
  ) {
    super(`The server showed this device a different history (${why}). Nothing was changed.`);
  }
}

/** The entries this device needs next are gone from the server (a checked snapshot covers them): it opens one. */
export class BelowFloor extends Error {
  constructor(readonly number: number) {
    super('the entries after this device’s place are gone from the server');
  }
}

/** This device's own entries it remembers, newest last: enough to tell a writer that saw another one. */
const OWN_KEPT = 64;

const hexEq = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A device writing to, and reading from, one budget's log. */
export class DeviceLog {
  /** The last entry taken from each other device. */
  private seen = new Map<string, [number, string]>();
  /** This device's own last entries, number to hash (hex), at most `OWN_KEPT`. */
  private own = new Map<number, string>();
  /**
   * Entries the log must pass through, number to hash (hex): what this device saw before it was made again from a
   * snapshot (`remember`). Each is checked as the device reads past it, then dropped.
   */
  private pass = new Map<number, string>();
  /** The parts of a change set that is not whole yet. */
  private parts: Bytes[] = [];
  /** The budget's keys by key version: an entry is opened with the keys of its own version. */
  private readonly keys: Map<number, BudgetKeys>;

  /**
   * The hash of every entry whose number is a multiple of 1,000, as far as this device knows them: what a
   * snapshot's manifest lists, so that a device can tell its chain is the one a snapshot stands on (8).
   */
  private checkpoints: PublicRef[];

  constructor(
    keys: BudgetKeys | readonly BudgetKeys[],
    private state: ChainState,
    readonly deviceId: string,
    private readonly clock: () => number,
    /** The checkpoints before this device's place (from the snapshot it started at; none for a log read from its start). */
    checkpoints: readonly PublicRef[] = [],
  ) {
    this.keys = new Map((Array.isArray(keys) ? keys : [keys as BudgetKeys]).map((k) => [k.version, k]));
    this.checkpoints = [...checkpoints];
  }

  /**
   * Where this device stands, as a snapshot names it: the last entry taken, the last public entry, each device's
   * counter, and the checkpoints with this entry last. `whole`: the entry ends its part set (a snapshot never
   * stands inside one).
   */
  place(): {
    number: number;
    hash: Bytes;
    lastPublic: PublicRef;
    counters: { deviceId: string; counter: number }[];
    checkpoints: PublicRef[];
    whole: boolean;
  } {
    const s = this.state as FullChainState;
    const here = { number: s.number, hash: s.hash };
    return {
      ...here,
      lastPublic: (s.public as unknown as PublicState).lastPublic,
      counters: [...s.counters.entries()]
        .map(([deviceId, counter]) => ({ deviceId, counter }))
        .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
      checkpoints: [...this.checkpoints.filter((c) => c.number < s.number), here],
      whole: this.parts.length === 0 && s.pending === null,
    };
  }

  /** Seals a snapshot of this device's base, standing at its place in the log. */
  async sealSnapshot(
    snapshotId: string,
    tables: { name: string; hash: Bytes }[],
    plainChunks: Uint8Array[],
  ): Promise<SealedSnapshot> {
    const at = this.place();
    if (!at.whole) throw new LogFormatError('a snapshot never stands inside a part set');
    return sealSnapshot(
      this.current(),
      {
        budgetId: this.budgetId,
        snapshotId,
        number: at.number,
        entryHash: at.hash,
        lastPublic: at.lastPublic,
        tables,
        checkpoints: at.checkpoints,
        counters: at.counters,
      },
      plainChunks,
    );
  }

  /**
   * Opens the manifest of a snapshot against what this device knows of the chain (8, the six checks): the public
   * entries it walked and, with `notOlder`, its own place. Throws `SnapshotError`.
   */
  async openManifest(
    s: Pick<SealedSnapshot, 'header' | 'signature' | 'manifest'>,
    version: number,
    o: { notOlder?: boolean } = {},
  ): Promise<{ header: SnapshotHeader; manifest: SnapshotManifest }> {
    const keys = this.keys.get(version);
    if (!keys) throw new LogFormatError(`this device does not hold key version ${version}`);
    const last = this.checkpoints[this.checkpoints.length - 1];
    return openSnapshotManifest(keys, s, this.budgetId, {
      publics: (this.state.public as unknown as PublicState).publics,
      ...(o.notOlder ? { minNumber: this.state.number, ...(last ? { checkpoint: last } : {}) } : {}),
    });
  }

  /** Opens chunk `k` (from 1) of a snapshot whose manifest is open. */
  async openChunk(manifest: SnapshotManifest, k: number, sealed: Uint8Array): Promise<Bytes> {
    const keys = this.keys.get(manifest.version);
    if (!keys) throw new LogFormatError(`this device does not hold key version ${manifest.version}`);
    return openSnapshotChunk(keys, this.budgetId, manifest, k, sealed);
  }

  /** This device's check record for a snapshot it rebuilt (8). */
  async signCheck(s: Pick<SealedSnapshot, 'header' | 'signature'>): Promise<Bytes> {
    // With the key in force: the server takes a check record under no other (a removed way in can't check).
    return signSnapshotCheck(this.current(), s, this.budgetId, this.deviceId);
  }

  /**
   * This device's place in the log, as text to keep with its copy: the chain, a part set that is half read, the
   * last entry seen from each other device, and the checkpoints. No key is in it.
   */
  save(): string {
    return JSON.stringify({
      v: 1,
      state: stateToJson(toStored(this.state)),
      parts: this.parts.map((p) => toHex(p)),
      seen: [...this.seen.entries()],
      checkpoints: this.checkpoints.map((c) => [c.number, toHex(c.hash)]),
      own: [...this.own.entries()],
      pass: [...this.pass.entries()],
    });
  }

  /**
   * What this device saw of the log, for a copy made again from a snapshot: its place, its own last entries and
   * the last entry of each other device. `remember` makes them entries the new place's log must pass through.
   */
  saw(): {
    place: PublicRef;
    counters: Map<string, number>;
    points: [number, string][];
    seen: [string, [number, string]][];
  } {
    const s = this.state as FullChainState;
    const points = new Map<number, string>([...this.pass, ...this.own]);
    for (const [n, h] of this.seen.values()) points.set(n, h);
    points.set(s.number, toHex(s.hash));
    return {
      place: { number: s.number, hash: s.hash },
      counters: new Map(s.counters),
      points: [...points.entries()].sort((a, b) => a[0] - b[0]),
      seen: [...this.seen.entries()],
    };
  }

  /**
   * Takes what a device saw before (`saw`) into this log: the points past this place become entries the log must
   * pass through, and the last entry seen of each other device is kept. Throws `LogFork` for a point at or before
   * this place that this log knows otherwise (its place, a checkpoint).
   */
  remember(before: ReturnType<DeviceLog['saw']>): void {
    const known = new Map<number, string>(this.checkpoints.map((c) => [c.number, toHex(c.hash)]));
    known.set(this.state.number, toHex(this.state.hash));
    for (const [n, h] of before.points) {
      if (n > this.state.number) this.pass.set(n, h);
      else if (known.has(n) && known.get(n) !== h) throw new LogFork(`entry ${n} is not the one it was`);
    }
    for (const [d, v] of before.seen)
      if (!this.seen.has(d) || this.seen.get(d)![0] < v[0]) this.seen.set(d, v);
  }

  /** The highest entry this log must still pass through (0: none). */
  get mustReach(): number {
    return Math.max(0, ...this.pass.keys());
  }

  /** A device's place in the log as `save` wrote it, with the keys the device holds now. */
  static async restore(
    keys: BudgetKeys | readonly BudgetKeys[],
    saved: string,
    deviceId: string,
    clock: () => number,
  ): Promise<DeviceLog> {
    let v: {
      v?: unknown;
      state?: unknown;
      parts?: unknown;
      seen?: unknown;
      checkpoints?: unknown;
      own?: unknown;
      pass?: unknown;
    };
    try {
      v = JSON.parse(saved) as typeof v;
    } catch {
      throw new LogFormatError('not a saved place in the log');
    }
    if (
      v.v !== 1 ||
      typeof v.state !== 'string' ||
      !Array.isArray(v.parts) ||
      !Array.isArray(v.seen) ||
      !Array.isArray(v.checkpoints)
    )
      throw new LogFormatError('not a saved place in the log');
    const log = new DeviceLog(
      keys,
      await fromStored(stateFromJson(v.state)),
      deviceId,
      clock,
      (v.checkpoints as [number, string][]).map(([number, hash]) => ({ number, hash: fromHex(hash) })),
    );
    log.parts = (v.parts as string[]).map((p) => fromHex(p));
    log.seen = new Map(v.seen as [string, [number, string]][]);
    // Kept since Nov 13, 2026: a place saved before has none.
    if (Array.isArray(v.own)) log.own = new Map(v.own as [number, string][]);
    if (Array.isArray(v.pass)) log.pass = new Map(v.pass as [number, string][]);
    return log;
  }

  /**
   * Where a public entry this device writes goes (a slot change, a key change, an intent or a cancel, made by the
   * app with the budget key in hand: apps/web/src/keys/changes.ts `LogPlace`): on top of the last entry taken,
   * with this device's next counter, a time after the entry before, and the public entry it must name.
   */
  writePlace(): {
    number: number;
    hash: Bytes;
    deviceId: string;
    deviceCounter: number;
    filedThrough: number;
    scanThrough: number;
    time: number;
    lastPublic: PublicRef;
    keyVersion: number;
    whole: boolean;
  } {
    const s = this.state as FullChainState;
    return {
      number: s.number,
      hash: s.hash,
      deviceId: this.deviceId,
      deviceCounter: s.counters.get(this.deviceId) ?? 0,
      filedThrough: s.filedThrough,
      scanThrough: s.scanThrough,
      time: Math.max(this.clock(), s.time + 1),
      lastPublic: this.publicState.lastPublic,
      keyVersion: s.public.keyVersion,
      whole: this.parts.length === 0 && s.pending === null,
    };
  }

  /**
   * Takes keys of more versions: the new version a key change made on this device brings (the app made it, and
   * hands its derived keys over). Keys held already stay.
   */
  holdKeys(keys: readonly BudgetKeys[]): void {
    for (const k of keys) if (!this.keys.has(k.version)) this.keys.set(k.version, k);
  }

  /** The keys this device holds, by version: for a second log over the same budget (a snapshot's check). */
  keysHeld(): BudgetKeys[] {
    return [...this.keys.values()];
  }

  /** What the public entries say, as this device has walked them. */
  get publicState(): PublicState {
    return this.state.public as unknown as PublicState;
  }

  /** The number of the last entry this device has taken. */
  get number(): number {
    return this.state.number;
  }

  /** The day (days since 1970, UTC) of the last daily scan the log holds; 0 for none. */
  get scanThrough(): number {
    return (this.state as FullChainState).scanThrough;
  }

  /** The last bank run the log says is filed. */
  get filedThrough(): number {
    return (this.state as FullChainState).filedThrough;
  }

  get budgetId(): string {
    return this.state.public.budgetId;
  }

  /** What the log says about inbox keys: the version in force, and the last run each replaced version may hold. */
  get inboxes(): { inboxVersion: number; retiredAt: Map<number, number> } {
    const p = this.state.public;
    return { inboxVersion: p.inboxVersion, retiredAt: p.retiredAt as Map<number, number> };
  }

  /**
   * The inbox pair of a version, opened from the wrapped private half the log carries; null when the log
   * carries none for it (the key was retired) or it doesn't open with this device's keys.
   */
  async inbox(version: number): Promise<DhPair | null> {
    const wrapped = (this.state.public.inboxes as Map<number, Bytes>).get(version);
    if (!wrapped) return null;
    try {
      return await openInbox(this.current(), this.budgetId, version, wrapped);
    } catch {
      return null;
    }
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
    over: { filedThrough?: number; receipts?: Bytes[]; scanThrough?: number; entryId?: Bytes } = {},
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
    const entryId = over.entryId ?? randomBytes(16);
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
    const own = new Map(this.own);
    const pass = new Map(this.pass);
    const checkpoints = [...this.checkpoints];
    const sets: Taken[] = [];
    // What this device knows of the log by number: a writer that says it saw something else there saw another log.
    const knownAt = (n: number): string | undefined => {
      if (n === state.number) return toHex(state.hash);
      const c = checkpoints.find((x) => x.number === n);
      if (c) return toHex(c.hash);
      if (own.has(n)) return own.get(n);
      for (const [num, h] of seen.values()) if (num === n) return h;
      return undefined;
    };
    for (const e of entries) {
      const h = e.header;
      // Before the log's own rules: an entry past a gap means the entries between are gone (a snapshot covers
      // them), and one that does not continue this place is another history.
      if (h.number > state.number + 1) throw new BelowFloor(state.number);
      if (h.number === state.number + 1 && !hexEq(h.prevHash, state.hash))
        throw new LogFork(`entry ${h.number} does not follow entry ${state.number}`);
      state = await advance(state, e, { now: this.clock(), schemaVersion: LOG_SCHEMA_VERSION });
      const remembered = pass.get(h.number);
      if (remembered !== undefined) {
        if (remembered !== toHex(e.hash)) throw new LogFork(`entry ${h.number} is not the one it was`);
        pass.delete(h.number);
      }
      if (h.deviceId === this.deviceId) {
        own.set(h.number, toHex(e.hash));
        if (own.size > OWN_KEPT) own.delete(own.keys().next().value!);
      }
      if (h.number % CHECKPOINT_EVERY === 0) checkpoints.push({ number: h.number, hash: e.hash });
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
      const set = decodeChangeSet(whole);
      // What its writer last saw from each device (5.3, "a fork"): at a number this device knows, the same entry.
      if (h.deviceId !== this.deviceId)
        for (const [d, [n, hash]] of Object.entries(set.seen)) {
          const mine = knownAt(n);
          if (mine !== undefined && mine !== hash)
            throw new LogFork(`entry ${h.number} says it saw another entry ${n} from ${d}`);
        }
      sets.push({ number: h.number, entryId: toHex(h.entryId), kind: h.kind, deviceId: h.deviceId, set });
    }
    return {
      sets,
      number: state.number,
      commit: () => {
        this.state = state;
        this.parts = parts;
        this.seen = seen;
        this.own = own;
        this.pass = pass;
        this.checkpoints = checkpoints;
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
