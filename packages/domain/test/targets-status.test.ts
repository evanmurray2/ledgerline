import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cents, parseCents as $, type Cents } from '../src/money.js';
import { addMonths, month, type IsoDate, type Month } from '../src/month.js';
import { neededThisMonth, refillPeriod, targetFor, type Target } from '../src/targets.js';
import { cardStatus, categoryStatus, isLow, suggestedFix, type StatusInput } from '../src/status.js';
import { computeBudget } from '../src/budget/compute.js';
import { project } from '../src/budget/project.js';
import * as F from './fixtures/november.js';

const ctx = (o: Partial<Parameters<typeof neededThisMonth>[1]> & { month: Month }) => ({
  assignedThisMonth: cents(0),
  availableAtMonthStart: cents(0),
  availableAtPeriodStart: cents(0),
  assignedEarlierInPeriod: cents(0),
  ...o,
});

describe('targets', () => {
  it('prototype: Car insurance $540 by Jan 15 with $360 needs $90 in November; Vacation $3,000 by Jun 2027 needs $250', () => {
    expect(
      neededThisMonth(
        { type: 'by_date', amount: $('540'), targetMonth: month('2027-01') },
        ctx({ month: month('2026-11'), availableAtMonthStart: $('360') }),
      ),
    ).toBe($('90'));
    expect(
      neededThisMonth(
        { type: 'by_date', amount: $('3000'), targetMonth: month('2027-06') },
        ctx({ month: month('2026-11'), availableAtMonthStart: $('1250') }),
      ),
    ).toBe($('250'));
  });

  it('refill: assigning exactly the need every month reaches A by the period end, remainder in the last month', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        fc.constantFrom(1, 3, 6, 12),
        fc.integer({ min: 0, max: 100_000 }),
        (A, n, S0) => {
          const t: Target = { type: 'refill', amount: cents(A), periodMonths: n, anchor: month('2026-01') };
          let assigned = 0;
          const steps: number[] = [];
          for (let i = 0; i < n; i++) {
            const m = addMonths(month('2026-01'), i);
            const need = neededThisMonth(
              t,
              ctx({ month: m, availableAtPeriodStart: cents(S0), assignedEarlierInPeriod: cents(assigned) }),
            );
            steps.push(need);
            assigned += need;
          }
          expect(S0 + assigned).toBe(Math.max(S0, A));
          // Even steps, remainder last: every step but the last is the same floor amount.
          if (A > S0 && n > 1) {
            const base = Math.floor((A - S0) / n);
            expect(steps.slice(0, -1).every((s) => s === base)).toBe(true);
            expect(steps[n - 1]).toBe(A - S0 - base * (n - 1));
          }
        },
      ),
    );
  });

  it('refill periods: quarterly $540 spread $180 a month; leftover lowers the next period', () => {
    const t: Target = { type: 'refill', amount: $('540'), periodMonths: 3, anchor: month('2026-01') };
    expect(refillPeriod(t, month('2026-02'))).toEqual({ start: '2026-01', end: '2026-03', monthsLeft: 2 });
    expect(neededThisMonth(t, ctx({ month: month('2026-01') }))).toBe($('180'));
    expect(neededThisMonth(t, ctx({ month: month('2026-04'), availableAtPeriodStart: $('90') }))).toBe(
      $('150'),
    );
  });

  it('refill periods that began before the budget (or the target) spread over the months left', () => {
    // Yearly $124 due March 2027 (period April 2026 – March 2027), budget starting November 2026: five months.
    const t: Target = { type: 'refill', amount: $('124'), periodMonths: 12, anchor: month('2026-04') };
    const from = month('2026-11');
    expect(neededThisMonth(t, ctx({ month: from, periodFrom: from }))).toBe($('24.80'));
    expect(
      neededThisMonth(
        t,
        ctx({ month: month('2027-01'), periodFrom: from, assignedEarlierInPeriod: $('49.60') }),
      ),
    ).toBe($('24.80'));
    expect(
      neededThisMonth(
        t,
        ctx({ month: month('2027-03'), periodFrom: from, assignedEarlierInPeriod: $('99.20') }),
      ),
    ).toBe($('24.80'));
    // The next period is a whole year again.
    expect(neededThisMonth(t, ctx({ month: month('2027-04'), periodFrom: from }))).toBe($('10.33'));
  });

  it('spending during the period does not raise the need', () => {
    const t: Target = { type: 'refill', amount: $('600'), periodMonths: 1, anchor: month('2026-01') };
    expect(neededThisMonth(t, ctx({ month: month('2026-11'), assignedThisMonth: $('600') }))).toBe(0);
  });

  it('set aside, balance with no date', () => {
    expect(
      neededThisMonth(
        { type: 'set_aside', amount: $('200') },
        ctx({ month: month('2026-11'), assignedThisMonth: $('50') }),
      ),
    ).toBe($('150'));
    expect(
      neededThisMonth(
        { type: 'no_date', amount: $('15000'), monthly: $('500') },
        ctx({ month: month('2026-11'), availableAtMonthStart: $('14800') }),
      ),
    ).toBe($('200'));
    expect(
      neededThisMonth(
        { type: 'no_date', amount: $('15000'), monthly: null },
        ctx({ month: month('2026-11') }),
      ),
    ).toBe(0);
  });

  it('versions: past months keep the target they were budgeted against', () => {
    const v = [
      { effectiveFrom: month('2026-01'), target: { type: 'set_aside', amount: $('100') } as Target },
      { effectiveFrom: month('2026-06'), target: { type: 'set_aside', amount: $('200') } as Target },
    ];
    expect(targetFor(v, month('2026-05'))!.amount).toBe($('100'));
    expect(targetFor(v, month('2026-07'))!.amount).toBe($('200'));
  });
});

describe('November statuses match the prototype', () => {
  const p = project({ accounts: F.accounts, txns: F.txns, startMonth: F.START, today: F.TODAY });
  const r = computeBudget({
    startMonth: F.START,
    currentMonth: F.CURRENT,
    categories: F.categories,
    assignments: F.assignments,
    lines: p.lines,
  });
  const nov = r.months.find((m) => m.month === F.CURRENT)!;
  const oct = r.months.find((m) => m.month === F.START)!;
  const targets: Record<string, Target | null> = {
    rent: { type: 'refill', amount: $('1000'), periodMonths: 1, anchor: F.START },
    electric: { type: 'refill', amount: $('95'), periodMonths: 1, anchor: F.START },
    internet: { type: 'refill', amount: $('80'), periodMonths: 1, anchor: F.START },
    subs: { type: 'refill', amount: $('65'), periodMonths: 1, anchor: F.START },
    groceries: { type: 'refill', amount: $('600'), periodMonths: 1, anchor: F.START },
    dining: { type: 'refill', amount: $('200'), periodMonths: 1, anchor: F.START },
    gas: { type: 'refill', amount: $('120'), periodMonths: 1, anchor: F.START },
    shopping: { type: 'refill', amount: $('200'), periodMonths: 1, anchor: F.START },
    household: { type: 'refill', amount: $('100'), periodMonths: 1, anchor: F.START },
    health: { type: 'refill', amount: $('75'), periodMonths: 1, anchor: F.START },
    personal: { type: 'refill', amount: $('100'), periodMonths: 1, anchor: F.START },
    invest: { type: 'set_aside', amount: $('1500') },
    car: { type: 'by_date', amount: $('540'), targetMonth: month('2027-01') },
    vacation: { type: 'by_date', amount: $('3000'), targetMonth: month('2027-06') },
    gifts: { type: 'refill', amount: $('170'), periodMonths: 1, anchor: F.START },
    emergency: { type: 'by_date', amount: $('15000'), targetMonth: month('2026-12') },
    home: null,
  };
  const bills = new Set(F.groups.Bills);
  function input(id: string): StatusInput {
    const c = nov.categories[id]!;
    const t = targets[id]!;
    const X = (oct.snapshot.carry[id] ?? 0) as Cents;
    const need = neededThisMonth(t, {
      month: F.CURRENT,
      assignedThisMonth: c.assigned,
      availableAtMonthStart: X,
      availableAtPeriodStart: X,
      assignedEarlierInPeriod: cents(0),
    });
    return {
      kind: id === 'invest' ? 'saving' : 'spending',
      isBill: bills.has(id),
      target: t,
      available: c.available,
      spent: c.spent,
      assignedThisMonth: c.assigned,
      need,
      lowThreshold: null,
      month: F.CURRENT,
      today: F.TODAY,
    };
  }
  const expected: Record<string, string> = {
    rent: 'funded',
    electric: 'funded',
    internet: 'funded',
    subs: 'funded',
    groceries: 'funded',
    dining: 'overspent',
    gas: 'funded',
    shopping: 'funded',
    household: 'funded',
    health: 'funded',
    personal: 'low',
    invest: 'invested',
    car: 'underfunded',
    vacation: 'underfunded',
    gifts: 'overfunded',
    emergency: 'funded',
    home: 'no_target',
  };
  for (const [id, st] of Object.entries(expected)) {
    it(`${id} is ${st}`, () => expect(categoryStatus(input(id))).toBe(st));
  }
  it('Needs attention fixes: Cover $18.25, Fund $90 and $250, Add $20, Move $210', () => {
    expect(suggestedFix('overspent', input('dining'))).toBe($('18.25'));
    expect(suggestedFix('underfunded', input('car'))).toBe($('90'));
    expect(suggestedFix('underfunded', input('vacation'))).toBe($('250'));
    expect(suggestedFix('low', input('personal'))).toBe($('20'));
    // Gifts spent $216 against its $170 refill, so all $210 left is extra (D-95).
    expect(suggestedFix('overfunded', input('gifts'))).toBe($('-210'));
  });
  it('a Refill category that spent more than its target is overfunded by all the money left (D-95)', () => {
    // Refill to $25: $49.97 assigned, $33.98 spent, $15.99 left.
    const base: StatusInput = {
      ...input('personal'),
      target: { type: 'refill', amount: $('25'), periodMonths: 1, anchor: F.START },
      assignedThisMonth: $('49.97'),
      spent: $('33.98'),
      available: $('15.99'),
      need: cents(0),
    };
    expect(categoryStatus(base)).toBe('overfunded');
    expect(suggestedFix('overfunded', base)).toBe($('-15.99'));
    // Nothing left: not overfunded.
    expect(categoryStatus({ ...base, available: cents(0) })).not.toBe('overfunded');
    // Spending at or below the target: only money above the target is extra.
    expect(categoryStatus({ ...base, spent: $('25'), available: $('15.99') })).not.toBe('overfunded');
    expect(suggestedFix('overfunded', { ...base, spent: $('10'), available: $('39.97') })).toBe($('-14.97'));
  });
  it('Low is for spending running through a monthly category, not a yearly fund or goal on its way up', () => {
    const base = { ...input('personal'), today: '2026-11-02' as IsoDate };
    const yearly: Target = { type: 'refill', amount: $('259'), periodMonths: 12, anchor: month('2026-06') };
    // $37 of a $259 year, nothing spent: on plan.
    expect(isLow({ ...base, target: yearly, available: $('37'), spent: cents(0), need: cents(0) })).toBe(
      false,
    );
    expect(
      isLow({
        ...base,
        target: { type: 'no_date', amount: $('3000'), monthly: null },
        available: $('187.08'),
        spent: cents(0),
        need: cents(0),
      }),
    ).toBe(false);
    // Groceries $400 a month with $340 spent two days in: Low.
    const groceries: Target = { type: 'refill', amount: $('400'), periodMonths: 1, anchor: month('2026-11') };
    expect(isLow({ ...base, target: groceries, available: $('60'), spent: $('340'), need: cents(0) })).toBe(
      true,
    );
    expect(isLow({ ...base, target: groceries, available: $('390'), spent: $('10'), need: cents(0) })).toBe(
      false,
    );
    // A Low amount you set still applies to any spending category.
    expect(
      isLow({
        ...base,
        target: yearly,
        available: $('37'),
        spent: cents(0),
        need: cents(0),
        lowThreshold: $('50'),
      }),
    ).toBe(true);
  });

  it('cards: Sapphire Covered, Freedom Short $18.25', () => {
    expect(cardStatus(nov.cards.sapphire!.available, cents(-p.working.sapphire!), $('44.85'))).toEqual({
      status: 'covered',
      short: 0,
      need: $('878.32'),
    });
    expect(cardStatus(nov.cards.freedom!.available, cents(-p.working.freedom!), $('41.63'))).toEqual({
      status: 'short',
      short: $('18.25'),
      need: $('173.25'),
    });
  });
});
