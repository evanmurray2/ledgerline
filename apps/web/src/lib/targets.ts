// A target as the API sends it (contracts: plain numbers and strings, and `none`) in the domain's own types
// (branded Cents and Month, no `none`), so the app works out a target's need with the same rule as Budget.
import type { Target } from '@ledgerline/contracts';
import { type Target as RuleTarget, cents, month } from '@ledgerline/domain';

/** The domain's target for an API target; `none` (no target) is null, as the domain has it. */
export function toRuleTarget(t: Target): RuleTarget | null {
  switch (t.type) {
    case 'refill':
      return {
        type: 'refill',
        amount: cents(t.amount),
        periodMonths: t.periodMonths,
        anchor: month(t.anchor),
      };
    case 'set_aside':
      return { type: 'set_aside', amount: cents(t.amount) };
    case 'by_date':
      return { type: 'by_date', amount: cents(t.amount), targetMonth: month(t.targetMonth) };
    case 'no_date':
      return {
        type: 'no_date',
        amount: cents(t.amount),
        monthly: t.monthly === null ? null : cents(t.monthly),
      };
    case 'none':
      return null;
  }
}
