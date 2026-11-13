// What a snapshot holds (docs/privacy.md 5.3; docs/privacy-keys.md 8; re-exported by local/device-snapshot.ts): the
// base of a copy as sealed chunks, and a hash of every table, so that another device (or this one, in a fresh
// database) can rebuild the budget and compare.
//
// A chunk's plain text is UTF-8 JSON lines. The first line of the first chunk says which columns each table
// has, as the writer had them, and the rules its table hashes follow: {"schema": {table: [columns]}, "hash": 1}
// (a snapshot from before the rules had a number has no "hash": it is version 1). Then one row a line, in the
// log's own row shape:
//   {"t": table, "k": [key values], "d": row}
// in the order of `SNAPSHOT_TABLES`, each table in key order. A row is never cut between chunks. A table's hash
// is a running SHA-256 over its lines in that order (zeros, then H(hash so far || line) for each row), so the hash
// a device works out from its own copy is the hash of what a snapshot of that copy holds.
//
// What a snapshot leaves out: what a copy works out for itself (budget lines, month totals, the worked-out
// columns of `budget`) and what only the server keeps (the omitted columns of a synced table).
import type { Db } from '@ledgerline/db/sql';
import { sha256, toHex } from '@ledgerline/seal';
import type { SyncRow, SyncTable } from '../sync-tables.js';
import { RECORDED_TABLES, WORKED_OUT } from './engine.js';

/** The tables a snapshot holds: everything an entry of the log can change, the bank log included (D-103). */
export const SNAPSHOT_TABLES: readonly SyncTable[] = RECORDED_TABLES;

/**
 * The rules a table's hash follows, by version. A snapshot names the version it was written with, and a device
 * opens and checks it by those rules: a later release that hashes differently still opens every older snapshot it
 * knows the rules of. `ownClock`: columns a copy writes from its own clock when it works things out (derive()
 * stamps the budget row); they differ between two honest copies, so the hash leaves them out like the worked-out
 * columns themselves.
 */
const HASH_RULES: Record<number, { ownClock: Record<string, readonly string[]> }> = {
  1: { ownClock: { budget: ['updated_at'] } },
};

/** The version of the hash rules this release writes snapshots with. */
export const TABLE_HASH_VERSION = 1;

const ownClockOf = (version: number): Record<string, readonly string[]> => {
  const rules = HASH_RULES[version];
  if (!rules) throw new SnapshotNewer();
  return rules.ownClock;
};

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
 * to compare with (its writer's); a table it doesn't list (a snapshot from before the bank log was in snapshots)
 * is left out. Without it, this copy's own. `tables`: which tables (the move compares fewer). `version`: the hash
 * rules (`hashVersionOfChunk`); this release's without it. One this release doesn't know throws `SnapshotNewer`.
 */
export async function tableHashes(
  db: Db,
  schema?: SnapshotSchema,
  tables: readonly SyncTable[] = SNAPSHOT_TABLES,
  version = TABLE_HASH_VERSION,
): Promise<{ name: string; hash: Uint8Array<ArrayBuffer> }[]> {
  const ownClock = ownClockOf(version);
  const with_ = schema ?? (await ownSchema(db));
  for (const name of Object.keys(with_))
    if (!SNAPSHOT_TABLES.some((t) => t.name === name)) throw new SnapshotNewer();
  const out = [];
  const enc = new TextEncoder();
  for (const t of tables) {
    if (!with_[t.name]) continue;
    const cols = (await columnsFor(db, t, with_)).filter((c) => !ownClock[t.name]?.includes(c));
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

/** How far a table-by-table hashing has come (`hashStep`): small, and plain JSON. */
export interface HashProgress {
  /** The tables done, in order. */
  done: { name: string; hash: string }[];
  /** In the table after those: the key of the last row hashed (null: none yet), and the hash so far. */
  last: unknown[] | null;
  h: string;
}
export const HASH_START: HashProgress = { done: [], last: null, h: '00'.repeat(32) };

const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytesOf = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * `tableHashes` in steps, for a server that may spend only a little time in one request: hashes at most `rows`
 * rows (or `bytes` bytes of them) from where `p` stopped, and gives the new place. The hashes are the very ones
 * `tableHashes` gives; `finished` when every table is done.
 */
export async function hashStep(
  db: Db,
  p: HashProgress,
  rows: number,
  bytes: number,
  tables: readonly SyncTable[] = SNAPSHOT_TABLES,
): Promise<{ progress: HashProgress; finished: boolean }> {
  const enc = new TextEncoder();
  const done = [...p.done];
  let last = p.last;
  let h = bytesOf(p.h);
  let leftRows = rows;
  let leftBytes = bytes;
  while (done.length < tables.length) {
    const t = tables[done.length]!;
    const cols = (await ownColumns(db, t)).filter(
      (c) => !ownClockOf(TABLE_HASH_VERSION)[t.name]?.includes(c),
    );
    let ended = cols.length === 0;
    while (!ended && leftRows > 0 && leftBytes > 0) {
      const after = `(${t.pk.join(', ')}) > (${t.pk.map((_, i) => `?${i + 1}`).join(', ')})`;
      const take = Math.min(PAGE, leftRows);
      const page: { results: Record<string, unknown>[] } = await db
        .prepare(
          `SELECT ${[...cols].sort().join(', ')} FROM ${t.name} ${last ? `WHERE ${after}` : ''}
           ORDER BY ${t.pk.join(', ')} LIMIT ${take}`,
        )
        .bind(...(last ?? []))
        .all<Record<string, unknown>>();
      for (const d of page.results) {
        const row: SyncRow = { t: t.name, k: t.pk.map((c) => d[c]), d };
        const text = enc.encode(JSON.stringify(row));
        const joined = new Uint8Array(32 + text.length);
        joined.set(h);
        joined.set(text, 32);
        h = await sha256(joined);
        leftBytes -= text.length;
      }
      leftRows -= page.results.length;
      if (page.results.length) last = t.pk.map((c) => page.results[page.results.length - 1]![c]);
      if (page.results.length < take) ended = true;
    }
    if (!ended) return { progress: { done, last, h: hexOf(h) }, finished: false };
    done.push({ name: t.name, hash: hexOf(h) });
    last = null;
    h = new Uint8Array(32);
  }
  return { progress: { done, last: null, h: hexOf(h) }, finished: true };
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
  add(JSON.stringify({ schema, hash: TABLE_HASH_VERSION }));
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

/**
 * The version of the hash rules a snapshot was written with, from its first chunk: 1 when it names none (written
 * before the rules had a number). One this release doesn't know throws `SnapshotNewer`.
 */
export function hashVersionOfChunk(first: Uint8Array): number {
  const v = parsed(first)[0]?.hash;
  if (v === undefined) return 1;
  if (!Number.isSafeInteger(v) || (v as number) < 1) throw new SnapshotFormatError('no hash version');
  if (!HASH_RULES[v as number]) throw new SnapshotNewer();
  return v as number;
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
