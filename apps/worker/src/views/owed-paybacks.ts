// OwedView.paidBack: money in that paid back what is owed to you, for Owed to you · Paid back recently. Each entry is
// one inflow with what Match linked it to (txn_link reimbursement_of). It shows the links only: all of the money is
// in Ready to Assign either way (D-98).
import type { OwedView } from '@ledgerline/contracts';
import { cents } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { txnCol } from '../ledger/ledger.js';

/** How far back "recently" reaches, and how many inflows it lists. */
export const PAID_BACK_DAYS = 60;
export const PAID_BACK_MAX = 10;

/** `labels`: each owed item's name on the list (its purchase's payee), by item id. */
export async function recentPaybacks(
  s: Scoped,
  today: string,
  labels: ReadonlyMap<string, string>,
): Promise<OwedView['paidBack']> {
  const links = await s.all<{
    from_key: string;
    to_key: string;
    amount: number | null;
    date: string;
    payee: string;
  }>(
    `SELECT l.from_key, l.to_key, l.amount, d.date, d.payee FROM txn_link l
     JOIN (SELECT from_key, ${txnCol('from_key', 'date')} AS date, coalesce(${txnCol('from_key', 'payee')}, '') AS payee
           FROM (SELECT DISTINCT from_key FROM txn_link
                 WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL)) d ON d.from_key = l.from_key
     WHERE l.budget_id = ?1 AND l.kind = 'reimbursement_of' AND l.undone_at IS NULL
       AND d.date >= date(?2, '-${PAID_BACK_DAYS} days')
     ORDER BY d.date DESC, l.from_key, l.created_at, l.id`,
    today,
  );
  const out: OwedView['paidBack'] = [];
  for (const l of links) {
    const amount = cents(l.amount ?? 0);
    if (amount <= 0) continue;
    let e = out.at(-1);
    if (e?.key !== l.from_key) {
      if (out.length === PAID_BACK_MAX) break;
      e = { key: l.from_key, payee: l.payee, date: l.date, matched: cents(0), items: [] };
      out.push(e);
    }
    e.matched = cents(e.matched + amount);
    e.items.push({ id: l.to_key, label: labels.get(l.to_key) ?? '', amount });
  }
  return out;
}
