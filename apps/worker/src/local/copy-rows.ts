// What a copy checks and writes when rows come in (local/engine.ts): rows from another device through the log, or
// the rows kept for taking an edit back out. Nothing here keeps state of its own but a cache of table columns.
import type { Db, Stmt } from '@ledgerline/db/sql';
import { SYNC_TABLES, type SyncRow, type SyncTable } from '../sync-tables.js';
import type { PendingDerive } from './engine.js';

/** Rows that no honest writer makes (checkRows): nothing of them was written. */
export class RowsRefused extends Error {}

/**
 * Which transactions' lines and which months a sync page changes. Rows that only change what screens read
 * directly (payees, rules, alerts, balances, targets, settings) need no derive at all.
 */
export async function noteChanges(db: Db, rows: readonly SyncRow[], todo: PendingDerive): Promise<void> {
  const keyCols: Record<string, string[]> = {
    bank_txn: ['txn_key'],
    manual_pending: ['txn_key'],
    txn_split: ['txn_key'],
    expected_reimbursement: ['txn_key'],
    owed_close: ['txn_key'],
    txn_link: ['from_key', 'to_key'],
    txn_overlay: ['txn_key'],
  };
  const month = (m: unknown) => {
    if (typeof m === 'string' && (!todo.fromMonth || m < todo.fromMonth)) todo.fromMonth = m;
  };
  for (const r of rows) {
    const t = SYNC_TABLES.find((x) => x.name === r.t);
    if (!t) continue;
    const cols = keyCols[r.t];
    if (cols) {
      const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
      const old = await db
        .prepare(
          `SELECT ${[...cols, ...(r.t === 'manual_pending' ? ['covers_provider_txn_id'] : [])].join(', ')} FROM ${r.t} WHERE ${where}`,
        )
        .bind(...r.k)
        .first<Record<string, unknown>>();
      for (const c of cols) {
        if (old?.[c]) todo.keys.push(String(old[c]));
        if (r.d?.[c]) todo.keys.push(String(r.d[c]));
      }
      // A posted bank row removed can change another row's place: a reissue of it keeps its arrival, so that row
      // moves out of the starting balance (ledger/link.ts, D-67). Rare, so everything is rebuilt.
      if (r.t === 'bank_txn' && r.d?.removed_at && r.d.pending === 0) todo.full = true;
      // An entry's cover hides the bank pending row it covers (docs/payee-names.md 9.2): any change to the entry
      // (the cover, deleted, matched) can show or hide that row, before or after.
      if (r.t === 'manual_pending')
        for (const id of [old?.covers_provider_txn_id, r.d?.covers_provider_txn_id]) {
          if (typeof id !== 'string') continue;
          const b = await db
            .prepare(`SELECT txn_key FROM bank_txn WHERE provider_txn_id = ?1`)
            .bind(id)
            .first<{ txn_key: string }>();
          if (b) todo.keys.push(b.txn_key);
        }
    } else if (r.t === 'assignment') month(r.k[1]);
    else if (r.t === 'category') todo.fromStart = true;
    else if (r.t === 'account') todo.full = true;
    else if (r.t === 'budget') {
      const b = await db
        .prepare(`SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`)
        .bind(r.k[0])
        .first<{ budget_start_month: string | null; time_zone: string }>();
      if (!b || !r.d || b.budget_start_month !== r.d.budget_start_month || b.time_zone !== r.d.time_zone)
        todo.full = true;
    }
  }
}

/** A table's columns, read once per copy. */
export type Columns = (table: string) => Promise<Set<string>>;

export function columnsOf(db: Db): Columns {
  const known = new Map<string, Set<string>>();
  return async (table) => {
    let c = known.get(table);
    if (!c) {
      const info = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
      c = new Set(info.results.map((x) => x.name));
      known.set(table, c);
    }
    return c;
  };
}

/**
 * Refuses rows no honest writer makes, before any of them is written: a table that is not one of `tables`
 * (`strict`: the rows of a log entry; a sync skips a table it doesn't know, as a newer server may have one), a
 * key of the wrong length, a column the table doesn't have, a value that is not text, a number or null, or a
 * row whose key columns differ from its key. A row's table and column names go into SQL, so they must be the
 * copy's own names and nothing else: rows come from the server, or from another device through the log.
 */
export async function checkRows(
  columns: Columns,
  rows: readonly SyncRow[],
  tables: readonly SyncTable[],
  strict: boolean,
): Promise<void> {
  const scalar = (v: unknown) =>
    v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
  const refuse = (why: string): never => {
    throw new RowsRefused(why);
  };
  for (const r of rows) {
    if (!r || typeof r.t !== 'string') return refuse('not a row');
    const t = tables.find((x) => x.name === r.t);
    if (!t) {
      if (strict) refuse('a table this copy does not keep');
      continue;
    }
    if (!Array.isArray(r.k) || r.k.length !== t.pk.length || !r.k.every(scalar)) refuse(`${t.name}: its key`);
    if (r.d === null) continue;
    if (typeof r.d !== 'object' || Array.isArray(r.d)) refuse(`${t.name}: not a row`);
    const cols = await columns(t.name);
    for (const [c, v] of Object.entries(r.d)) {
      if (!cols.has(c)) refuse(`${t.name}: a column this copy does not have`);
      if (!scalar(v)) refuse(`${t.name}: a value that is not text, a number or null`);
    }
    t.pk.forEach((c, i) => {
      if (r.d![c] !== r.k[i]) refuse(`${t.name}: the row is not the one its key names`);
    });
  }
}

export function rowStatements(db: Db, r: SyncRow, tables: readonly SyncTable[] = SYNC_TABLES): Stmt[] {
  const t = tables.find((x) => x.name === r.t);
  if (!t) return [];
  const where = t.pk.map((c, i) => `${c} = ?${i + 1}`).join(' AND ');
  if (!r.d) return [db.prepare(`DELETE FROM ${t.name} WHERE ${where}`).bind(...r.k)];
  const cols = Object.keys(r.d);
  const vals = cols.map((c) => r.d![c]);
  const update = cols
    .filter((c) => !t.pk.includes(c))
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  // The server's row replaces a row of the copy that is the same thing under another primary key (an edit made
  // offline gave it an id of its own): without this the row's other unique key refuses the write, and every later
  // page with it.
  const displaced = (t.unique ?? [])
    .filter((key) => key.every((c) => r.d![c] !== undefined && r.d![c] !== null))
    .map((key) =>
      db
        .prepare(
          `DELETE FROM ${t.name} WHERE ${key.map((c, i) => `${c} = ?${i + 1}`).join(' AND ')}
             AND NOT (${t.pk.map((c, i) => `${c} = ?${key.length + i + 1}`).join(' AND ')})`,
        )
        .bind(...key.map((c) => r.d![c]), ...r.k),
    );
  return [
    ...displaced,
    db
      .prepare(
        `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})
         ON CONFLICT ${t.appendOnly ? '' : `(${t.pk.join(', ')}) `}DO ${update && !t.appendOnly ? `UPDATE SET ${update}` : 'NOTHING'}`,
      )
      .bind(...vals),
  ];
}
