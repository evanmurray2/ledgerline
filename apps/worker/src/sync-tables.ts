// The tables the phone keeps a copy of (docs/phone-budget.md section 7, decisions.md D-45), with their primary keys.
// The server logs every change to these in change_log (triggers from migration 0003, or from the migration that adds
// the table), serves them from /api/sync, and the phone's engine (src/local) writes them into its own SQLite.
// Everything else is either server-only (bank log, sync runs, jobs, usage) or worked out on the phone (budget_line,
// month_snapshot, the month totals).

export interface SyncTable {
  name: string;
  pk: readonly string[];
  /** Columns never sent to the phone (secrets and server bookkeeping). */
  omit?: readonly string[];
}

export const SYNC_TABLES: readonly SyncTable[] = [
  { name: 'budget', pk: ['id'] },
  {
    name: 'connection',
    pk: ['id'],
    omit: ['access_token_enc', 'key_version', 'cursor', 'sync_lock', 'lock_expires'],
  },
  { name: 'provider_account', pk: ['id'] },
  { name: 'liability_snapshot', pk: ['id'] },
  { name: 'account', pk: ['id'] },
  { name: 'category_group', pk: ['id'] },
  { name: 'category', pk: ['id'] },
  { name: 'assignment', pk: ['budget_id', 'month', 'category_id'] },
  { name: 'target', pk: ['id'] },
  { name: 'payee', pk: ['id'] },
  { name: 'payee_alias', pk: ['id'] },
  { name: 'rule', pk: ['id'] },
  { name: 'bank_txn', pk: ['provider_txn_id'] },
  { name: 'txn_overlay', pk: ['txn_key'] },
  { name: 'manual_pending', pk: ['id'] },
  { name: 'txn_split', pk: ['id'] },
  { name: 'txn_link', pk: ['id'] },
  { name: 'expected_reimbursement', pk: ['id'] },
  { name: 'alert', pk: ['id'] },
  { name: 'setting', pk: ['budget_id', 'key'] },
  { name: 'health_status', pk: ['budget_id', 'key'] },
  // "Same purchase?" answered No (migration 0007, which writes its triggers).
  { name: 'not_same', pk: ['budget_id', 'a_key', 'b_key'] },
];

export const SYNC_TABLE_NAMES: ReadonlySet<string> = new Set(SYNC_TABLES.map((t) => t.name));

/** Format of /api/sync answers; a phone on another format downloads everything again. */
export const SYNC_FORMAT = 1;

/** The trigger names a table gets from migration 0003, or a later one adding it (a test checks every one exists). */
export function triggerNames(table: string): string[] {
  return [`${table}_sync_ins`, `${table}_sync_upd`, `${table}_sync_key`, `${table}_sync_del`];
}

/**
 * SQL for the change_log triggers of one table, as written into migration 0003 (and 0007 for not_same). `seq` is one
 * more than the highest logged so far: change_log rows are never deleted, so numbers never go backwards or repeat.
 */
export function triggerSql(t: SyncTable): string {
  const pk = (row: 'NEW' | 'OLD') => `json_array(${t.pk.map((c) => `${row}.${c}`).join(', ')})`;
  const log = (row: 'NEW' | 'OLD', deleted: 0 | 1) =>
    `INSERT INTO change_log (tbl, pk, seq, deleted) VALUES ('${t.name}', ${pk(row)}, (SELECT coalesce(max(seq), 0) + 1 FROM change_log), ${deleted}) ON CONFLICT (tbl, pk) DO UPDATE SET seq = excluded.seq, deleted = ${deleted};`;
  const changed = t.pk.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
  const [ins, upd, key, del] = triggerNames(t.name);
  return [
    `CREATE TRIGGER ${ins} AFTER INSERT ON ${t.name} BEGIN ${log('NEW', 0)} END;`,
    `CREATE TRIGGER ${upd} AFTER UPDATE ON ${t.name} BEGIN ${log('NEW', 0)} END;`,
    // A changed primary key: the old one is gone for the phone.
    `CREATE TRIGGER ${key} AFTER UPDATE OF ${t.pk.join(', ')} ON ${t.name} WHEN ${changed} BEGIN ${log('OLD', 1)} END;`,
    `CREATE TRIGGER ${del} AFTER DELETE ON ${t.name} BEGIN ${log('OLD', 1)} END;`,
  ].join('\n');
}
