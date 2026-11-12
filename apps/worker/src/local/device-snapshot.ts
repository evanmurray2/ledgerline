// A device's side of snapshots (docs/privacy.md 5.3; docs/privacy-keys.md 8): the base of a copy as sealed
// chunks, and a hash of every table, so that another device (or this one, in a fresh database) can rebuild the
// budget and compare.
//
// A chunk's plain text is UTF-8 JSON lines. The first line of the first chunk says which columns each table
// has, as the writer had them: {"schema": {table: [columns]}}. Then one row a line, in the log's own row shape:
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
  verifySnapshotCheck,
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

/** The columns each table of a snapshot holds, as its writer had them: the first line of its first chunk. */
export type SnapshotSchema = Record<string, string[]>;

/** A chunk that is not rows as lines. */
export class SnapshotFormatError extends Error {}

/** The snapshot was written by a newer version of the app than this one: update before opening it. */
export class SnapshotNewer extends Error {
  constructor() {
    super('this snapshot was written by a newer version of the app');
  }
}

/** The columns of a table this copy dumps: all but what only the server keeps and what a copy works out. */
async function ownColumns(db: Db, t: SyncTable): Promise<string[]> {
  const info = await db.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all<{ name: string }>();
  return info.results
    .map((c) => c.name)
    .filter((c) => !t.omit?.includes(c) && !WORKED_OUT[t.name]?.includes(c))
    .sort();
}

/** The schema of this copy, as a snapshot of it says it. */
export async function ownSchema(db: Db): Promise<SnapshotSchema> {
  const out: SnapshotSchema = {};
  for (const t of SNAPSHOT_TABLES) out[t.name] = await ownColumns(db, t);
  return out;
}

/**
 * The columns to read for a snapshot written with `schema`. A table or column the snapshot has and this copy
 * doesn't means a newer app wrote it. A column this copy has and the snapshot doesn't is left out: its rows get
 * the column's default, as rows written before a migration do.
 */
async function columnsFor(db: Db, t: SyncTable, schema: SnapshotSchema): Promise<string[]> {
  const own = new Set(await ownColumns(db, t));
  const cols = schema[t.name];
  if (!cols) return [];
  if (!cols.every((c) => own.has(c)) || !t.pk.every((c) => cols.includes(c))) throw new SnapshotNewer();
  return [...cols].sort();
}

/** Every row of a table as a line, in key order, a page at a time. */
async function* lines(db: Db, t: SyncTable, cols: readonly string[]): AsyncGenerator<string> {
  if (!cols.length) return;
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

/**
 * The hash of every snapshot table of this copy, as a manifest names them. `schema`: the columns of the snapshot
 * to compare with (its writer's); without it, this copy's own.
 */
export async function tableHashes(
  db: Db,
  schema?: SnapshotSchema,
): Promise<{ name: string; hash: Uint8Array<ArrayBuffer> }[]> {
  const with_ = schema ?? (await ownSchema(db));
  for (const name of Object.keys(with_))
    if (!SNAPSHOT_TABLES.some((t) => t.name === name)) throw new SnapshotNewer();
  const out = [];
  const enc = new TextEncoder();
  for (const t of SNAPSHOT_TABLES) {
    const cols = (await columnsFor(db, t, with_)).filter((c) => !OWN_CLOCK[t.name]?.includes(c));
    // A running hash, row by row: zeros, then H(hash so far || the row's line).
    let h: Uint8Array<ArrayBuffer> = new Uint8Array(32);
    for await (const line of lines(db, t, cols)) {
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

/**
 * The copy as plain chunks: a first line that says which columns each table has, then the rows as lines, cut
 * only between lines. Always at least one chunk.
 */
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
  const add = (line: string) => {
    const bytes = enc.encode(`${line}\n`);
    if (size > 0 && size + bytes.length > chunkBytes) cut();
    parts.push(bytes);
    size += bytes.length;
  };
  const schema = await ownSchema(db);
  add(JSON.stringify({ schema }));
  for (const t of SNAPSHOT_TABLES) for await (const line of lines(db, t, schema[t.name]!)) add(line);
  cut();
  return chunks;
}

/** The lines of one plain chunk, parsed. */
function parsed(chunk: Uint8Array): Record<string, unknown>[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(chunk);
  } catch {
    throw new SnapshotFormatError('not text');
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      throw new SnapshotFormatError('not a row');
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new SnapshotFormatError('not a row');
    out.push(r as Record<string, unknown>);
  }
  return out;
}

/** The schema line of a snapshot's first chunk. */
export function schemaOfChunk(first: Uint8Array): SnapshotSchema {
  const line = parsed(first)[0];
  const schema = line?.schema as unknown;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new SnapshotFormatError('no schema');
  for (const cols of Object.values(schema as Record<string, unknown>))
    if (!Array.isArray(cols) || !cols.every((c) => typeof c === 'string' && /^[a-z_][a-z0-9_]*$/.test(c)))
      throw new SnapshotFormatError('no schema');
  return schema as SnapshotSchema;
}

/** The rows of one plain chunk. */
export function rowsOfChunk(chunk: Uint8Array): SyncRow[] {
  const rows: SyncRow[] = [];
  for (const x of parsed(chunk)) {
    if ('schema' in x) continue;
    if (typeof x.t !== 'string' || !Array.isArray(x.k) || !x.d || typeof x.d !== 'object')
      throw new SnapshotFormatError('not a row');
    rows.push(x as unknown as SyncRow);
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

/** A whole snapshot as the server lists it. Nothing in it is trusted before it is checked. */
export interface ListedSnapshot {
  id: string;
  number: number;
  header: Uint8Array;
  signature: Uint8Array;
  chunks: number;
  /** The check record the server holds for it, if any: a device verifies it itself. */
  check: { deviceId: string; signature: Uint8Array } | null;
}

/** How a device reaches the server's snapshots and log (seal/log-routes.ts). */
export interface SnapshotTransport {
  /** The whole snapshots the server keeps, newest first. */
  list(): Promise<ListedSnapshot[]>;
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
  /** A check record for snapshot `id`, built on snapshot `baseId`. */
  check(
    id: string,
    deviceId: string,
    signature: Uint8Array,
    baseId: string,
  ): Promise<{ ok: boolean; why?: string }>;
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
 * The snapshots of a list whose check record is real: signed, for that snapshot's header and the device it
 * names, by the budget's signing key of the snapshot's key version. The server's word that a snapshot is
 * checked counts for nothing.
 */
async function verifiedChecked(
  list: readonly ListedSnapshot[],
  signPubs: Map<number, Uint8Array>,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const s of list) {
    if (!s.check) continue;
    try {
      const pub = signPubs.get(readSnapshotHeader(s.header).version);
      if (pub && (await verifySnapshotCheck(s.header, s.check.deviceId, s.check.signature, pub)))
        out.add(s.id);
    } catch {
      // A header that doesn't read is not checked.
    }
  }
  return out;
}

/**
 * The snapshot a budget is rebuilt from: the newest one with a real check record; while the budget has none, its
 * first (the one every later check is built on). Never one that only says it is checked, and never an unchecked
 * one while a checked one exists.
 */
function trusted(
  list: readonly ListedSnapshot[],
  checked: Set<string>,
  below = Infinity,
): ListedSnapshot | null {
  const older = list.filter((s) => s.number < below);
  return older.find((s) => checked.has(s.id)) ?? (checked.size ? null : (older[older.length - 1] ?? null));
}

/**
 * Writes a snapshot of this copy's base and reads it back (5.3, the first of the two checks: it was stored
 * whole). Only when the copy is the base: no edit waits, and the copy stands at the log's last entry, at the end
 * of a part set, from before the first row is read until after the last. Gives the snapshot's id, or why none
 * was written.
 */
export async function writeSnapshot(
  engine: LocalEngine,
  log: DeviceLog,
  t: SnapshotTransport,
  snapshotId: string,
): Promise<{ written: true; id: string; number: number } | { written: false; why: string }> {
  const still = async (): Promise<string | null> => {
    if ((await engine.queue()).length) return 'edits wait';
    if ((await engine.state()).through !== log.number) return 'the copy is not at the log';
    if (!log.place().whole) return 'inside a part set';
    return null;
  };
  const before = await still();
  if (before) return { written: false, why: before };
  const at = log.place();
  const plain = await dumpChunks(engine.db);
  const tables = await tableHashes(engine.db);
  // Nothing moved while the rows were read: no edit, no entry taken.
  const moved = (await still()) ?? (toHex(log.place().hash) !== toHex(at.hash) ? 'the copy moved' : null);
  if (moved) return { written: false, why: moved };
  const sealed = await log.sealSnapshot(snapshotId, tables, plain);
  if (readSnapshotHeader(sealed.header).number !== at.number)
    return { written: false, why: 'the copy moved' };
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
  return { written: true, id: snapshotId, number: at.number };
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
  /** The highest entry this device has applied: a snapshot that stands before it is an old one shown as new. */
  applied?: number;
  /** A checkpoint this device remembers: the snapshot's chain must hold it. */
  checkpoint?: PublicRef;
}

/**
 * Opens one snapshot into an empty copy and gives the device's place in the log there: the public entries are
 * walked from the first entry, the snapshot is checked against them and against what the device remembers (8,
 * the six checks), each chunk is opened and its rows written, and the copy's table hashes must be the
 * manifest's. Throws `SnapshotError`, `ChainError`, `SnapshotMismatch` or `SnapshotNewer`; whatever was written
 * is then taken out again.
 */
export async function openSnapshot(
  engine: LocalEngine,
  t: SnapshotTransport,
  d: OpenDeps,
  /** The snapshot to open; without one, the newest with a real check record, or the budget's first while none has. */
  pick?: Pick<ListedSnapshot, 'id' | 'header' | 'signature'>,
): Promise<DeviceLog> {
  const publics: Entry[] = [];
  for (const b of await t.publics()) publics.push(await readEntry(b));
  const head = await walkPublic(publics, d.budgetId, d.remembered ? { mustPass: d.remembered } : {});
  let s = pick ?? null;
  if (!s) {
    const list = await t.list();
    s = trusted(list, await verifiedChecked(list, head.signPubs));
  }
  if (!s) throw new SnapshotMismatch('the server has no snapshot to start from');
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
    {
      publics: head.publics,
      ...(d.applied === undefined ? {} : { minNumber: d.applied }),
      ...(d.checkpoint ? { checkpoint: d.checkpoint } : {}),
    },
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
  if (!(await isEmpty(engine))) throw new SnapshotMismatch('the copy is not empty');
  try {
    let schema: SnapshotSchema | null = null;
    for (let k = 1; k <= manifest.chunkHashes.length; k++) {
      const stored = await t.chunk(s.id, k);
      if (!stored) throw new SnapshotMismatch('not stored whole');
      const plain = await openSnapshotChunk(keys, d.budgetId, manifest, k, stored);
      if (k === 1) {
        schema = schemaOfChunk(plain);
        // Before a row is written: every column the snapshot has, this copy has.
        await tableHashes(engine.db, schema);
      }
      await engine.applyRows(rowsOfChunk(plain));
    }
    const differ = differingTables(manifest.tables, await tableHashes(engine.db, schema ?? {}));
    if (differ.length) throw new SnapshotMismatch('its rows are not what its manifest says', differ);
  } catch (x) {
    await wipe(engine);
    throw x;
  }
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
  // The checkpoints before this place: every multiple of 1,000 up to it (the manifest lists its own entry last,
  // which is one of them only when its number is).
  return new DeviceLog(
    d.keys,
    state,
    d.deviceId,
    d.clock,
    manifest.checkpoints.filter((c) => c.number % 1000 === 0),
  );
}

/** Whether a copy holds no row of any snapshot table, no waiting edit, and stands nowhere. */
async function isEmpty(engine: LocalEngine): Promise<boolean> {
  if ((await engine.state()).through !== 0 || (await engine.queue()).length) return false;
  for (const t of SNAPSHOT_TABLES)
    if (await engine.db.prepare(`SELECT 1 AS x FROM ${t.name} LIMIT 1`).first()) return false;
  return true;
}

/** Takes every row of every snapshot table out of a copy that a failed open half filled. */
async function wipe(engine: LocalEngine): Promise<void> {
  await engine.clear();
  await engine.db.batch(
    SNAPSHOT_TABLES.filter((t) => t.name === 'audit_log' || t.name === 'txn_key_move').map((t) =>
      engine.db.prepare(`DELETE FROM ${t.name}`),
    ),
  );
}

/** Guards the read of the entries between two snapshots. */
const MAX_READS = 10_000;

/**
 * The second check (5.3): rebuilds the budget in an empty copy from a snapshot that can be trusted (the newest
 * one below the target whose check record this device verified; the budget's first while none has one) plus the
 * entries since, and compares the table hashes with the newest snapshot's manifest. Every chunk of that snapshot
 * is read and opened too. When all is the same, this device signs a check record, and the server takes it with
 * the snapshot it was built on. Gives what happened.
 */
export async function checkSnapshot(
  scratch: LocalEngine,
  log: DeviceLog,
  t: SnapshotTransport,
  clock: () => number,
): Promise<
  | { checked: true; id: string; base: string }
  | {
      checked: false;
      why: 'nothing to check' | 'no older snapshot' | 'differs' | 'refused';
      tables?: string[];
    }
> {
  const list = await t.list();
  const checked = await verifiedChecked(list, log.publicState.signPubs);
  const target = list[0];
  if (!target || checked.has(target.id)) return { checked: false, why: 'nothing to check' };
  const before = trusted(list, checked, target.number);
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
  const version = readSnapshotHeader(target.header).version;
  const { header, manifest } = await rebuilt.openManifest(
    {
      header: target.header as Bytes,
      signature: target.signature as Bytes,
      manifest: sealedManifest as Bytes,
    },
    version,
  );
  const at = rebuilt.place();
  if (!at.whole || header.number !== at.number || toHex(header.entryHash) !== toHex(at.hash))
    throw new SnapshotMismatch('it does not stand on this log');
  // Every chunk the server holds is the one the manifest names, and opens.
  let schema: SnapshotSchema | null = null;
  for (let k = 1; k <= manifest.chunkHashes.length; k++) {
    const stored = await t.chunk(target.id, k);
    if (!stored) throw new SnapshotMismatch('not stored whole');
    const plain = await rebuilt.openChunk(manifest, k, stored);
    if (k === 1) schema = schemaOfChunk(plain);
  }
  const differ = differingTables(manifest.tables, await tableHashes(scratch.db, schema ?? {}));
  if (differ.length) return { checked: false, why: 'differs', tables: differ };
  let signature: Bytes;
  try {
    signature = await log.signCheck({ header: target.header as Bytes, signature: target.signature as Bytes });
  } catch {
    // Sealed under a key version this device can't sign for (a key change came after it).
    return { checked: false, why: 'refused' };
  }
  const answer = await t.check(target.id, log.deviceId, signature, before.id);
  return answer.ok ? { checked: true, id: target.id, base: before.id } : { checked: false, why: 'refused' };
}
