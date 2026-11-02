// The money and calendar helpers on their own (the property tests cover them only through computeBudget).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ceilDiv, cents, formatCents, fractionOf, parseCents, splitEvenly } from '../src/money.js';
import { currentMonth, localDate, month, parseImportDate } from '../src/month.js';

describe('parseCents', () => {
  it('reads the usual ways an amount is written', () => {
    expect(parseCents('1,234.5')).toBe(123450);
    expect(parseCents('-12')).toBe(-1200);
    expect(parseCents('$3.07')).toBe(307);
    expect(parseCents('−$18.25')).toBe(-1825);
    expect(parseCents('$-4')).toBe(-400);
    expect(parseCents('(12.00)')).toBe(-1200);
    expect(parseCents('($1,018.10)')).toBe(-101810);
    expect(parseCents('.75')).toBe(75);
    expect(parseCents(' 1 000 ')).toBe(100000);
  });

  it('refuses what it would misread', () => {
    // A decimal comma would otherwise become a hundred times the amount.
    for (const bad of ['12,50', '1,23', '1,2345.00', '', '.', '1.234', 'abc', '(-5)', '$$5', '1e5'])
      expect(() => parseCents(bad), bad).toThrow(RangeError);
  });

  it('round-trips with formatCents', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e11, max: 1e11 }), (n) => {
        expect(parseCents(formatCents(n))).toBe(n);
      }),
    );
  });
});

describe('splitting and fractions', () => {
  it('splitEvenly sums to the total and puts the remainder last', () => {
    expect(splitEvenly(cents(1000), 3)).toEqual([333, 333, 334]);
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 1, max: 36 }), (t, n) => {
        const parts = splitEvenly(cents(t), n);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(t);
        for (const p of parts.slice(0, -1)) expect(p).toBe(parts[0]);
      }),
    );
  });

  it('fractionOf rounds half away from zero and never exceeds the amount', () => {
    expect(fractionOf(cents(5), 1, 2)).toBe(3);
    expect(fractionOf(cents(-5), 1, 2)).toBe(-3);
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.integer({ min: 1, max: 1000 }), (a, den) => {
        const num = Math.floor(den / 3);
        const v = fractionOf(cents(a), num, den);
        expect(Math.abs(v)).toBeLessThanOrEqual(Math.abs(a));
        expect(Math.abs(v - (a * num) / den)).toBeLessThanOrEqual(0.5);
      }),
    );
  });

  it('ceilDiv rounds up without floating point surprises', () => {
    expect(ceilDiv(10, 3)).toBe(4);
    expect(ceilDiv(9, 3)).toBe(3);
    expect(ceilDiv(-10, 3)).toBe(-3);
    expect(() => ceilDiv(1, 0)).toThrow(RangeError);
  });
});

describe('the month boundary in Los Angeles', () => {
  const LA = 'America/Los_Angeles';
  it('a minute before local midnight is still the old month; a minute after is the new one', () => {
    // Nov 30, 2026 23:59 PST is Dec 1, 07:59 UTC.
    expect(localDate(Date.parse('2026-12-01T07:59:00Z'), LA)).toBe('2026-11-30');
    expect(currentMonth(Date.parse('2026-12-01T07:59:00Z'), LA)).toBe(month('2026-11'));
    expect(localDate(Date.parse('2026-12-01T08:01:00Z'), LA)).toBe('2026-12-01');
    expect(currentMonth(Date.parse('2026-12-01T08:01:00Z'), LA)).toBe(month('2026-12'));
  });

  it('daylight saving time moves the boundary by an hour', () => {
    // Mar 31, 2026 23:59 PDT is Apr 1, 06:59 UTC.
    expect(currentMonth(Date.parse('2026-04-01T06:59:00Z'), LA)).toBe(month('2026-03'));
    expect(currentMonth(Date.parse('2026-04-01T07:01:00Z'), LA)).toBe(month('2026-04'));
  });
});

describe('dates in imported files', () => {
  it('reads ISO and US dates, and refuses anything that is not a real day', () => {
    expect(parseImportDate('2026-11-02')).toBe('2026-11-02');
    expect(parseImportDate('11/2/2026')).toBe('2026-11-02');
    expect(parseImportDate('2/29/2028')).toBe('2028-02-29');
    for (const bad of ['25/12/2025', '2/30/2026', '2026-13-01', '2/29/2026', '11-02-2026', ''])
      expect(parseImportDate(bad), bad).toBeNull();
  });
});
