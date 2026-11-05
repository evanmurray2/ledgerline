// Money rule 8 (starting balances) as property-based tests, with the budget start date rule (D-67). Split from
// money-rules.property.test.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cents } from '../src/money.js';
import { START, RUNS, amt, cats, run, cell, card, tx, cat, CHK, CARD } from './ledger-helpers.js';

describe('rule 8: starting balances', () => {
  it('checking and savings become RTA inflows; a card’s starting debt never touches RTA and P starts at 0', () => {
    fc.assert(
      fc.property(amt(0, 1_000_000), amt(0, 1_000_000), amt(0, 500_000), (c, s, d) => {
        const { r } = run({
          accounts: [
            { ...CHK, startingBalance: c },
            { id: 'sav', kind: 'savings', budgetFrom: '2026-01-01', startingBalance: s },
            { ...CARD, startingBalance: cents(-d) },
          ],
          categories: cats(1, ['card']),
          assignments: [],
          txns: [],
          current: START,
        });
        expect(r.rta).toBe(c + s);
        expect(card(r, START, 'card').available).toBe(0);
        expect(r.unbudgetedCardDebt.card).toBe(d);
      }),
      { numRuns: RUNS },
    );
  });

  it('transactions before an account’s budget_from are history; rows not in the balance at link join the starting balance (D-67)', () => {
    const acct = { ...CHK, budgetFrom: '2026-01-15', startingBalance: cents(100_000) };
    const { r, p } = run({
      accounts: [acct],
      categories: cats(1, []),
      assignments: [],
      txns: [
        tx('chk', '2026-01-10', -5_000, cat('c0')),
        tx('chk', '2026-01-12', -2_000, cat('c0'), { startRole: 'before' }),
      ],
      current: START,
    });
    // The 'before' row keeps no category: it lowers the starting balance, so Ready to Assign.
    expect(cell(r, START, 'c0').available).toBe(0);
    expect(r.rta).toBe(98_000);
    expect(p.working.chk).toBe(98_000);
  });

  it('a card row from before the start that came in late adds to the starting debt, never to RTA or a category', () => {
    fc.assert(
      fc.property(amt(1, 500_000), amt(1, 100_000), (d, x) => {
        const { r, p } = run({
          accounts: [{ ...CARD, budgetFrom: '2026-01-15', startingBalance: cents(-d) }],
          categories: cats(1, ['card']),
          assignments: [],
          txns: [tx('card', '2026-01-10', -x, cat('c0'), { startRole: 'before' })],
          current: START,
        });
        expect(r.rta).toBe(0);
        expect(cell(r, START, 'c0').available).toBe(0);
        expect(card(r, START, 'card').available).toBe(0);
        expect(r.unbudgetedCardDebt.card).toBe(d + x);
        expect(p.working.card).toBe(-d - x);
      }),
      { numRuns: RUNS },
    );
  });

  it('a link-day row counts in the budget and comes out of the starting balance, so it counts once', () => {
    fc.assert(
      fc.property(amt(10_000, 500_000), amt(1, 10_000), (b, x) => {
        // The balance at link already held the purchase: the balance at the start of the day was b + x.
        const { r, p } = run({
          accounts: [{ ...CHK, budgetFrom: '2026-01-15', startingBalance: cents(b) }],
          categories: cats(1, []),
          assignments: [],
          txns: [tx('chk', '2026-01-15', -x, cat('c0'), { startRole: 'linkDay' })],
          current: START,
        });
        expect(r.rta).toBe(b + x);
        expect(cell(r, START, 'c0').available).toBe(-x);
        expect(p.working.chk).toBe(b);
        const c = run({
          accounts: [{ ...CARD, budgetFrom: '2026-01-15', startingBalance: cents(-b) }],
          categories: cats(1, ['card']),
          assignments: [],
          txns: [tx('card', '2026-01-15', -x, cat('c0'), { startRole: 'linkDay' })],
          current: START,
        });
        expect(c.r.unbudgetedCardDebt.card).toBe(b - x);
        expect(card(c.r, START, 'card').available).toBe(0);
        expect(c.p.working.card).toBe(-b);
      }),
      { numRuns: RUNS },
    );
  });
});
