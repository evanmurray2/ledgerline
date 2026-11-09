// Reading bank rows as processing sees them, shared by processing (process.ts) and Not the same on a pair of two bank
// rows (routes/same-purchase.ts), which files the posted row again as a new row. Kept apart from process.ts so the
// phone's engine doesn't load the sync's provider code.
import type { Scoped } from '../db/scoped.js';
import type { BankRow } from './process.js';

/** Bank rows by provider id, with what processing needs of their account and connection. */
export async function loadBankRows(s: Scoped, ids: readonly string[]): Promise<BankRow[]> {
  const rows: BankRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    rows.push(
      ...(await s.all<BankRow>(
        `SELECT b.provider_txn_id, b.txn_key, a.id AS account_id, a.kind AS account_kind, a.budget_from, b.amount, b.date, b.authorized_date, b.pending,
           b.pending_provider_txn_id, b.raw_name, b.plaid_name, b.merchant_name, b.merchant_entity_id, b.provider_category, b.payment_channel,
           b.removed_at, b.first_apply_seq, c.linked_at
         FROM bank_txn b
         LEFT JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
         LEFT JOIN connection c ON c.id = b.connection_id
         WHERE +b.budget_id = ?1 AND b.provider_txn_id IN (${chunk.map((_, j) => `?${j + 2}`).join(',')})
         ORDER BY b.connection_id, b.created_at, b.provider_txn_id`,
        ...chunk,
      )),
    );
  }
  return rows;
}
