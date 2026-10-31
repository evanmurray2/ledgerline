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

/**
 * Low (spending categories only): less than 20% of the period amount left (or below the per-category amount), or
 * month-to-date spending more than 30 points ahead of the month's elapsed share. Spending share is spent ÷ (spent +
 * available) (decisions.md D-18).
 */
export function isLow(s: StatusInput): boolean {
  if (s.kind !== 'spending' || s.isBill || s.available <= 0) return false;
  const period = s.target ? s.target.amount : null;
  if (s.lowThreshold !== null) {
    if (s.available < s.lowThreshold) return true;
  } else if (period !== null && s.available * 5 < period) {
    return true; // available < 20% of the period amount, in integers
  }
  const total = s.spent + s.available;
  if (total <= 0 || s.spent <= 0) return false;
  return s.spent / total - elapsedShare(s.month, s.today) > 0.3;
}

export function isOverfunded(s: StatusInput): boolean {
  const t = s.target;
  if (!t) return false;
  switch (t.type) {
    case 'refill':
      return s.available > t.amount;
    case 'set_aside':
      return s.assignedThisMonth > t.amount;
    case 'by_date':
    case 'no_date':
      return s.available > t.amount;
  }
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
    case 'overfunded': {
      const t = s.target!;
      return cents(-(t.type === 'set_aside' ? s.assignedThisMonth - t.amount : s.available - t.amount));
    }
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
