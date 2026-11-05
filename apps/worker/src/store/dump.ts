// Reading and writing a budget's rows for the full backup and its restore (docs/multi-user.md 8.7). One table at a
// time, in foreign-key order, in pieces of about 50 KB (CPU grows with bytes). Rows are read in primary-key order
// with keyset pagination, so a piece can resume from its cursor. Each table gets a chained fingerprint over a
// canonical encoding, so a restore proves it holds exactly what was saved.
import type { Db, Stmt } from '@ledgerline/db/sql';

/** Tables older backups hold that the server no longer keeps (migration 0006): a restore skips their rows. */
export const DROPPED_TABLES: readonly string[] = [
  'account_month_total',
  'budget_line',
  'month_snapshot',
  'month_total_done',
];

/** A budget's tables, parents before children (computed from the schema's foreign keys). */
export const BUDGET_TABLES = [
  'alert',
  'apply_counter',
  'audit_log',
  'bank_event',
  'bank_page',
  'bank_txn',
  'budget',
  'expected_reimbursement',
  'health_status',
  'holding_snapshot',
  'liability_snapshot',
  'not_same',
  'payee',
  'raw_page',
  'rule',
  'setting',
  'txn_link',
  'txn_overlay',
  'txn_split',
  'usage_daily',
  'usage_event',
  'usage_note',
  'account',
  'category_group',
  'connection',
  'payee_alias',
  'category',
  'manual_pending',
  'provider_account',
  'sync_run',
  'assignment',
  'sync_page',
  'target',
] as const;

/** Rows read per query before trimming to the byte limit (raw and staged pages are up to ~200 KB each). */
const ROWS_PER_READ: Record<string, number> = { raw_page: 1, sync_page: 1, bank_page: 5, bank_event: 25 };
export const STEP_BYTES = 50_000;

export interface Meta {
  /** Columns copied and compared: the table's columns, plus `rowid` first for ordinary rowid tables. */
  cols: string[];
  /** Keyset order: `rowid` for ordinary rowid tables (insertion order is kept), else the primary key. */
  pk: string[];
  /** The table's own columns, without rowid. */
  own: string[];
}

// Cached per database, never by table name alone: the Directory's `budget` table has 4 columns and a store's has
// every budget field, and both kinds of object can share an isolate. (A name-keyed cache once copied a store's
// budget row with the Directory's 4 columns, and verification, using the same columns, didn't notice.)
const metaCache = new WeakMap<object, Map<string, Meta>>();

/** Columns and primary key of a table in this database. */
export async function tableMeta(db: Db, table: string): Promise<Meta> {
  let perDb = metaCache.get(db);
  if (!perDb) {
    perDb = new Map();
    metaCache.set(db, perDb);
  }
  const cached = perDb.get(table);
  if (cached) return cached;
  const r = await db
    .prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string; pk: number; type: string }>();
  const own = r.results.map((c) => c.name);
  const pkCols = r.results.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
  const def = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1`)
    .bind(table)
    .first<string>('sql');
  const withoutRowid = /WITHOUT\s+ROWID/i.test(def ?? '');
  const integerKey = pkCols.length === 1 && /^INTEGER$/i.test(pkCols[0]!.type);
  // Ordinary rowid tables keep their rowids, so queries without ORDER BY return rows in the same order in the
  // restored database (a copy in key order once reordered categories inside month summaries: same numbers, new
  // hashes). INTEGER PRIMARY KEY columns already are the rowid.
  const keepRowid = !withoutRowid && !integerKey;
  const m: Meta = keepRowid
    ? { own, cols: ['rowid', ...own], pk: ['rowid'] }
    : { own, cols: own, pk: pkCols.map((c) => c.name) };
  perDb.set(table, m);
  return m;
}

/** Tables whose destination intentionally holds fewer columns than the source (the Directory's own view of a budget). */

/** The WHERE clause that selects one budget's rows of a table (source side), with its bound value. */
export function budgetFilter(table: string, budgetId: string): { sql: string; args: unknown[] } {
  if (table === 'apply_counter') return { sql: '1', args: [] };
  if (table === 'budget') return { sql: 'id = ?', args: [budgetId] };
  return { sql: 'budget_id = ?', args: [budgetId] };
}

export const NO_FILTER = { sql: '1', args: [] as unknown[] };

/** Canonical encoding of a row: typed values in column order. */
export function canon(row: Record<string, unknown>, cols: string[]): string {
  return cols
    .map((c) => {
      const v = row[c];
      if (v === null || v === undefined) return 'n';
      if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `r${v}`;
      if (typeof v === 'bigint') return `i${v}`;
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const b =
          v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        return `b${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
      }
      return `t${String(v)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/\u001f/g, '\\u001f')}`;
    })
    .join('\u001f');
}

export interface Chunk {
  rows: Record<string, unknown>[];
  /** Canonical text of the rows, one per line. */
  text: string;
  /** Primary-key values of the last row, to resume from; null when the table is finished. */
  cursor: unknown[] | null;
}

/**
 * The next rows after `cursor` in primary-key order, at most STEP_BYTES of canonical text (at least one row).
 * The same function on both sides gives the same chunk boundaries, so hashes chain identically.
 */
export async function readChunk(
  db: Db,
  table: string,
  meta: Meta,
  filter: { sql: string; args: unknown[] },
  cursor: unknown[] | null,
): Promise<Chunk> {
  const pk = meta.pk;
  const after = cursor
    ? ` AND (${pk.map((c) => `"${c}"`).join(', ')}) > (${pk.map(() => '?').join(', ')})`
    : '';
  const select = meta.cols[0] === 'rowid' ? `rowid AS rowid, *` : '*';
  const sql = `SELECT ${select} FROM "${table}" WHERE ${filter.sql}${after} ORDER BY ${pk.map((c) => `"${c}"`).join(', ')} LIMIT ${ROWS_PER_READ[table] ?? 100}`;
  const r = await db
    .prepare(sql)
    .bind(...filter.args, ...(cursor ?? []))
    .all<Record<string, unknown>>();
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let bytes = 0;
  for (const row of r.results) {
    const line = canon(row, meta.cols);
    if (rows.length > 0 && bytes + line.length > STEP_BYTES) break;
    rows.push(row);
    lines.push(line);
    bytes += line.length + 1;
  }
  const last = rows.at(-1);
  const full = r.results.length === (ROWS_PER_READ[table] ?? 100) || rows.length < r.results.length;
  return {
    rows,
    text: lines.join('\n'),
    cursor: last && full ? pk.map((c) => last[c]) : null,
  };
}

/** Chains a chunk into a table's running hash: sha256(previous hash ‖ chunk text). */
export async function chain(prev: string, text: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prev + '\n' + text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Insert statements for a chunk's rows into the destination (one row per statement: the 100-parameter limit). Only
 * the columns a row has are written, so a backup from before a migration added a column restores with that column's
 * default.
 */
export function insertStatements(db: Db, table: string, meta: Meta, rows: Record<string, unknown>[]): Stmt[] {
  return rows.map((row) => {
    const cols = meta.cols.filter((c) => c in row);
    const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    return db.prepare(sql).bind(...cols.map((c) => row[c] ?? null));
  });
}

/** A table's meta narrowed to the columns a backup had, so its fingerprint compares like with like. */
export function narrowMeta(meta: Meta, backupCols: readonly string[] | undefined): Meta {
  if (!backupCols) return meta;
  const keep = new Set(backupCols);
  return { ...meta, cols: meta.cols.filter((c) => keep.has(c)) };
}
