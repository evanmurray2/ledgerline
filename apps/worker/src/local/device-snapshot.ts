// A device's side of snapshots (docs/privacy.md 5.3; docs/privacy-keys.md 8): the base of a copy as sealed
// chunks, and a hash of every table, so that another device (or this one, in a fresh database) can rebuild the
// budget and compare.
//
// A chunk's plain text is UTF-8 JSON lines, one row a line, in the log's own row shape:
//   {"t": table, "k": [key values], "d": row}
// in the order of `SNAPSHOT_TABLES`, each table in key order. A row is never cut between chunks. A table's hash
// is a running SHA-256 over its lines in that order (zeros, then H(hash so far || line) for each row), so the hash
// a device works out from its own copy is the hash of what a snapshot of that copy holds.
//
// What a snapshot leaves out: what a copy works out for itself (budget lines, month totals, the worked-out
// columns of `budget`) and what only the server keeps (the omitted columns of a synced table).
import type { Db } from '@ledgerline/db/sql';
import {
  openSnapshotChunk,
  openSnapshotManifest,
  readEntry,
  readSnapshotHeader,
  resumeChain,
  sha256,
  toHex,
  walkPublic,
  type BudgetKeys,
  type Bytes,
  type Entry,
  type PublicRef,
} from '@ledgerline/seal';
import type { SyncRow } from '../routes/sync.js';
import { SYNC_FORMAT, type SyncTable } from '../sync-tables.js';
import { DeviceLog } from './device-log.js';
import { RECORDED_TABLES, WORKED_OUT, type LocalEngine } from './engine.js';

/** The tables a snapshot holds: everything an entry of the log can change. */
export const SNAPSHOT_TABLES: readonly SyncTable[] = RECORDED_TABLES;

/**
 * Columns a copy writes from its own clock when it works things out (derive() stamps the budget row): they
 * differ between two honest copies, so a snapshot leaves them out like the worked-out columns themselves.
 */
const OWN_CLOCK: Record<string, readonly string[]> = { budget: ['updated_at'] };

/** The most plain bytes of one chunk. Sealed, it stays under the server's limit for a chunk. */
export const CHUNK_BYTES = 900_000;

/** Rows read at a time. */
const PAGE = 500;

async function columnsOf(db: Db, t: SyncTable, hashing: boolean): Promise<string[]> {
  const info = await db.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all<{ name: string }>();
  return info.results
    .map((c) => c.name)
    .filter(
      (c) =>
        !t.omit?.includes(c) &&
        !WORKED_OUT[t.name]?.includes(c) &&
        !(hashing && OWN_CLOCK[t.name]?.includes(c)),
    )
    .sort();
}

/** Every row of a table as a line, in key order, a page at a time. */
async function* lines(db: Db, t: SyncTable, hashing = false): AsyncGenerator<string> {
  const cols = await columnsOf(db, t, hashing);
  const order = t.pk.join(', ');
  // Keyset paging on the primary key: the row value comparison keeps the order SQLite's own.
  const after = `(${t.pk.join(', ')}) > (${t.pk.map((_, i) => `?${i + 1}`).join(', ')})`;
  let last: unknown[] | null = null;
  for (;;) {
    const page: { results: Record<string, unknown>[] } = await db
      .prepare(
        `SELECT ${cols.join(', ')} FROM ${t.name} ${last ? `WHERE ${after}` : ''} ORDER BY ${order} LIMIT ${PAGE}`,
      )
      .bind(...(last ?? []))
      .all<Record<string, unknown>>();
    for (const d of page.results) {
      const row: SyncRow = { t: t.name, k: t.pk.map((c) => d[c]), d };
      yield JSON.stringify(row);
    }
    if (page.results.length < PAGE) return;
    last = t.pk.map((c) => page.results[page.results.length - 1]![c]);
  }
}

/** The hash of every snapshot table of this copy, as a manifest names them. */
export async function tableHashes(db: Db): Promise<{ name: string; hash: Uint8Array<ArrayBuffer> }[]> {
  const out = [];
  const enc = new TextEncoder();
  for (const t of SNAPSHOT_TABLES) {
    // A running hash, row by row: zeros, then H(hash so far || the row's line).
    let h: Uint8Array<ArrayBuffer> = new Uint8Array(32);
    for await (const line of lines(db, t, true)) {
      const text = enc.encode(line);
      const joined = new Uint8Array(32 + text.length);
      joined.set(h);
      joined.set(text, 32);
      h = await sha256(joined);
    }
    out.push({ name: t.name, hash: h });
  }
  return out;
}

/** The copy as plain chunks: its rows as lines, cut only between rows. Always at least one chunk. */
export async function dumpChunks(db: Db, chunkBytes = CHUNK_BYTES): Promise<Uint8Array[]> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  let size = 0;
  const cut = () => {
    const chunk = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      chunk.set(p, at);
      at += p.length;
    }
    chunks.push(chunk);
    parts = [];
    size = 0;
  };
  for (const t of SNAPSHOT_TABLES)
    for await (const line of lines(db, t)) {
      const bytes = enc.encode(`${line}\n`);
      if (size > 0 && size + bytes.length > chunkBytes) cut();
      parts.push(bytes);
      size += bytes.length;
    }
  if (size > 0 || chunks.length === 0) cut();
  return chunks;
}

/** A chunk that is not rows as lines. */
export class SnapshotFormatError extends Error {}

/** The rows of one plain chunk. */
export function rowsOfChunk(chunk: Uint8Array): SyncRow[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(chunk);
  } catch {
    throw new SnapshotFormatError('not text');
  }
  const rows: SyncRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      throw new SnapshotFormatError('not a row');
    }
    const x = r as Partial<SyncRow> | null;
    if (!x || typeof x.t !== 'string' || !Array.isArray(x.k) || !x.d || typeof x.d !== 'object')
      throw new SnapshotFormatError('not a row');
    rows.push(x as SyncRow);
  }
  return rows;
}

/** Whether two lists of table hashes are the same tables with the same hashes. Gives the names that differ. */
export function differingTables(
  a: readonly { name: string; hash: Uint8Array }[],
  b: readonly { name: string; hash: Uint8Array }[],
): string[] {
  const of = (list: readonly { name: string; hash: Uint8Array }[]) =>
    new Map(list.map((t) => [t.name, toHex(t.hash)]));
  const [x, y] = [of(a), of(b)];
  return [...new Set([...x.keys(), ...y.keys()])].filter((n) => x.get(n) !== y.get(n)).sort();
}

// ---- writing, opening and checking a snapshot

/** How a device reaches the server's snapshots and log (seal/log-routes.ts). */
export interface SnapshotTransport {
  /** The whole snapshots the server keeps, newest first. */
  list(): Promise<
    {
      id: string;
      number: number;
      header: Uint8Array;
      signature: Uint8Array;
      chunks: number;
      checked: boolean;
    }[]
  >;
  manifest(id: string): Promise<Uint8Array | null>;
  /** Chunk `k`, from 1. */
  chunk(id: string, k: number): Promise<Uint8Array | null>;
  begin(s: {
    header: Uint8Array;
    signature: Uint8Array;
    manifest: Uint8Array;
    chunks: number;
  }): Promise<{ ok: boolean; why?: string }>;
  put(id: string, k: number, bytes: Uint8Array): Promise<{ ok: boolean; why?: string }>;
  check(id: string, deviceId: string, signature: Uint8Array): Promise<{ ok: boolean; why?: string }>;
  /** Every public entry of the log, in order. */
  publics(): Promise<Uint8Array[]>;
  /** The entries after `number`, in order, as stored. */
  after(number: number): Promise<Uint8Array[]>;
}

/** A snapshot that is not what its manifest says, or that the server did not keep whole. */
export class SnapshotMismatch extends Error {
  constructor(
    readonly why: string,
    readonly tables: string[] = [],
  ) {
    super(`snapshot: ${why}${tables.length ? ` (${tables.join(', ')})` : ''}`);
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Writes a snapshot of this copy's base and reads it back (5.3, the first of the two checks: it was stored
 * whole). Only when the copy is the base: no edit waits, and the copy stands at the log's last entry, at the end
 * of a part set. Gives the snapshot's id, or why none was written.
 */
export async function writeSnapshot(
  engine: LocalEngine,
  log: DeviceLog,
  t: SnapshotTransport,
  snapshotId: string,
): Promise<{ written: true; id: string; number: number } | { written: false; why: string }> {
  if ((await engine.queue()).length) return { written: false, why: 'edits wait' };
  if ((await engine.state()).through !== log.number)
    return { written: false, why: 'the copy is not at the log' };
  if (!log.place().whole) return { written: false, why: 'inside a part set' };
  const plain = await dumpChunks(engine.db);
  const sealed = await log.sealSnapshot(snapshotId, await tableHashes(engine.db), plain);
  const begun = await t.begin({ ...sealed, chunks: sealed.chunks.length });
  if (!begun.ok) return { written: false, why: begun.why ?? 'refused' };
  for (const [i, c] of sealed.chunks.entries()) {
    const put = await t.put(snapshotId, i + 1, c);
    if (!put.ok) return { written: false, why: put.why ?? 'refused' };
  }
  // Read back and opened: what the server holds is what this device sealed.
  const manifest = await t.manifest(snapshotId);
  if (!manifest) throw new SnapshotMismatch('not stored whole');
  const version = readSnapshotHeader(sealed.header).version;
  const opened = await log.openManifest({ ...sealed, manifest: manifest as Bytes }, version);
  for (const [i, p] of plain.entries()) {
    const stored = await t.chunk(snapshotId, i + 1);
    if (!stored || !same(await log.openChunk(opened.manifest, i + 1, stored), p))
      throw new SnapshotMismatch('not stored whole');
  }
  return { written: true, id: snapshotId, number: log.number };
}

/** What opening a snapshot needs besides the server: the budget's keys, and who and when this device is. */
export interface OpenDeps {
  /** The budget's keys of every version this device can derive (the one in force, and older ones the log carries). */
  keys: readonly BudgetKeys[];
  budgetId: string;
  deviceId: string;
  clock: () => number;
  /** A public entry this device remembers: the walk must pass it, or the server is hiding a change. */
  remembered?: PublicRef;
}

/**
 * Opens one snapshot into an empty copy and gives the device's place in the log there: the public entries are
 * walked from the first entry, the snapshot is checked against them (8, the six checks), each chunk is opened
 * and its rows written, and the copy's table hashes must be the manifest's. Throws `SnapshotError`,
 * `ChainError` or `SnapshotMismatch`; the copy is then not to be used.
 */
export async function openSnapshot(
  engine: LocalEngine,
  t: SnapshotTransport,
  d: OpenDeps,
  /** The snapshot to open; without one, the newest checked snapshot, or else the newest. */
  pick?: { id: string; header: Uint8Array; signature: Uint8Array },
): Promise<DeviceLog> {
  const publics: Entry[] = [];
  for (const b of await t.publics()) publics.push(await readEntry(b));
  const head = await walkPublic(publics, d.budgetId, d.remembered ? { mustPass: d.remembered } : {});
  let s = pick;
  if (!s) {
    const list = await t.list();
    s = list.find((x) => x.checked) ?? list[0];
  }
  if (!s) throw new SnapshotMismatch('the server has no snapshot');
  const sealedManifest = await t.manifest(s.id);
  if (!sealedManifest) throw new SnapshotMismatch('not stored whole');
  // The header is not trusted yet: its key version only says which keys to try, and the checks follow.
  const named = readSnapshotHeader(s.header);
  const keys = d.keys.find((k) => k.version === named.version);
  if (!keys) throw new SnapshotMismatch('sealed under a key this device does not hold');
  const { header, manifest } = await openSnapshotManifest(
    keys,
    { header: s.header as Bytes, signature: s.signature as Bytes, manifest: sealedManifest as Bytes },
    d.budgetId,
    { publics: head.publics },
  );
  // The public state as it was at the snapshot, and the entry it stands at: the chain goes on from there.
  const at = await walkPublic(
    publics.filter((e) => e.header.number <= header.lastPublic.number),
    d.budgetId,
    { mustEndAt: header.lastPublic },
  );
  const lastBytes = (await t.after(manifest.number - 1))[0];
  if (!lastBytes) throw new SnapshotMismatch('the entry it stands at is gone');
  const state = await resumeChain(
    at,
    { number: manifest.number, hash: manifest.entryHash },
    await readEntry(lastBytes),
    new Map(manifest.counters.map((c) => [c.deviceId, c.counter])),
  );
  if ((await engine.state()).through !== 0 || (await engine.queue()).length)
    throw new SnapshotMismatch('the copy is not empty');
  for (let k = 1; k <= manifest.chunkHashes.length; k++) {
    const stored = await t.chunk(s.id, k);
    if (!stored) throw new SnapshotMismatch('not stored whole');
    await engine.applyRows(rowsOfChunk(await openSnapshotChunk(keys, d.budgetId, manifest, k, stored)));
  }
  const differ = differingTables(manifest.tables, await tableHashes(engine.db));
  if (differ.length) throw new SnapshotMismatch('its rows are not what its manifest says', differ);
  // The copy stands at the snapshot's entry.
  const now = d.clock();
  await engine.apply(
    {
      format: SYNC_FORMAT,
      epoch: 'log',
      serverTime: now,
      through: manifest.number,
      more: false,
      cursor: null,
      rows: [],
    },
    now,
  );
  if (await engine.needsDerive()) await engine.derive();
  return new DeviceLog(d.keys, state, d.deviceId, d.clock, manifest.checkpoints.slice(0, -1));
}

/** Guards the read of the entries between two snapshots. */
const MAX_READS = 10_000;

/**
 * The second check (5.3): rebuilds the budget in an empty copy from the snapshot before the newest unchecked
 * one plus the entries since, and compares the table hashes with that snapshot's manifest. When they are the
 * same, this device signs a check record and the server takes it. Gives what happened.
 */
export async function checkSnapshot(
  scratch: LocalEngine,
  log: DeviceLog,
  t: SnapshotTransport,
  clock: () => number,
): Promise<
  | { checked: true; id: string }
  | {
      checked: false;
      why: 'nothing to check' | 'no older snapshot' | 'differs' | 'refused';
      tables?: string[];
    }
> {
  const list = await t.list();
  const target = list[0];
  if (!target || target.checked) return { checked: false, why: 'nothing to check' };
  const before = list.find((x) => x.number < target.number);
  if (!before) return { checked: false, why: 'no older snapshot' };
  const rebuilt = await openSnapshot(
    scratch,
    t,
    { keys: log.keysHeld(), budgetId: log.budgetId, deviceId: log.deviceId, clock },
    before,
  );
  for (let n = 0; rebuilt.number < target.number; n++) {
    if (n > MAX_READS) throw new SnapshotMismatch('the entries since the older snapshot do not end');
    const entries: Entry[] = [];
    for (const b of await t.after(rebuilt.number)) {
      const e = await readEntry(b);
      if (e.header.number <= target.number) entries.push(e);
    }
    if (!entries.length) throw new SnapshotMismatch('entries since the older snapshot are gone');
    const read = await rebuilt.read(entries);
    for (const set of read.sets) await scratch.applyRows(set.set.rows);
    read.commit();
  }
  const sealedManifest = await t.manifest(target.id);
  if (!sealedManifest) throw new SnapshotMismatch('not stored whole');
  const { header, manifest } = await rebuilt.openManifest(
    {
      header: target.header as Bytes,
      signature: target.signature as Bytes,
      manifest: sealedManifest as Bytes,
    },
    readSnapshotHeader(target.header).version,
  );
  const at = rebuilt.place();
  if (header.number !== at.number || toHex(header.entryHash) !== toHex(at.hash))
    throw new SnapshotMismatch('it does not stand on this log');
  const differ = differingTables(manifest.tables, await tableHashes(scratch.db));
  if (differ.length) return { checked: false, why: 'differs', tables: differ };
  const signature = await log.signCheck({
    header: target.header as Bytes,
    signature: target.signature as Bytes,
  });
  const answer = await t.check(target.id, log.deviceId, signature);
  return answer.ok ? { checked: true, id: target.id } : { checked: false, why: 'refused' };
}
