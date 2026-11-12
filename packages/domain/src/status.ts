// Funding statuses (design: Targets → Funding statuses). Every Budget row ends in one status word.
import { type Cents, cents } from './money.js';
import { type IsoDate, type Month, dayOfMonth, daysInMonth } from './month.js';
import { type Target } from './targets.js';
import type { CategoryKind } from './budget/compute.js';

export type CategoryStatus =
  'overspent' | 'underfunded' | 'funded' | 'overfunded' | 'low' | 'invested' | 'no_target';

export interface StatusInput {
  kind: Exclude<CategoryKind, 'cc_payment'>;
  /** Bills (a bills group or a due date) are never Low (decided Oct 31, 2026). */
  isBill: boolean;
  target: Target | null;
  available: Cents;
  /** Outflows this month (your share), positive. */
  spent: Cents;
  assignedThisMonth: Cents;
  need: Cents;
  /** Optional per-category Low amount. */
  lowThreshold: Cents | null;
  month: Month;
  today: IsoDate;
}

/** Share of the month gone, in [0, 1]: day of month ÷ days in month (current month), 1 for past months, 0 for future. */
export function elapsedShare(month: Month, today: IsoDate): number {
  const t = today.slice(0, 7);
  if (t > month) return 1;
  if (t < month) return 0;
  return dayOfMonth(today) / daysInMonth(month);
}

/** A target funded fresh each month (Refill monthly, Set aside), as opposed to one that builds toward a date or goal. */
function monthlyTarget(t: Target | null): boolean {
  return t !== null && (t.type === 'set_aside' || (t.type === 'refill' && t.periodMonths === 1));
}

/**
 * Low warns that spending is running through a category (spending categories only): below the per-category Low
 * amount if one is set; otherwise, for monthly targets only, less than 20% of the month's amount left after spending,
 * or month-to-date spending more than 30 points ahead of the month's elapsed share. Spending share is spent ÷
 * (spent + available) (decisions.md D-18). Quarterly and yearly refills and balance goals fill up slowly by design,
 * so being far below their full amount is not Low (D-32).
 */
export function isLow(s: StatusInput): boolean {
  if (s.kind !== 'spending' || s.isBill || s.available <= 0) return false;
  if (s.lowThreshold !== null && s.available < s.lowThreshold) return true;
  if (!monthlyTarget(s.target) || s.spent <= 0) return false;
  if (s.lowThreshold === null && s.available * 5 < s.target!.amount) return true; // < 20%, in integers
  const total = s.spent + s.available;
  if (total <= 0 || s.spent <= 0) return false;
  return s.spent / total - elapsedShare(s.month, s.today) > 0.3;
}

/**
 * How much more a category holds than its target asks for (0 when it isn't overfunded). A Set aside target counts
 * only the extra assigned this month that is still unspent: money assigned on top to cover spending, then spent, is
 * not extra (D-69). A Refill category that spent more than its target this month has used the target up, so all the
 * money still left is extra (D-95).
 */
export function overfundedBy(s: StatusInput): Cents {
  const t = s.target;
  if (!t) return cents(0);
  const extra =
    t.type === 'set_aside'
      ? Math.min(s.assignedThisMonth - t.amount, s.available)
      : t.type === 'refill' && s.spent > t.amount
        ? s.available
        : s.available - t.amount;
  return cents(Math.max(0, extra));
}

export function isOverfunded(s: StatusInput): boolean {
  return overfundedBy(s) > 0;
}

export function categoryStatus(s: StatusInput): CategoryStatus {
  if (s.available < 0) return 'overspent';
  // Invested: a saving category whose money left the budget this month as planned.
  if (s.kind === 'saving' && s.spent > 0 && s.need === 0) return 'invested';
  if (!s.target) return 'no_target';
  if (s.need > 0) return 'underfunded';
  if (isOverfunded(s)) return 'overfunded';
  if (isLow(s)) return 'low';
  return 'funded';
}

/** The Needs attention fix for a status, as an amount to move (positive: into the category). */
export function suggestedFix(status: CategoryStatus, s: StatusInput): Cents {
  switch (status) {
    case 'overspent':
      return cents(-s.available);
    case 'underfunded':
      return s.need;
    case 'overfunded':
      return cents(-overfundedBy(s));
    case 'low': {
      // Bring it back to about a third of the period amount, rounded up to whole dollars (the prototype's "Add $20").
      const period = s.target?.amount ?? s.lowThreshold ?? 0;
      const want = Math.ceil((period * 35) / 100) - s.available;
      return cents(Math.max(100, Math.ceil(want / 100) * 100));
    }
    default:
      return cents(0);
  }
}

export type CardStatus = 'covered' | 'short';

/**
 * Rule 7: a card payment category is Covered when it holds at least the card's balance plus budgeted pending minus
 * uncategorized card spending; Short by the difference otherwise. `owed` is the card's working debt (positive).
 */
export function cardStatus(
  available: Cents,
  owed: Cents,
  uncategorized: Cents,
): { status: CardStatus; short: Cents; need: Cents } {
  const need = cents(owed - uncategorized);
  const short = cents(Math.max(0, need - available));
  return { status: short > 0 ? 'short' : 'covered', short, need };
}

export function statementCovered(available: Cents, statementBalance: Cents | null): boolean {
  return statementBalance === null || available >= statementBalance;
}
