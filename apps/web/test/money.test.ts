import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, MINUS, parseCents, percentOf } from '../src/lib/money';

describe('formatCents', () => {
  it('formats dollars and cents with grouping', () => {
    expect(formatCents(98190)).toBe('$1,999.90');
    expect(formatCents(101800)).toBe('$1,018.00');
    expect(formatCents(2255535)).toBe('$22,555.35');
    expect(formatCents(1887763)).toBe('$18,877.63');
    expect(formatCents(123456789012)).toBe('$1,234,567,890.12');
  });

  it('handles small amounts and zero', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCents(55)).toBe('$0.55');
    expect(formatCents(100)).toBe('$1.00');
  });

  it('uses a true minus sign for negatives', () => {
    expect(formatCents(-1825)).toBe(`${MINUS}$18.25`);
    expect(formatCents(-1825)).toBe('−$18.25');
    expect(formatCents(-1825)).not.toContain('-');
  });

  it('adds a plus sign to inflows only when asked', () => {
    expect(formatCents(101800, { plus: true })).toBe('+$1,018.00');
    expect(formatCents(-3600, { plus: true })).toBe('−$36.00');
    expect(formatCents(0, { plus: true })).toBe('$0.00');
  });

  it('drops .00 for whole amounts on request', () => {
    expect(formatCents(200000, { whole: true })).toBe('$2,000');
    expect(formatCents(41260, { whole: true })).toBe('$412.60');
  });

  it('rejects non-integer cents', () => {
    expect(() => formatCents(18.25)).toThrow();
  });

  it('round-trips every value through parse', () => {
    for (const c of [0, 1, 9, 10, 99, 100, 1825, -1825, 98190, 2255535, -200000, 999999999]) {
      expect(parseCents(formatCents(c))).toBe(c);
      expect(parseCents(centsToInput(c))).toBe(c);
    }
  });
});

describe('parseCents', () => {
  it('parses plain decimals without floating point error', () => {
    expect(parseCents('18.25')).toBe(1825);
    expect(parseCents('0.1')).toBe(10);
    expect(parseCents('0.29')).toBe(29);
    expect(parseCents('1.005')).toBeNull();
    expect(parseCents('4.35')).toBe(435);
    expect(parseCents('19.99')).toBe(1999);
  });

  it('accepts dollar signs, grouping, and both minus signs', () => {
    expect(parseCents('$1,018.00')).toBe(101800);
    expect(parseCents('1,018')).toBe(101800);
    expect(parseCents('-5')).toBe(-500);
    expect(parseCents('−5.5')).toBe(-550);
    expect(parseCents('  42 ')).toBe(4200);
    expect(parseCents('.75')).toBe(75);
    expect(parseCents('12.')).toBe(1200);
  });

  it('reads a pasted amount with the sign after the dollar sign', () => {
    expect(parseCents('$-3')).toBe(-300);
    expect(parseCents('$ −1,234.5')).toBe(-123450);
    expect(parseCents('$--3')).toBeNull();
  });

  it('rejects anything that is not an amount', () => {
    for (const s of ['', ' ', 'abc', '12a', '1,00', '1.2.3', '$', '.', '--5', '1e3', 'NaN', '12,34.00'])
      expect(parseCents(s)).toBeNull();
  });
});

describe('centsToInput', () => {
  it('gives a plain number for input boxes', () => {
    expect(centsToInput(21240)).toBe('212.40');
    expect(centsToInput(300000)).toBe('3000.00');
    expect(centsToInput(-500)).toBe('−5.00');
  });
});

describe('percentOf', () => {
  it('clamps to 0..100', () => {
    expect(percentOf(21240, 60000)).toBe(35);
    expect(percentOf(-5, 100)).toBe(0);
    expect(percentOf(500, 100)).toBe(100);
    expect(percentOf(1, 0)).toBe(0);
  });
});
