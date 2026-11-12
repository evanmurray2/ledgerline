// The server's store of a sealed budget's snapshots (docs/privacy.md 5.3; docs/privacy-keys.md 8; store
// migration 0008). The server reads a snapshot's clear header and nothing else: it checks that a holder of the
// budget's signing key made it, and that it stands at an entry the log holds, at the end of a part set. It can't
// check a chunk (the manifest that names their hashes is sealed): the writer reads its snapshot back, and a
// device signs a check record once it has rebuilt the budget and got the same.
//
// One rule deletes: the server keeps the snapshot before the newest checked one, and every entry and filed bank
// run since that older snapshot. Public entries (key and slot changes) are never deleted: every device walks
// them from the first entry. Nothing calls this before the cutover.
import type { Db } from '@ledgerline/db/sql';
import {
  FormatError,
  isPublicKind,
  isUlid,
  readEntry,
  readSnapshotHeader,
  toHex,
  verifySnapshotCheck,
  verifySnapshotHeader,
  type SnapshotHeader,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort } from '../sync/lease.js';
import { stateFromJson } from './log-store.js';

/** The most chunks one snapshot has, and the most bytes of one chunk and of a manifest, as stored. */
export const MAX_CHUNKS = 4096;
export const MAX_CHUNK_BYTES = 1_100_000;
export const MAX_MANIFEST_BYTES = 400_000;
/** Snapshots one budget may begin in a day. */
export const SNAPSHOTS_A_DAY = 6;
/** How many rows one call of the delete rule removes: the rest goes at the next call. */
const PRUNE_ROWS = 400;

export type SnapshotRefused =
  | 'not a header'
  | 'another budget'
  | 'signature'
  | 'key version'
  | 'no such entry'
  | 'inside a part set'
  | 'last public entry'
  | 'older than a snapshot'
  | 'too large'
  | 'limit'
  | 'resting'
  | 'no such snapshot'
  | 'not whole'
  | 'chunk';

export type SnapshotAnswer = { ok: true } | { ok: false; why: SnapshotRefused };

export interface SnapshotDeps {
  db: Db;
  budgetId: string;
  now: number;
  /** The breaker rests writes (90% of a daily limit). */
  resting: boolean;
}

const no = (why: SnapshotRefused): SnapshotAnswer => ({ ok: false, why });
const bytesOf = (v: unknown): Uint8Array<ArrayBuffer> =>
  v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v as ArrayBuffer);

/** The signing public key of each key version, and the version in force, from the log's state. */
async function signKeys(db: Db): Promise<{ keyVersion: number; signPubs: Map<number, Uint8Array> } | null> {
  const r = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
  if (!r) return null;
  const p = (stateFromJson(r.state) as unknown as { public?: { keyVersion?: unknown; signPubs?: unknown } })
    .public;
  if (typeof p?.keyVersion !== 'number' || !(p.signPubs instanceof Map)) return null;
  return { keyVersion: p.keyVersion, signPubs: p.signPubs as Map<number, Uint8Array> };
}

/**
 * Begins a snapshot: its header, signature and sealed manifest, and how many chunks will follow. The same
 * snapshot sent again is taken as stored.
 */
export async function snapshotBegin(
  d: SnapshotDeps,
  s: { header: Uint8Array; signature: Uint8Array; manifest: Uint8Array; chunks: number },
): Promise<SnapshotAnswer> {
  if (d.resting) return no('resting');
  let h: SnapshotHeader;
  try {
    h = readSnapshotHeader(s.header);
  } catch (x) {
    if (x instanceof FormatError || x instanceof RangeError) return no('not a header');
    throw x;
  }
  if (h.budgetId !== d.budgetId) return no('another budget');
  if (!Number.isInteger(s.chunks) || s.chunks < 1 || s.chunks > MAX_CHUNKS) return no('too large');
  if (s.manifest.length < 1 || s.manifest.length > MAX_MANIFEST_BYTES) return no('too large');
  const keys = await signKeys(d.db);
  // Made under the key in force: a snapshot under a replaced key is one no device would open.
  if (!keys || h.version !== keys.keyVersion) return no('key version');
  const pub = keys.signPubs.get(h.version);
  if (!pub || !(await verifySnapshotHeader(s.header, s.signature, pub))) return no('signature');

  const held = await d.db
    .prepare(`SELECT header FROM snapshot WHERE id = ?1`)
    .bind(h.snapshotId)
    .first<{ header: unknown }>();
  if (held) return toHex(bytesOf(held.header)) === toHex(s.header) ? { ok: true } : no('not a header');

  // It stands at an entry the log holds, at the end of its part set, and names the last public entry before it.
  const at = await d.db
    .prepare(`SELECT hash, bytes FROM log_entry WHERE number = ?1`)
    .bind(h.number)
    .first<{ hash: string; bytes: string }>();
  if (!at || at.hash !== toHex(h.entryHash)) return no('no such entry');
  const entry = await readEntry(Uint8Array.from(atob(at.bytes), (c) => c.charCodeAt(0)));
  if (entry.header.part !== entry.header.parts) return no('inside a part set');
  const pubEntry = await d.db
    .prepare(
      `SELECT number, hash FROM log_entry WHERE number <= ?1 AND kind IN (${PUBLIC_KIND_LIST}) ORDER BY number DESC LIMIT 1`,
    )
    .bind(h.number)
    .first<{ number: number; hash: string }>();
  if (!pubEntry || pubEntry.number !== h.lastPublic.number || pubEntry.hash !== toHex(h.lastPublic.hash))
    return no('last public entry');
  const newest = await d.db
    .prepare(`SELECT max(number) AS n FROM snapshot WHERE whole_at IS NOT NULL`)
    .first<{ n: number | null }>();
  if (newest?.n != null && h.number < newest.n) return no('older than a snapshot');
  // Counted as begun, whole or not: a snapshot that is begun and left still cost its rows.
  const day = Math.floor(d.now / 86_400_000);
  const notes = await d.db
    .prepare(`SELECT key, value FROM store_note WHERE key IN ('snapshot_day', 'snapshots_begun')`)
    .all<{ key: string; value: number }>();
  const note = (key: string) => notes.results.find((n) => n.key === key)?.value ?? 0;
  const begun = note('snapshot_day') === day ? note('snapshots_begun') : 0;
  if (begun >= SNAPSHOTS_A_DAY) return no('limit');
  const setNote = (key: string, value: number) =>
    d.db
      .prepare(
        `INSERT INTO store_note (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, value);

  await d.db.batch([
    setNote('snapshot_day', day),
    setNote('snapshots_begun', begun + 1),
    // A snapshot that was begun and never finished makes way: one is written at a time.
    d.db.prepare(
      `DELETE FROM snapshot_chunk WHERE snapshot_id IN (SELECT id FROM snapshot WHERE whole_at IS NULL)`,
    ),
    d.db.prepare(`DELETE FROM snapshot WHERE whole_at IS NULL`),
    d.db
      .prepare(
        `INSERT INTO snapshot (id, number, key_version, header, signature, manifest, chunks, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(h.snapshotId, h.number, h.version, s.header, s.signature, s.manifest, s.chunks, d.now),
  ]);
  return { ok: true };
}

const PUBLIC_KIND_LIST = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((k) => isPublicKind(k)).join(', ');

/** Stores chunk `k` (from 1) of a snapshot that was begun. With its last chunk the snapshot is whole. */
export async function snapshotChunk(
  d: SnapshotDeps,
  id: string,
  k: number,
  bytes: Uint8Array,
): Promise<SnapshotAnswer> {
  if (d.resting) return no('resting');
  if (!isUlid(id)) return no('no such snapshot');
  const s = await d.db
    .prepare(`SELECT chunks, whole_at FROM snapshot WHERE id = ?1`)
    .bind(id)
    .first<{ chunks: number; whole_at: number | null }>();
  if (!s) return no('no such snapshot');
  if (!Number.isInteger(k) || k < 1 || k > s.chunks) return no('chunk');
  if (bytes.length < 1 || bytes.length > MAX_CHUNK_BYTES) return no('too large');
  // A whole snapshot is never changed: a chunk sent again is taken as stored.
  if (s.whole_at !== null) return { ok: true };
  try {
    await d.db.batch([
      conditionFence(d.db, `SELECT whole_at IS NULL FROM snapshot WHERE id = ?1`, id),
      d.db
        .prepare(`INSERT OR IGNORE INTO snapshot_chunk (snapshot_id, k, bytes) VALUES (?1, ?2, ?3)`)
        .bind(id, k, bytes),
      d.db
        .prepare(
          `UPDATE snapshot SET whole_at = ?2 WHERE id = ?1
             AND (SELECT count(*) FROM snapshot_chunk WHERE snapshot_id = ?1) = chunks`,
        )
        .bind(id, d.now),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
  }
  return { ok: true };
}

/**
 * A device's check record for a whole snapshot: it rebuilt the budget from the snapshot before plus the entries
 * since, and got the same. The snapshot then counts as checked, and the delete rule may run.
 */
export async function snapshotCheck(
  d: SnapshotDeps,
  id: string,
  deviceId: string,
  signature: Uint8Array,
): Promise<SnapshotAnswer> {
  if (!isUlid(id) || !isUlid(deviceId)) return no('no such snapshot');
  const s = await d.db
    .prepare(`SELECT header, key_version, whole_at, checked_at FROM snapshot WHERE id = ?1`)
    .bind(id)
    .first<{ header: unknown; key_version: number; whole_at: number | null; checked_at: number | null }>();
  if (!s) return no('no such snapshot');
  if (s.whole_at === null) return no('not whole');
  if (s.checked_at !== null) return { ok: true };
  const keys = await signKeys(d.db);
  const pub = keys?.signPubs.get(s.key_version);
  if (!pub || !(await verifySnapshotCheck(bytesOf(s.header), deviceId, signature, pub)))
    return no('signature');
  await d.db
    .prepare(
      `UPDATE snapshot SET check_signature = ?2, check_device = ?3, checked_at = ?4 WHERE id = ?1 AND checked_at IS NULL`,
    )
    .bind(id, signature, deviceId, d.now)
    .run();
  return { ok: true };
}

export interface StoredSnapshot {
  id: string;
  number: number;
  header: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
  chunks: number;
  /** A device signed a check record for it. */
  checked: boolean;
  check: { deviceId: string; signature: Uint8Array<ArrayBuffer> } | null;
}

/** The whole snapshots the server keeps, newest first. */
export async function snapshotList(db: Db): Promise<StoredSnapshot[]> {
  const rows = await db
    .prepare(
      `SELECT id, number, header, signature, chunks, check_signature, check_device, checked_at FROM snapshot
       WHERE whole_at IS NOT NULL ORDER BY number DESC, created_at DESC LIMIT 8`,
    )
    .all<{
      id: string;
      number: number;
      header: unknown;
      signature: unknown;
      chunks: number;
      check_signature: unknown;
      check_device: string | null;
      checked_at: number | null;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    number: r.number,
    header: bytesOf(r.header),
    signature: bytesOf(r.signature),
    chunks: r.chunks,
    checked: r.checked_at !== null,
    check:
      r.checked_at !== null && r.check_device
        ? { deviceId: r.check_device, signature: bytesOf(r.check_signature) }
        : null,
  }));
}

/** The sealed manifest of a whole snapshot. */
export async function snapshotManifest(db: Db, id: string): Promise<Uint8Array | null> {
  const r = await db
    .prepare(`SELECT manifest FROM snapshot WHERE id = ?1 AND whole_at IS NOT NULL`)
    .bind(id)
    .first<{ manifest: unknown }>();
  return r ? bytesOf(r.manifest) : null;
}

/** One sealed chunk of a whole snapshot. */
export async function snapshotChunkOf(db: Db, id: string, k: number): Promise<Uint8Array | null> {
  const r = await db
    .prepare(
      `SELECT c.bytes FROM snapshot_chunk c JOIN snapshot s ON s.id = c.snapshot_id
       WHERE c.snapshot_id = ?1 AND c.k = ?2 AND s.whole_at IS NOT NULL`,
    )
    .bind(id, k)
    .first<{ bytes: unknown }>();
  return r ? bytesOf(r.bytes) : null;
}

/** The public entries (key and slot changes, the first entry) after `after`, in order: a device walks them all. */
export async function publicAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ number: number; bytes: Uint8Array }[]> {
  const rows = await db
    .prepare(
      `SELECT number, bytes FROM log_entry WHERE number > ?1 AND kind IN (${PUBLIC_KIND_LIST}) ORDER BY number LIMIT ?2`,
    )
    .bind(after, limit)
    .all<{ number: number; bytes: string }>();
  return rows.results.map((r) => ({
    number: r.number,
    bytes: Uint8Array.from(atob(r.bytes), (c) => c.charCodeAt(0)),
  }));
}

/**
 * The entry number below which the log's sealed entries may be gone: a device whose place is lower opens a
 * snapshot. 0 when nothing was deleted.
 */
export async function logFloor(db: Db): Promise<number> {
  const r = await db
    .prepare(`SELECT value FROM store_note WHERE key = 'log_floor'`)
    .first<{ value: number }>();
  return r?.value ?? 0;
}

/**
 * The one delete rule (5.3): with a checked snapshot, the server keeps the snapshot before it (the newest whole
 * one that stands lower) and every entry and filed bank run since that older snapshot. Older snapshots, older
 * sealed entries and the pages of older filed runs go, a few hundred rows a call; `more` says to call again.
 * Never deleted: a public entry, the entry a kept snapshot stands at, a run's manifest and receipt hash.
 */
export async function snapshotPrune(db: Db): Promise<{ deleted: number; more: boolean }> {
  const checked = await db
    .prepare(
      `SELECT number FROM snapshot WHERE checked_at IS NOT NULL AND whole_at IS NOT NULL ORDER BY number DESC LIMIT 1`,
    )
    .first<{ number: number }>();
  if (!checked) return { deleted: 0, more: false };
  const kept = await db
    .prepare(
      `SELECT id, number FROM snapshot WHERE whole_at IS NOT NULL AND number < ?1 ORDER BY number DESC, created_at DESC LIMIT 1`,
    )
    .bind(checked.number)
    .first<{ id: string; number: number }>();
  // With no older snapshot, the checked one is the only copy besides the log: nothing goes.
  if (!kept) return { deleted: 0, more: false };
  const at = await db
    .prepare(`SELECT bytes FROM log_entry WHERE number = ?1`)
    .bind(kept.number)
    .first<{ bytes: string }>();
  if (!at) return { deleted: 0, more: false };
  const filed = (await readEntry(Uint8Array.from(atob(at.bytes), (c) => c.charCodeAt(0)))).header
    .filedThrough;

  let deleted = 0;
  const run = async (sql: string, ...params: unknown[]) => {
    const r = await db
      .prepare(sql)
      .bind(...params)
      .run();
    deleted += r.changes ?? 0;
  };
  await db
    .prepare(
      `INSERT INTO store_note (key, value) VALUES ('log_floor', ?1)
       ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)`,
    )
    .bind(kept.number)
    .run();
  await run(
    `DELETE FROM snapshot_chunk WHERE rowid IN (
       SELECT c.rowid FROM snapshot_chunk c JOIN snapshot s ON s.id = c.snapshot_id
       WHERE s.number < ?1 OR (s.number = ?1 AND s.id != ?2) LIMIT ${PRUNE_ROWS})`,
    kept.number,
    kept.id,
  );
  await run(
    `DELETE FROM snapshot WHERE (number < ?1 OR (number = ?1 AND id != ?2))
       AND NOT EXISTS (SELECT 1 FROM snapshot_chunk c WHERE c.snapshot_id = snapshot.id)`,
    kept.number,
    kept.id,
  );
  await run(
    `DELETE FROM log_entry WHERE number IN (
       SELECT number FROM log_entry WHERE number < ?1 AND kind NOT IN (${PUBLIC_KIND_LIST}) ORDER BY number LIMIT ${PRUNE_ROWS})`,
    kept.number,
  );
  await run(
    `DELETE FROM sealed_page WHERE rowid IN (
       SELECT rowid FROM sealed_page WHERE run <= ?1 AND run IN (SELECT run FROM sealed_run) LIMIT ${PRUNE_ROWS})`,
    filed,
  );
  return { deleted, more: deleted >= PRUNE_ROWS };
}
