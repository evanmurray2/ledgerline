// The tables of a budget's copy on a device (docs/phone-budget.md section 7, decisions.md D-45), with their primary
// keys. A sealed budget's entries and snapshots carry their rows (local/device-log.ts, local/device-snapshot.ts),
// and the device's engine (src/local) writes them into its own SQLite. Everything else is either the server's own
// (the old bank log, sync runs, jobs, usage) or worked out on the device (budget_line, month_snapshot, the month
// totals).

/** One row a copy writes: its table, its primary key, and the row, or null when it was deleted. */
export interface SyncRow {
  /** Table */
  t: string;
  /** Primary key values */
  k: unknown[];
  /** The row, or null when it was deleted */
  d: Record<string, unknown> | null;
}

/** Rows a copy writes in one step, and where the copy stands after them (local/engine.ts apply). */
export interface SyncPage {
  format: number;
  epoch: string;
  serverTime: number;
  /** Where the copy stands once it has written this page: the number of the log's last entry it holds. */
  through: number;
  more: boolean;
  cursor: string | null;
  rows: SyncRow[];
}

export interface SyncTable {
  name: string;
  pk: readonly string[];
  /** Columns never sent to the phone (secrets and server bookkeeping). */
  omit?: readonly string[];
  /**
   * The table's other unique keys. The copy can hold a row that is the same thing under another primary key: an
   * edit made offline gives a new row an id of its own, and the server gives it another. When the server's row
   * arrives, the copy's row with the same unique key goes first, or the write would be refused and the copy would
   * stop syncing (local/engine.ts rowStatements).
   */
  unique?: readonly (readonly string[])[];
  /**
   * Rows are only ever added, never changed (the bank log): a row the copy holds already is left as it is, since
   * its append-only triggers refuse any update (local/engine.ts rowStatements).
   */
  appendOnly?: boolean;
}

export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'budget', pk: ['id'] },
  {
    name: 'connection',
    pk: ['id'],
    omit: ['access_token_enc', 'key_version', 'cursor', 'sync_lock', 'lock_expires'],
  },
  { name: 'provider_account', pk: ['id'], unique: [['connection_id', 'provider_account_id']] },
  { name: 'liability_snapshot', pk: ['id'], unique: [['budget_id', 'provider_account_id', 'as_of']] },
  { name: 'account', pk: ['id'] },
  { name: 'category_group', pk: ['id'] },
  { name: 'category', pk: ['id'] },
  { name: 'assignment', pk: ['budget_id', 'month', 'category_id'] },
  { name: 'target', pk: ['id'], unique: [['category_id', 'effective_from']] },
  { name: 'payee', pk: ['id'] },
  { name: 'payee_alias', pk: ['id'] },
  { name: 'rule', pk: ['id'] },
  { name: 'bank_txn', pk: ['provider_txn_id'] },
  { name: 'txn_overlay', pk: ['txn_key'] },
  { name: 'manual_pending', pk: ['id'], unique: [['txn_key']] },
  { name: 'txn_split', pk: ['id'] },
  { name: 'txn_link', pk: ['id'] },
  { name: 'expected_reimbursement', pk: ['id'] },
  { name: 'alert', pk: ['id'], unique: [['budget_id', 'type', 'ref_key']] },
  { name: 'setting', pk: ['budget_id', 'key'] },
  { name: 'health_status', pk: ['budget_id', 'key'] },
  // "Same purchase?" answered No (migration 0007, which writes its triggers).
  { name: 'not_same', pk: ['budget_id', 'a_key', 'b_key'] },
  // Past closes and undos of owed items (migration 0010, which writes its triggers; D-80).
  { name: 'owed_close', pk: ['id'] },
];

/** Format of a copy's rows; a copy on another format is made again. */
export const SYNC_FORMAT = 1;

/** The trigger names a table gets from migration 0003, or a later one adding it (a test checks every one exists). */
export function triggerNames(table: string): string[] {
  return [`${table}_sync_ins`, `${table}_sync_upd`, `${table}_sync_key`, `${table}_sync_del`];
}
