// A bank row dated before an account's budget start ("Before your budget", D-61), stored the way CSV history import
// stored one before it was removed: a 'csv' connection's bank row with id `csv_<account>_<date>_<n>`. Production
// budgets may still hold such rows, so the code that reads them stays tested.
import { phoneDb } from './phone.js';

export async function historyRow(
  accountId: string,
  date: string,
  amount: number,
  name: string,
  n = 0,
): Promise<string> {
  const db = phoneDb();
  const now = Date.now();
  const acct = (await db
    .prepare(`SELECT budget_id, provider_account_id FROM account WHERE id = ?1`)
    .bind(accountId)
    .first<{ budget_id: string; provider_account_id: string | null }>())!;
  const providerAccountId = acct.provider_account_id ?? `csv:${accountId}`;
  const connId = `con_import_${accountId}`;
  const id = `csv_${accountId}_${date}_${n}`;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
         VALUES (?1, ?2, 'csv', ?3, ?4, ?4, ?4)`,
      )
      .bind(connId, acct.budget_id, `Import · ${accountId}`, now),
    db
      .prepare(`UPDATE account SET provider_account_id = ?2 WHERE id = ?1 AND provider_account_id IS NULL`)
      .bind(accountId, providerAccountId),
    db
      .prepare(
        `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, 0, 0, ?9, ?9)`,
      )
      .bind(id, acct.budget_id, connId, providerAccountId, amount, date, name, `p:${id}`, now),
  ]);
  return `p:${id}`;
}
