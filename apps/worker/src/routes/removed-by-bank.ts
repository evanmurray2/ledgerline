// Activity's "Removed by the bank" rows: a bank pending row that went away with nothing posted after 5 days
// (the daily scan's `vanished_pending` alert), usually a released hold. Each row names the charge from the bank's
// removed row, which stays in bank_txn. OK dismisses the alert (POST /api/alerts/:id/dismiss).
import type { ActivityView } from '@ledgerline/contracts';
import { cents } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';

interface RemovedDb {
  id: string;
  amount: number | null;
  date: string | null;
  payee: string | null;
  account: string | null;
}

export async function removedByBank(s: Scoped): Promise<ActivityView['removedByBank']> {
  const rows = await s.all<RemovedDb>(
    `SELECT al.id, b.amount, b.date, coalesce(p.name, b.merchant_name, b.raw_name) AS payee, ac.name AS account
       FROM alert al
       LEFT JOIN bank_txn b ON b.provider_txn_id = (
         SELECT x.provider_txn_id FROM bank_txn x WHERE x.budget_id = al.budget_id AND x.txn_key = al.ref_key
          ORDER BY x.pending DESC, x.updated_at DESC LIMIT 1)
       LEFT JOIN txn_overlay o ON o.txn_key = al.ref_key
       LEFT JOIN payee p ON p.id = o.payee_id
       LEFT JOIN account ac ON ac.budget_id = al.budget_id AND ac.provider_account_id = b.provider_account_id
      WHERE al.budget_id = ?1 AND al.type = 'vanished_pending' AND al.acked_at IS NULL
      ORDER BY b.date DESC, al.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    payee: r.payee ?? 'Pending charge',
    amount: cents(r.amount ?? 0),
    date: r.date,
    accountName: r.account,
  }));
}
