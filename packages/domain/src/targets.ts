// Targets (design: Targets). Each produces one number per month, "needed this month", which drives funding
// status and the Assign sheet. Money in cents; when an amount doesn't divide evenly, the remainder goes to the
// last month of the period (decisions.md D-23).
import { type Cents, cents } from './money.js';
import { type Month, addMonths, monthsBetween } from './month.js';

export type Target =
  /** Have A available for each period of `periodMonths` (1, 3, 6, 12), anchored at `anchor`. */
  | { type: 'refill'; amount: Cents; periodMonths: number; anchor: Month }
  /** Assign N every month regardless of balance. */
  | { type: 'set_aside'; amount: Cents }
  /** Reach B by the start of `targetMonth`, in even monthly steps. */
  | { type: 'by_date'; amount: Cents; targetMonth: Month }
  /** Reach B eventually; optional monthly contribution C. */
  | { type: 'no_date'; amount: Cents; monthly: Cents | null };

export interface TargetVersion {
  target: Target | null;
  effectiveFrom: Month;
}

/** Targets are versioned: the version in force for a month is the latest one effective at or before it. */
export function targetFor(versions: readonly TargetVersion[], month: Month): Target | null {
  let best: TargetVersion | null = null;
  for (const v of versions)
    if (v.effectiveFrom <= month && (!best || v.effectiveFrom > best.effectiveFrom)) best = v;
  return best?.target ?? null;
}

export interface TargetContext {
  month: Month;
  /** a: assigned so far this month. */
  assignedThisMonth: Cents;
  /** X: available at the start of this month (carry, before this month's assignment). */
  availableAtMonthStart: Cents;
  /** S: available at the start of the current refill period. */
  availableAtPeriodStart: Cents;
  /** P: assigned earlier in this refill period (months before this one), counted from `periodFrom`. */
  assignedEarlierInPeriod: Cents;
  /**
   * The first month of this refill period that counts: the later of the period start, the budget start and the month
   * the target was set. Earlier months of the period couldn't be funded, so the steps spread over the months left.
   * S is the available at the start of this month.
   */
  periodFrom?: Month;
}

export function refillPeriod(
  t: { periodMonths: number; anchor: Month },
  month: Month,
): { start: Month; end: Month; monthsLeft: number } {
  const n = Math.max(1, t.periodMonths);
  const k = Math.floor(monthsBetween(t.anchor, month) / n);
  const start = addMonths(t.anchor, k * n);
  const end = addMonths(start, n - 1);
  return { start, end, monthsLeft: monthsBetween(month, end) + 1 };
}

/** Even steps with the remainder in the last step: floor until the last month, then whatever is left. */
function step(remaining: number, monthsLeft: number): number {
  if (remaining <= 0) return 0;
  if (monthsLeft <= 1) return remaining;
  return Math.floor(remaining / monthsLeft);
}

export function neededThisMonth(t: Target | null, c: TargetContext): Cents {
  if (!t) return cents(0);
  const a = c.assignedThisMonth;
  switch (t.type) {
    case 'refill': {
      // Even steps from the period start: month k of n should have k × floor((A − S) / n) assigned by its end; the
      // last month takes the remainder. Spending during the period doesn't raise the need.
      const { start, end, monthsLeft } = refillPeriod(t, c.month);
      const from = c.periodFrom && c.periodFrom > start && c.periodFrom <= c.month ? c.periodFrom : start;
      const n = monthsBetween(from, end) + 1;
      const total = t.amount - c.availableAtPeriodStart;
      if (total <= 0) return cents(0);
      const k = n - monthsLeft + 1;
      const due = monthsLeft <= 1 ? total : k * Math.floor(total / n);
      return cents(Math.max(0, due - c.assignedEarlierInPeriod - a));
    }
    case 'set_aside':
      return cents(Math.max(0, t.amount - a));
    case 'by_date': {
      const m = monthsBetween(c.month, t.targetMonth);
      if (m <= 0) return cents(Math.max(0, t.amount - c.availableAtMonthStart - a));
      return cents(Math.max(0, step(t.amount - c.availableAtMonthStart, m) - a));
    }
    case 'no_date':
      if (t.monthly === null) return cents(0);
      return cents(Math.max(0, Math.min(t.monthly, t.amount - c.availableAtMonthStart) - a));
  }
}

export function describeTarget(t: Target | null, fmt: (c: Cents) => string): string {
  if (!t) return 'No target';
  switch (t.type) {
    case 'refill':
      return t.periodMonths === 1
        ? `Refill to ${fmt(t.amount)} every month`
        : `Refill to ${fmt(t.amount)} every ${t.periodMonths} months`;
    case 'set_aside':
      return `Set aside ${fmt(t.amount)} every month`;
    case 'by_date':
      return `${fmt(t.amount)} by ${monthName(t.targetMonth)}`;
    case 'no_date':
      return t.monthly ? `${fmt(t.amount)}, ${fmt(t.monthly)} a month` : `${fmt(t.amount)} eventually`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthName(m: Month, long = false): string {
  const i = Number(m.slice(5, 7)) - 1;
  const names = long
    ? [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ]
    : MONTHS;
  return `${names[i]} ${m.slice(0, 4)}`;
}
