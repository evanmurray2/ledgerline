import { describe, expect, it } from 'vitest';
import { toRuleTarget } from '../src/lib/targets';

describe('toRuleTarget', () => {
  it('keeps each kind of target as it is, and none is no target', () => {
    expect(toRuleTarget({ type: 'refill', amount: 5000, periodMonths: 3, anchor: '2026-10' })).toEqual({
      type: 'refill',
      amount: 5000,
      periodMonths: 3,
      anchor: '2026-10',
    });
    expect(toRuleTarget({ type: 'set_aside', amount: 100 })).toEqual({ type: 'set_aside', amount: 100 });
    expect(toRuleTarget({ type: 'by_date', amount: 1200, targetMonth: '2027-01' })).toEqual({
      type: 'by_date',
      amount: 1200,
      targetMonth: '2027-01',
    });
    expect(toRuleTarget({ type: 'no_date', amount: 900, monthly: null })).toEqual({
      type: 'no_date',
      amount: 900,
      monthly: null,
    });
    expect(toRuleTarget({ type: 'no_date', amount: 900, monthly: 50 })).toMatchObject({ monthly: 50 });
    expect(toRuleTarget({ type: 'none' })).toBeNull();
  });

  it('refuses a month that is not a month', () => {
    expect(() => toRuleTarget({ type: 'by_date', amount: 1, targetMonth: '2026-13' })).toThrow(RangeError);
  });
});
