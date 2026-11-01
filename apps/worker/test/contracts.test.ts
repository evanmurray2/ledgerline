import { describe, expect, it } from 'vitest';
import { RuleBody } from '@ledgerline/contracts';

describe('contracts', () => {
  it('RuleBody parses both amount conditions', () => {
    const r = RuleBody.safeParse({
      name: 'x',
      conditions: {
        all: [
          { field: 'amount', op: 'between', min: 1, max: 2 },
          { field: 'amount', op: 'equals', value: 5 },
        ],
      },
      actions: [{ type: 'set_category', categoryId: 'c' }],
      applyToPending: true,
      stopAfter: true,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });
});
