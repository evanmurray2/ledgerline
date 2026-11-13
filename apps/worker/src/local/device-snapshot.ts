// A device's side of snapshots (docs/privacy.md 5.3; docs/privacy-keys.md 8): writing one of its copy, opening one
// into an empty copy, and checking the newest one by rebuilding from the one before. What a snapshot holds, and
// the hash of each table, are in local/snapshot-tables.ts (re-exported here).
import {
  openSnapshotChunk,
  openSnapshotManifest,
  readEntry,
  readSnapshotHeader,
  resumeChain,
  toHex,
  verifySnapshotCheck,
  walkPublic,
  type BudgetKeys,
  type Bytes,
  type Entry,
  type PublicRef,
} from '@ledgerline/seal';
import { SYNC_FORMAT } from '../sync-tables.js';
import { DeviceLog } from './device-log.js';
import { wipeBankLog, type LocalEngine } from './engine.js';
import {
  differingTables,
  dumpChunks,
  rowsOfChunk,
  schemaOfChunk,
  SNAPSHOT_TABLES,
  tableHashes,
  type SnapshotSchema,
} from './snapshot-tables.js';

export * from './snapshot-tables.js';

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

/** Takes every row of every snapshot table out of a copy (one a failed open half filled, or one made again). */
export async function wipe(engine: LocalEngine): Promise<void> {
  await engine.clear();
  await engine.db.batch(
    SNAPSHOT_TABLES.filter((t) => t.name === 'audit_log' || t.name === 'txn_key_move').map((t) =>
      engine.db.prepare(`DELETE FROM ${t.name}`),
    ),
  );
  await wipeBankLog(engine.db);
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
