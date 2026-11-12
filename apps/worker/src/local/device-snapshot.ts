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
import { sha256, toHex } from '@ledgerline/seal';
import type { SyncRow } from '../routes/sync.js';
import type { SyncTable } from '../sync-tables.js';
import { RECORDED_TABLES, WORKED_OUT } from './engine.js';

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
