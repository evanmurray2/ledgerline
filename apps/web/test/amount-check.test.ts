import { describe, expect, it } from 'vitest';
import { amountWhy, dateWhy } from '../src/lib/amount-check';

describe('amount and date checks before Save', () => {
  it('says what is wrong with a typed amount', () => {
    expect(amountWhy('12.34')).toBe('');
    expect(amountWhy('')).toBe('Enter an amount');
    expect(amountWhy('abc')).toBe('Enter an amount');
    expect(amountWhy('12.345')).toBe('Enter at most 2 digits for cents');
    expect(amountWhy('0')).toBe('Enter an amount above $0.00');
    expect(amountWhy('0', { zero: true })).toBe('');
    expect(amountWhy('99999999.99')).toBe('');
    expect(amountWhy('100000000')).toBe('Enter an amount up to $99,999,999.99');
  });

  it('refuses a date more than 10 years away', () => {
    expect(dateWhy('2036-11-30', '2026-11-14')).toBe('');
    expect(dateWhy('2036-12-01', '2026-11-14')).toBe('Pick a date within 10 years of today');
    expect(dateWhy('2016-10-31', '2026-11-14')).toBe('Pick a date within 10 years of today');
  });
});
