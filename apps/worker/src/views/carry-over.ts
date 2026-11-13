// BudgetView.carryOver: how this month's Ready to Assign came about, for the "has started" card. Only a display of
// totals computeBudget() already keeps (packages/domain, Money rules): Ready to Assign is inflows up to this month,
// less owed parts, less everything assigned, less the cash overspending of earlier months (rule 6). Split at the end
// of last month, that is
//   rta = left − overspent + inflows(this month) − owed(this month) − assigned(this month and later),
// where `left` is Ready to Assign at the end of last month before its overspending came out. This month's inflows
// are then told apart by the budget lines they came from: paybacks (the matched part of money in, txn_link
// reimbursement_of), Close out (close lines, rule 11) and the rest, income.
import type { BudgetView } from '@ledgerline/contracts';
import { type Month, type MonthResult, cents } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';

export async function carryOver(
  s: Scoped,
  month: Month,
  cur: MonthResult | null,
  prev: MonthResult | null,
  rta: number,
): Promise<BudgetView['carryOver']> {
  if (!cur || !prev) return null;
  const [paid, closed, later] = await s.batch([
    // Each inflow's Ready to Assign lines this month, up to what it pays back. Driven from the links (few), each
    // finding its lines by the key.
    s.q(
      `SELECT coalesce(sum(min(bl.amount, l.total)), 0) AS n
       FROM (SELECT from_key, sum(amount) AS total FROM txn_link
             WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL GROUP BY from_key) l
       JOIN budget_line bl ON bl.budget_id = ?1 AND bl.txn_key = l.from_key
       WHERE bl.kind = 'rta' AND bl.month = ?2 AND bl.amount > 0`,
      month,
    ),
    s.q(
      `SELECT coalesce(sum(amount), 0) AS n FROM budget_line WHERE budget_id = ?1 AND kind = 'close' AND month = ?2`,
      month,
    ),
    s.q(`SELECT coalesce(sum(amount), 0) AS n FROM assignment WHERE budget_id = ?1 AND month >= ?2`, month),
  ]);
  const n = (r: typeof paid) => Number((r!.results[0] as { n: number | null } | undefined)?.n ?? 0);
  const c = prev.snapshot.cum;
  const left = c.inflows - c.owed - c.assigned - (c.uncovered - prev.uncovered);
  const paidBack = n(paid);
  const closedOut = n(closed);
  const assigned = n(later);
  const view = {
    from: prev.month,
    left: cents(left),
    overspent: cents(prev.uncovered),
    income: cents(cur.inflows - paidBack - closedOut),
    paidBack: cents(paidBack),
    closedOut: cents(closedOut),
    owed: cents(cur.owed),
    assigned: cents(assigned),
  };
  // The parts must add up to the Ready to Assign shown; if they don't (a copy still catching up), show none.
  const sum = left - view.overspent + view.income + paidBack + closedOut - view.owed - assigned;
  return sum === rta ? view : null;
}
