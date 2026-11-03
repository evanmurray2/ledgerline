// One month for the app (docs/month-header.md): Budget, Activity and Reports show the same month, carried in
// each one's `?month=` (no month means this month, so the app moves on by itself when the month turns). The tab
// bar and the sidebar carry the month of the screen you're on; from a screen without one (a register, Settings)
// they use the last month a month screen showed. That is kept in memory only: starting the app opens this month.
import { useRouterState } from '@tanstack/react-router';
import { compareMonths } from '../lib/dates';

let last: string | undefined;

/** Screens whose `?month=` is the app's month (Targets is the Budget's month, opened from it). */
export function isMonthScreen(path: string): boolean {
  return /^\/(budget|activity|reports|targets)(\/|$)/.test(path);
}

/** The `?month=` a tab link carries: the month on screen, or the last one chosen; undefined for this month. */
export function useTabMonth(): string | undefined {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const month = useRouterState({
    select: (s) => (s.location.search as { month?: unknown }).month,
  });
  if (!isMonthScreen(path)) return last;
  last = typeof month === 'string' ? month : undefined;
  return last;
}

/**
 * The month a screen shows: the `?month=` asked for, kept inside the screen's range. Budget looks ahead; Activity
 * and Reports stop at this month and show it when a later month is asked for, without changing the app's month.
 */
export function clampMonth(month: string | undefined, min?: string, max?: string): string | undefined {
  if (!month) return month;
  if (max && compareMonths(month, max) > 0) return max;
  if (min && compareMonths(month, min) < 0) return min;
  return month;
}
