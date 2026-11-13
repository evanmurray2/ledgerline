// lib/dates.ts: dates and months formatted by hand, clock times in the budget's time zone.
import { afterEach, describe, expect, it } from 'vitest';
import {
  addMonths,
  budgetDateTime,
  budgetTime,
  compareMonths,
  dayLabel,
  monthLabel,
  monthName,
  monthShort,
  setBudgetTimeZone,
  setBudgetYear,
  syncedLabel,
} from '../src/lib/dates';

afterEach(() => {
  setBudgetTimeZone('America/Los_Angeles');
  setBudgetYear('2026-11-14');
});

describe('months', () => {
  it('names a month', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
    expect(monthName('2026-01')).toBe('January');
    expect(monthShort('2026-09')).toBe('Sep');
  });

  it('adds months across years, both ways', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 0)).toBe('2026-11');
    expect(addMonths('2026-11', -23)).toBe('2024-12');
  });

  it('compares months', () => {
    expect(compareMonths('2026-10', '2026-11')).toBe(-1);
    expect(compareMonths('2026-11', '2026-11')).toBe(0);
    expect(compareMonths('2027-01', '2026-12')).toBe(1);
  });
});

describe('days', () => {
  it('shows the year only for a day in another year than the budget’s today', () => {
    setBudgetYear('2026-11-14');
    expect(dayLabel('2026-11-14')).toBe('Nov 14');
    expect(dayLabel('2027-01-01')).toBe('Jan 1, 2027');
  });
});

describe('clock times in the budget’s time zone', () => {
  const at = Date.parse('2026-11-14T17:05:00Z');

  it('follows the zone the session sets', () => {
    setBudgetTimeZone('America/Los_Angeles');
    expect(budgetTime(at)).toBe('9:05 AM');
    setBudgetTimeZone('America/New_York');
    expect(budgetTime(at)).toBe('12:05 PM');
    expect(budgetTime('not a time')).toBe('');
  });

  it('shows a time for today, a day otherwise', () => {
    setBudgetTimeZone('America/Los_Angeles');
    expect(syncedLabel(null, '2026-11-14')).toBe('never');
    expect(syncedLabel(at, '2026-11-14')).toBe('9:05 AM');
    expect(syncedLabel(at, '2026-11-15')).toBe('Nov 14');
    expect(budgetDateTime(at)).toBe('Nov 14, 9:05 AM');
  });
});
