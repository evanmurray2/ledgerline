// Money rules 1–13 as property-based tests (Sync spec, Money rules), plus rule 10 over random ledgers and
// incremental-from-snapshot = full recompute.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  computeBudget,
  type Assignment,
  type BudgetCategory,
  type ComputeResult,
} from '../src/budget/compute.js';
import { checkIdentity } from '../src/budget/identity.js';
import { project, type LedgerAccount, type LogicalTxn, type TxnUse } from '../src/budget/project.js';
import { projectedFronts } from '../src/budget/fronts.js';
import { cents, type Cents } from '../src/money.js';
import { addMonths, monthRange, type Month } from '../src/month.js';

import { START, RUNS, amt, cats, run, cell, card, tx, cat, CHK, CARD } from './ledger-helpers.js';

// ---------------------------------------------------------------- random ledgers

interface Gen {
  accounts: LedgerAccount[];
  categories: BudgetCategory[];
  assignments: Assignment[];
  txns: LogicalTxn[];
  current: Month;
}

const ledgerArb: fc.Arbitrary<Gen> = fc
  .record({
    nCats: fc.integer({ min: 1, max: 4 }),
    nCards: fc.integer({ min: 0, max: 2 }),
    nMonths: fc.integer({ min: 1, max: 5 }),
    startCash: amt(0, 500_000),
    startDebt: fc.array(amt(0, 200_000), { minLength: 2, maxLength: 2 }),
    raw: fc.array(
      fc.record({
        kind: fc.constantFrom(
          'cash_out',
          'card_out',
          'card_refund_linked',
          'card_refund_unlinked',
          'cash_in_cat',
          'income',
          'rewards',
          'payment',
          'owed_cash',
          'owed_card',
          'owed_closed',
          'owed_canceled',
          'uncategorized',
          'waiting',
          'unsorted',
          'split',
          'offbudget',
          'pending',
          'wontclear',
          'upcoming',
          'override_month',
        ),
        month: fc.integer({ min: 0, max: 4 }),
        day: fc.integer({ min: 1, max: 28 }),
        a: amt(1, 60_000),
        b: amt(1, 60_000),
        cat: fc.integer({ min: 0, max: 3 }),
        card: fc.integer({ min: 0, max: 1 }),
      }),
      { maxLength: 40 },
    ),
    asg: fc.array(
      fc.record({
        month: fc.integer({ min: 0, max: 5 }),
        cat: fc.integer({ min: 0, max: 5 }),
        a: amt(-30_000, 120_000),
      }),
      {
        maxLength: 20,
      },
    ),
  })
  .map((g) => {
    const cardIds = ['card0', 'card1'].slice(0, g.nCards);
    const accounts: LedgerAccount[] = [
      { id: 'chk', kind: 'checking', budgetFrom: '2026-01-01', startingBalance: g.startCash },
      { id: 'sav', kind: 'savings', budgetFrom: '2026-01-15', startingBalance: cents(10_000) },
      ...cardIds.map((id, i) => ({
        id,
        kind: 'credit' as const,
        budgetFrom: '2026-01-01',
        startingBalance: cents(-g.startDebt[i]!),
      })),
    ];
    const categories = cats(g.nCats, cardIds);
    const current = addMonths(START, g.nMonths - 1);
    const catId = (i: number) => `c${i % g.nCats}`;
    const assignments: Assignment[] = g.asg.map((x) => ({
      categoryId:
        x.cat >= g.nCats && cardIds.length ? `pay_${cardIds[x.cat % cardIds.length]}` : catId(x.cat),
      month: addMonths(START, Math.min(x.month, g.nMonths)), // may be one month in the future
      amount: x.a,
    }));
    const txns: LogicalTxn[] = [];
    const purchases: LogicalTxn[] = [];
    let s = 0;
    for (const r of g.raw) {
      const m = addMonths(START, Math.min(r.month, g.nMonths - 1));
      const date = `${m}-${String(r.day).padStart(2, '0')}`;
      const cardId = cardIds.length ? cardIds[r.card % cardIds.length]! : null;
      const t = (
        accountId: string,
        amount: number,
        use: TxnUse,
        extra: Partial<LogicalTxn> = {},
      ): LogicalTxn => ({
        key: `k${++s}`,
        accountId,
        date,
        amount: cents(amount),
        status: 'posted',
        seq: s,
        use,
        ...extra,
      });
      switch (r.kind) {
        case 'cash_out':
          txns.push(t('chk', -r.a, cat(catId(r.cat))));
          break;
        case 'card_out':
          if (cardId) {
            const p = t(cardId, -r.a, cat(catId(r.cat)));
            txns.push(p);
            purchases.push(p);
          }
          break;
        case 'card_refund_linked': {
          const p = purchases.find((x) => x.date <= date && x.accountId === cardId);
          if (p && p.use.type === 'category')
            txns.push(t(p.accountId, Math.min(r.a, -p.amount), p.use, { refundOf: p.key }));
          break;
        }
        case 'card_refund_unlinked':
          if (cardId) txns.push(t(cardId, r.a, cat(catId(r.cat))));
          break;
        case 'cash_in_cat':
          txns.push(t('chk', r.a, cat(catId(r.cat))));
          break;
        case 'income':
          txns.push(t(r.card ? 'sav' : 'chk', r.a, { type: 'rta' }));
          break;
        case 'rewards':
          if (cardId) txns.push(t(cardId, r.a, { type: 'rta' }));
          break;
        case 'payment':
          if (cardId) {
            txns.push(t('chk', -r.a, { type: 'transfer', otherAccountId: cardId }));
            txns.push(t(cardId, r.a, { type: 'transfer', otherAccountId: 'chk' }));
          }
          break;
        case 'owed_cash':
        case 'owed_card':
        case 'owed_closed':
        case 'owed_canceled': {
          const acct = r.kind === 'owed_card' && cardId ? cardId : 'chk';
          const o = Math.min(r.b, r.a);
          const owed = {
            itemId: `i${s}`,
            amount: cents(o),
            ...(r.kind === 'owed_closed'
              ? { closed: { month: current, date: `${current}-20`, amount: cents(Math.floor(o / 2)) } }
              : {}),
            ...(r.kind === 'owed_canceled' ? { canceled: true } : {}),
          };
          txns.push(t(acct, -r.a, cat(catId(r.cat)), { owed: [owed] }));
          break;
        }
        case 'uncategorized':
          txns.push(t(cardId && r.card ? cardId : 'chk', -r.a, { type: 'uncategorized' }));
          break;
        case 'waiting':
          txns.push(t('chk', r.a, { type: 'waiting' }));
          break;
        case 'unsorted':
          txns.push(t('chk', -r.a, { type: 'unsorted' }));
          txns.push(t('sav', r.a, { type: 'unsorted' }));
          txns.push(t('sav', r.a, { type: 'unsorted' }));
          break;
        case 'split':
          txns.push(
            t(cardId && r.card ? cardId : 'chk', -(r.a + r.b), {
              type: 'split',
              lines: [
                { id: 'l0', categoryId: catId(r.cat), amount: cents(-r.a) },
                { id: 'l1', categoryId: r.b % 3 === 0 ? null : catId(r.cat + 1), amount: cents(-r.b) },
              ],
            }),
          );
          break;
        case 'offbudget':
          txns.push(t('chk', r.card ? r.a : -r.a, { type: 'offbudget' }));
          break;
        case 'pending':
          txns.push(t(cardId ?? 'chk', -r.a, cat(catId(r.cat)), { status: 'pending' }));
          break;
        case 'wontclear':
          txns.push(t(cardId ?? 'chk', -r.a, cat(catId(r.cat)), { status: 'pending', wontClear: true }));
          break;
        case 'upcoming':
          txns.push(
            t('chk', -r.a, cat(catId(r.cat)), {
              status: 'upcoming',
              date: `${current}-${String(r.day).padStart(2, '0')}`,
            }),
          );
          break;
        case 'override_month':
          // "Save for next month" income and "count in the previous month" outflows.
          txns.push(t('chk', r.a, { type: 'rta' }, { budgetMonth: addMonths(m, 1) }));
          txns.push(t('chk', -r.b, cat(catId(r.cat)), { budgetMonth: m > START ? addMonths(m, -1) : m }));
          break;
      }
    }
    return { accounts, categories, assignments, txns, current };
  });

describe('rule 10: the budget identity holds on every ledger', () => {
  it('Σ working balances = categories + RTA + Waiting to match + unsorted + uncategorized − unbudgeted card debt + later months', () => {
    fc.assert(
      fc.property(ledgerArb, (g) => {
        const today = `${g.current}-14`;
        const { r, p } = run({ ...g, today });
        const rep = checkIdentity(p, r, g.current);
        expect(rep.difference).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('with every card fully budgeted, rule 10 holds word for word', () => {
    fc.assert(
      fc.property(
        amt(0, 500_000),
        amt(0, 100_000),
        fc.array(fc.record({ x: amt(1, 50_000), c: fc.integer({ min: 0, max: 2 }), onCard: fc.boolean() }), {
          maxLength: 15,
        }),
        (cash, debt, spends) => {
          const accounts: LedgerAccount[] = [
            { ...CHK, startingBalance: cash },
            { ...CARD, startingBalance: cents(-debt) },
          ];
          const categories = cats(3, ['card']);
          // Assign the starting debt and enough to every category that nothing is ever unfunded.
          const assignments: Assignment[] = [
            { categoryId: 'pay_card', month: START, amount: debt },
            ...[0, 1, 2].map((i) => ({ categoryId: `c${i}`, month: START, amount: cents(800_000) })),
          ];
          const txns = spends.map((s, i) =>
            tx(
              s.onCard ? 'card' : 'chk',
              `2026-01-${String((i % 27) + 1).padStart(2, '0')}`,
              -s.x,
              cat(`c${s.c}`),
            ),
          );
          const { r, p } = run({ accounts, categories, assignments, txns, current: START });
          const rep = checkIdentity(p, r, START);
          expect(rep.ok).toBe(true);
          expect(rep.literal).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('incremental recompute equals a full recompute (guarantee 3)', () => {
  it('starting from any earlier month snapshot gives the same months, RTA and identity', () => {
    fc.assert(
      fc.property(ledgerArb, fc.integer({ min: 0, max: 4 }), (g, k) => {
        const p = project({
          accounts: g.accounts,
          txns: g.txns,
          startMonth: START,
          today: `${g.current}-14`,
        });
        const full = computeBudget({
          startMonth: START,
          currentMonth: g.current,
          categories: g.categories,
          assignments: g.assignments,
          lines: p.lines,
        });
        const snapMonth = addMonths(START, Math.min(k, monthRange(START, g.current).length - 1) - 1);
        if (snapMonth < START || snapMonth >= g.current) return;
        const snap = full.months.find((m) => m.month === snapMonth)!.snapshot;
        const inc = computeBudget({
          startMonth: START,
          currentMonth: g.current,
          categories: g.categories,
          assignments: g.assignments.filter((a) => a.month > snapMonth),
          lines: p.lines.filter((l) => l.month > snapMonth),
          snapshot: JSON.parse(JSON.stringify(snap)) as typeof snap,
        });
        expect(inc.rta).toBe(full.rta);
        expect(inc.rtaParts).toEqual(full.rtaParts);
        expect(inc.unbudgetedCardDebt).toEqual(full.unbudgetedCardDebt);
        for (const m of inc.months) expect(m).toEqual(full.months.find((x) => x.month === m.month));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 1: cash outflow', () => {
  it('A −= x; below zero at month end is cash overspending', () => {
    fc.assert(
      fc.property(amt(0, 100_000), amt(1, 200_000), (a, x) => {
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cents(1_000_000) }],
          categories: cats(1, []),
          assignments: [{ categoryId: 'c0', month: START, amount: a }],
          txns: [tx('chk', '2026-01-10', -x, cat('c0'))],
          current: addMonths(START, 1),
        });
        const c = cell(r, START, 'c0');
        expect(c.available).toBe(a - x);
        expect(c.cashOverspent).toBe(Math.max(0, x - a));
        expect(cell(r, addMonths(START, 1), 'c0').available).toBe(Math.max(0, a - x));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 2: card purchase', () => {
  it('funded f = clamp(A, 0, x) moves to P; the rest is credit overspending, reset at month end without touching RTA', () => {
    fc.assert(
      fc.property(amt(-50_000, 100_000), amt(1, 200_000), (a, x) => {
        const cur = addMonths(START, 1);
        const base = {
          accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
          categories: cats(1, ['card']),
          assignments: [{ categoryId: 'c0', month: START, amount: a }],
          current: cur,
        };
        const { r } = run({ ...base, txns: [tx('card', '2026-01-10', -x, cat('c0'))] });
        const f = Math.min(Math.max(a, 0), x);
        expect(card(r, START, 'card').available).toBe(f);
        const c = cell(r, START, 'c0');
        expect(c.available).toBe(a - x);
        const credit = Math.min(x - f, Math.max(0, x - a));
        expect(c.creditOverspent.card ?? 0).toBe(credit);
        // The purchase never touches RTA, before or after the month-end reset.
        const without = run({ ...base, txns: [] }).r;
        expect(r.rta).toBe(without.rta);
        expect(r.unbudgetedCardDebt.card).toBe(credit);
      }),
      { numRuns: RUNS },
    );
  });

  it('within a day, cash spends before card (date order, cash before card)', () => {
    const { r } = run({
      accounts: [{ ...CHK, startingBalance: cents(100_000) }, CARD],
      categories: cats(1, ['card']),
      assignments: [{ categoryId: 'c0', month: START, amount: cents(5_000) }],
      // The card purchase was added first, but cash on the same day is processed first.
      txns: [tx('card', '2026-01-10', -4_000, cat('c0')), tx('chk', '2026-01-10', -3_000, cat('c0'))],
      current: START,
    });
    expect(card(r, START, 'card').available).toBe(2_000);
    expect(cell(r, START, 'c0').creditOverspent.card).toBe(2_000);
  });
});

describe('rule 3: card refund', () => {
  it('linked: A += r and P −= min(r, funded part of the purchase), including a refund of an unfunded purchase', () => {
    fc.assert(
      fc.property(amt(0, 50_000), amt(1, 80_000), amt(1, 80_000), (a, x, rr) => {
        const r0 = Math.min(rr, x);
        const p = tx('card', '2026-01-05', -x, cat('c0'));
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
          categories: cats(1, ['card']),
          assignments: [{ categoryId: 'c0', month: START, amount: a }],
          txns: [p, tx('card', '2026-01-20', r0, cat('c0'), { refundOf: p.key })],
          current: START,
        });
        const left = a - x + r0;
        expect(cell(r, START, 'c0').available).toBe(left);
        // P holds the debt left on the card, except what is still credit overspending (D-11: money that brings
        // the category back up funds the purchase).
        expect(card(r, START, 'card').available).toBe(x - r0 - Math.max(-left, 0));
      }),
      { numRuns: RUNS },
    );
  });

  it('linked to a split purchase: gives back the funded part of every line, not just the first', () => {
    // $100 on the card: $60 Groceries (c0, nothing left: new debt) and $40 Household (c1, funded). The $40
    // Household item comes back as a refund linked to the purchase.
    const p = tx('card', '2026-01-05', -10_000, {
      type: 'split',
      lines: [
        { id: 's0', categoryId: 'c0', amount: cents(-6_000) },
        { id: 's1', categoryId: 'c1', amount: cents(-4_000) },
      ],
    });
    const { r, p: proj } = run({
      accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
      categories: cats(2, ['card']),
      assignments: [{ categoryId: 'c1', month: START, amount: cents(4_000) }],
      txns: [p, tx('card', '2026-01-20', 4_000, cat('c1'), { refundOf: p.key })],
      current: START,
    });
    expect(cell(r, START, 'c1').available).toBe(4_000);
    // The payment category gives back the $40 it set aside: the card owes $60, all of it the Groceries debt.
    expect(card(r, START, 'card').available).toBe(0);
    expect(checkIdentity(proj, r, START).ok).toBe(true);
  });

  it('a split whose lines no longer add up: the gap is uncategorized until you fix it (D-82)', () => {
    // A $120 check split $60 Gifts (c0) and $60 Dining out (c1), whose amount then becomes $500. The lines stay as
    // they are; the $380 they don't cover counts as uncategorized spending, so the identity (rule 10) still holds and
    // neither category nor Ready to Assign moves.
    const split = (amount: number) =>
      tx('chk', '2026-01-05', amount, {
        type: 'split',
        lines: [
          { id: 's0', categoryId: 'c0', amount: cents(-6_000) },
          { id: 's1', categoryId: 'c1', amount: cents(-6_000) },
        ],
      });
    const input = (amount: number) => ({
      accounts: [{ ...CHK, startingBalance: cents(100_000) }],
      categories: cats(2, []),
      assignments: [
        { categoryId: 'c0', month: START, amount: cents(6_000) },
        { categoryId: 'c1', month: START, amount: cents(6_000) },
      ],
      txns: [split(amount)],
      current: START,
    });
    const even = run(input(-12_000));
    const off = run(input(-50_000));
    expect(off.p.uncategorizedNet).toBe(-38_000);
    expect(cell(off.r, START, 'c0').available).toBe(0);
    expect(cell(off.r, START, 'c1').available).toBe(0);
    expect(off.r.rta).toBe(even.r.rta);
    expect(checkIdentity(off.p, off.r, START).ok).toBe(true);
  });

  it('a split refund keeps its link to the purchase', () => {
    const p = tx('card', '2026-01-05', -5_000, cat('c0'));
    const { r } = run({
      accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
      categories: cats(2, ['card']),
      assignments: [{ categoryId: 'c0', month: START, amount: cents(5_000) }],
      txns: [
        p,
        tx(
          'card',
          '2026-01-20',
          5_000,
          {
            type: 'split',
            lines: [
              { id: 'r0', categoryId: 'c0', amount: cents(3_000) },
              { id: 'r1', categoryId: 'c1', amount: cents(2_000) },
            ],
          },
          { refundOf: p.key },
        ),
      ],
      current: START,
    });
    expect(card(r, START, 'card').available).toBe(0);
    expect(cell(r, START, 'c0').available).toBe(3_000);
    expect(cell(r, START, 'c1').available).toBe(2_000);
  });

  it('unlinked: P −= min(r, max(P, 0))', () => {
    fc.assert(
      fc.property(amt(0, 50_000), amt(1, 80_000), (pAssigned, rr) => {
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
          categories: cats(1, ['card']),
          assignments: [{ categoryId: 'pay_card', month: START, amount: pAssigned }],
          txns: [tx('card', '2026-01-20', rr, cat('c0'))],
          current: START,
        });
        expect(card(r, START, 'card').available).toBe(pAssigned - Math.min(rr, pAssigned));
        expect(cell(r, START, 'c0').available).toBe(rr);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 4: payment from checking to a card', () => {
  it('P −= amount; no category changes', () => {
    fc.assert(
      fc.property(amt(0, 100_000), amt(1, 100_000), (pa, pay) => {
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cents(1_000_000) }, CARD],
          categories: cats(1, ['card']),
          assignments: [{ categoryId: 'pay_card', month: START, amount: pa }],
          txns: [
            tx('chk', '2026-01-03', -pay, { type: 'transfer', otherAccountId: 'card' }),
            tx('card', '2026-01-03', pay, { type: 'transfer', otherAccountId: 'chk' }),
          ],
          current: START,
        });
        expect(card(r, START, 'card').available).toBe(pa - pay);
        expect(cell(r, START, 'c0').activity).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 5: owed part of a card purchase', () => {
  it('charged to RTA and moved to P in full, even when RTA goes negative', () => {
    fc.assert(
      fc.property(amt(0, 10_000), amt(1, 100_000), (cash, o) => {
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cash }, CARD],
          categories: cats(1, ['card']),
          assignments: [],
          txns: [tx('card', '2026-01-05', -o, cat('c0'), { owed: [{ itemId: 'i', amount: o }] })],
          current: START,
        });
        expect(r.rta).toBe(cash - o);
        expect(card(r, START, 'card').available).toBe(o);
        expect(cell(r, START, 'c0').available).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('a front that makes RTA negative, and its later payback', () => {
    const rent = tx('chk', '2026-01-31', -300_000, cat('c0'), {
      owed: [{ itemId: 'rent', amount: cents(200_000) }],
    });
    const before = run({
      accounts: [{ ...CHK, startingBalance: cents(250_000) }],
      categories: cats(1, []),
      assignments: [{ categoryId: 'c0', month: START, amount: cents(100_000) }],
      txns: [rent],
      current: START,
    });
    expect(before.r.rta).toBe(-50_000);
    const after = run({
      accounts: [{ ...CHK, startingBalance: cents(250_000) }],
      categories: cats(1, []),
      assignments: [{ categoryId: 'c0', month: START, amount: cents(100_000) }],
      txns: [rent, tx('chk', '2026-01-31', 200_000, { type: 'rta' })], // matched payback: reaches RTA once
      current: START,
    });
    expect(after.r.rta).toBe(150_000);
    expect(cell(after.r, START, 'c0').available).toBe(0);
  });
});

describe('rule 6: month end', () => {
  it('negative cash available moves to RTA in the next month and the category starts at 0', () => {
    fc.assert(
      fc.property(amt(0, 50_000), amt(1, 100_000), (a, x) => {
        const cur = addMonths(START, 1);
        const { r } = run({
          accounts: [{ ...CHK, startingBalance: cents(500_000) }],
          categories: cats(1, []),
          assignments: [{ categoryId: 'c0', month: START, amount: a }],
          txns: [tx('chk', '2026-01-10', -x, cat('c0'))],
          current: cur,
        });
        expect(r.rta).toBe(500_000 - a - Math.max(0, x - a));
        expect(cell(r, cur, 'c0').available).toBe(Math.max(0, a - x));
      }),
      { numRuns: RUNS },
    );
  });

  it('a month rollover with no other writes moves this month’s cash overspending into RTA', () => {
    const data = {
      accounts: [{ ...CHK, startingBalance: cents(100_000) }],
      categories: cats(1, []),
      assignments: [{ categoryId: 'c0', month: START, amount: cents(10_000) }],
      txns: [tx('chk', '2026-01-10', -15_000, cat('c0'))],
    };
    const jan = run({ ...data, current: START });
    const feb = run({ ...data, current: addMonths(START, 1) });
    expect(jan.r.rta).toBe(90_000);
    expect(feb.r.rta).toBe(85_000);
    expect(cell(feb.r, addMonths(START, 1), 'c0').available).toBe(0);
  });

  it('applies to card payment categories too (decisions.md D-10)', () => {
    const { r } = run({
      accounts: [
        { ...CHK, startingBalance: cents(100_000) },
        { ...CARD, startingBalance: cents(-40_000) },
      ],
      categories: cats(1, ['card']),
      assignments: [],
      txns: [
        tx('chk', '2026-01-03', -40_000, { type: 'transfer', otherAccountId: 'card' }),
        tx('card', '2026-01-03', 40_000, { type: 'transfer', otherAccountId: 'chk' }),
      ],
      current: addMonths(START, 1),
    });
    expect(r.rta).toBe(60_000);
    expect(card(r, addMonths(START, 1), 'card').available).toBe(0);
    expect(r.unbudgetedCardDebt.card).toBe(0);
  });
});

describe('rule 7: card coverage', () => {
  it('when every purchase is funded and the starting debt assigned, P = balance + budgeted pending − uncategorized card spending', () => {
    fc.assert(
      fc.property(
        amt(0, 100_000),
        fc.array(
          fc.record({ x: amt(1, 30_000), kind: fc.constantFrom('posted', 'pending', 'uncat', 'wont') }),
          { maxLength: 12 },
        ),
        (debt, spends) => {
          const txns = spends.map((s, i) => {
            const d = `2026-01-${String(i + 2).padStart(2, '0')}`;
            if (s.kind === 'uncat') return tx('card', d, -s.x, { type: 'uncategorized' });
            return tx('card', d, -s.x, cat('c0'), {
              status: s.kind === 'posted' ? 'posted' : 'pending',
              wontClear: s.kind === 'wont',
            });
          });
          const { r, p } = run({
            accounts: [
              { ...CHK, startingBalance: cents(10_000_000) },
              { ...CARD, startingBalance: cents(-debt) },
            ],
            categories: cats(1, ['card']),
            assignments: [
              { categoryId: 'c0', month: START, amount: cents(1_000_000) },
              { categoryId: 'pay_card', month: START, amount: debt },
            ],
            txns,
            current: START,
          });
          const uncat = spends.filter((s) => s.kind === 'uncat').reduce((a, s) => a + s.x, 0);
          expect(card(r, START, 'card').available).toBe(0 - p.working.card! - uncat);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('rule 9: Waiting to match', () => {
  it('a held inflow is in neither RTA nor categories until Match or Income', () => {
    fc.assert(
      fc.property(amt(1, 200_000), (x) => {
        const base = {
          accounts: [{ ...CHK, startingBalance: cents(1_000) }],
          categories: cats(1, []),
          assignments: [],
          current: START,
        };
        const held = run({ ...base, txns: [tx('chk', '2026-01-05', x, { type: 'waiting' })] });
        expect(held.r.rta).toBe(1_000);
        expect(held.p.waitingToMatch).toBe(x);
        const income = run({ ...base, txns: [tx('chk', '2026-01-05', x, { type: 'rta' })] });
        expect(income.r.rta).toBe(1_000 + x);
      }),
      { numRuns: RUNS },
    );
  });

  it('a pending deposit counts at once; a reversal or changed amount adjusts RTA by the difference', () => {
    const base = {
      accounts: [{ ...CHK, startingBalance: cents(0) }],
      categories: cats(1, []),
      assignments: [],
      current: START,
    };
    const pending = run({
      ...base,
      txns: [tx('chk', '2026-01-05', 50_000, { type: 'rta' }, { status: 'pending' })],
    });
    expect(pending.r.rta).toBe(50_000);
    const reversed = run({ ...base, txns: [] });
    expect(reversed.r.rta).toBe(0);
    const changed = run({ ...base, txns: [tx('chk', '2026-01-06', 48_500, { type: 'rta' })] });
    expect(changed.r.rta - pending.r.rta).toBe(-1_500);
  });
});

describe('rule 11: Close and Cancel', () => {
  it('Close charges the open amount to the original category this month and adds it to RTA', () => {
    fc.assert(
      fc.property(amt(1, 100_000), amt(0, 100_000), (o, paid) => {
        const p = Math.min(paid, o);
        const cur = addMonths(START, 1);
        const mk = (closed: boolean) =>
          run({
            accounts: [{ ...CHK, startingBalance: cents(1_000_000) }],
            categories: cats(1, []),
            assignments: [],
            txns: [
              tx('chk', '2026-01-10', -o, cat('c0'), {
                owed: [
                  {
                    itemId: 'i',
                    amount: o,
                    ...(closed ? { closed: { month: cur, date: `${cur}-05`, amount: cents(o - p) } } : {}),
                  },
                ],
              }),
              tx('chk', '2026-01-20', p, { type: 'rta' }),
            ],
            current: cur,
          });
        const open = mk(false);
        const closed = mk(true);
        expect(closed.r.rta - open.r.rta).toBe(o - p);
        expect(cell(closed.r, cur, 'c0').available - cell(open.r, cur, 'c0').available).toBe(p - o);
        expect(cell(closed.r, START, 'c0').available).toBe(cell(open.r, START, 'c0').available);
      }),
      { numRuns: RUNS },
    );
  });

  it('Reopen in a later month (D-80): the closing month stays as closed; the reopening month gives it back', () => {
    fc.assert(
      fc.property(amt(1, 100_000), amt(0, 100_000), (o, paid) => {
        const p = Math.min(paid, o);
        const shut = addMonths(START, 1);
        const cur = addMonths(START, 2);
        const x = cents(o - p);
        const mk = (mark: Partial<{ closed: object; pastCloses: object[] }>) =>
          run({
            accounts: [{ ...CHK, startingBalance: cents(1_000_000) }],
            categories: cats(1, []),
            assignments: [],
            txns: [
              tx('chk', '2026-01-10', -o, cat('c0'), {
                owed: [{ itemId: 'i', amount: o, ...mark }] as never,
              }),
              tx('chk', '2026-01-20', p, { type: 'rta' }),
            ],
            current: cur,
          });
        const closed = mk({ closed: { month: shut, date: `${shut}-05`, amount: x } });
        const reopened = mk({
          pastCloses: [
            { id: 'a', month: shut, amount: x },
            { id: 'b', month: cur, amount: cents(-x) },
          ],
        });
        // The month it was closed in is exactly as if it had stayed closed.
        expect(cell(reopened.r, shut, 'c0')).toEqual(cell(closed.r, shut, 'c0'));
        expect(cell(reopened.r, START, 'c0')).toEqual(cell(closed.r, START, 'c0'));
        // The reopening month gives the category the amount back, and RTA gives it up.
        expect(cell(reopened.r, cur, 'c0').available - cell(closed.r, cur, 'c0').available).toBe(x);
        expect(reopened.r.rta - closed.r.rta + x).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it('Cancel charges the full amount in the transaction’s own month and gives RTA the owed amount back', () => {
    fc.assert(
      fc.property(amt(1, 100_000), amt(1, 100_000), (x, oo) => {
        const o = Math.min(x, oo);
        const cur = addMonths(START, 1);
        const mk = (canceled: boolean) =>
          run({
            accounts: [{ ...CHK, startingBalance: cents(1_000_000) }],
            categories: cats(1, []),
            assignments: [{ categoryId: 'c0', month: START, amount: cents(50_000) }],
            txns: [
              tx('chk', '2026-01-10', -x, cat('c0'), {
                owed: [{ itemId: 'i', amount: cents(o), ...(canceled ? { canceled: true } : {}) }],
              }),
            ],
            current: cur,
          });
        const marked = mk(false);
        const canceled = mk(true);
        expect(cell(canceled.r, START, 'c0').activity).toBe(-x);
        const ov = (r: ComputeResult) => cell(r, START, 'c0').cashOverspent;
        expect(canceled.r.rta - marked.r.rta).toBe(o - (ov(canceled.r) - ov(marked.r)));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 12: Unlink', () => {
  it('returns a matched inflow to Waiting to match; RTA drops by that amount', () => {
    fc.assert(
      fc.property(amt(1, 100_000), (x) => {
        const base = {
          accounts: [{ ...CHK, startingBalance: cents(0) }],
          categories: cats(1, []),
          assignments: [],
          current: START,
        };
        const matched = run({ ...base, txns: [tx('chk', '2026-01-05', x, { type: 'rta' })] });
        const unlinked = run({ ...base, txns: [tx('chk', '2026-01-05', x, { type: 'waiting' })] });
        expect(unlinked.r.rta).toBe(matched.r.rta - x);
        expect(unlinked.p.waitingToMatch).toBe(x);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('rule 13: projected fronts', () => {
  it('shows the shortfall before the date when RTA is less than the owed amount', () => {
    fc.assert(
      fc.property(amt(-100_000, 300_000), amt(1, 300_000), (rta, o) => {
        const out = projectedFronts(
          rta as Cents,
          [{ key: 'rent', date: '2026-11-30', owed: o as Cents }],
          '2026-11-14',
        );
        if (rta < o) expect(out).toEqual([{ key: 'rent', date: '2026-11-30', owed: o, shortfall: o - rta }]);
        else expect(out).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});

// Refunds and inflows after credit overspending (decisions.md D-11, D-12): the budget counts exactly the money
// you have.
describe('money back after credit overspending (decisions.md D-11, D-12)', () => {
  it('D-11: money a category receives after credit overspending funds the card', () => {
    const cur = addMonths(START, 1);
    const { r, p } = run({
      accounts: [{ ...CHK, startingBalance: cents(100_000) }, CARD],
      categories: cats(1, ['card']),
      assignments: [],
      txns: [tx('card', '2026-01-05', -3_000, cat('c0')), tx('chk', '2026-01-20', 4_000, cat('c0'))],
      current: cur,
    });
    expect(cell(r, cur, 'c0').available).toBe(1_000); // carries $10
    expect(card(r, cur, 'card').available).toBe(3_000); // the card is covered
    expect(p.working.card).toBe(-3_000);
    expect(r.unbudgetedCardDebt.card).toBe(0);
    expect(r.rta).toBe(100_000); // RTA is never charged for the $30
    expect(checkIdentity(p, r, cur).ok).toBe(true);
  });

  it('D-12: a refund of a purchase forgiven in an earlier month pays off that debt, not the category', () => {
    const p0 = tx('card', '2026-01-05', -3_000, cat('c0'));
    const cur = addMonths(START, 1);
    const { r, p } = run({
      accounts: [{ ...CHK, startingBalance: cents(100_000) }, CARD],
      categories: cats(1, ['card']),
      assignments: [],
      txns: [p0, tx('card', `${cur}-05`, 3_000, cat('c0'), { refundOf: p0.key })],
      current: cur,
    });
    expect(cell(r, cur, 'c0').available).toBe(0);
    expect(cell(r, cur, 'c0').activity).toBe(0);
    expect(p.working.card).toBe(0); // the debt is gone
    expect(r.unbudgetedCardDebt.card).toBe(0); // and so is the unbudgeted debt
    expect(r.rta).toBe(100_000);
    expect(checkIdentity(p, r, cur).ok).toBe(true);
  });

  it('D-12: an unlinked refund on a card with unassigned starting debt pays that debt first', () => {
    const { r, p } = run({
      accounts: [
        { ...CHK, startingBalance: cents(100_000) },
        { ...CARD, startingBalance: cents(-5_000) },
      ],
      categories: cats(1, ['card']),
      assignments: [],
      txns: [tx('card', '2026-01-10', 7_000, cat('c0'))],
      current: START,
    });
    expect(cell(r, START, 'c0').available).toBe(2_000); // only the part beyond the $50 debt
    expect(r.unbudgetedCardDebt.card).toBe(0);
    expect(p.working.card).toBe(2_000);
    expect(checkIdentity(p, r, START).ok).toBe(true);
  });

  it('D-25: spending a card credit balance sets nothing aside for the card', () => {
    const { r, p } = run({
      accounts: [{ ...CHK, startingBalance: cents(100_000) }, CARD],
      categories: cats(1, ['card']),
      assignments: [],
      txns: [tx('card', '2026-01-05', 1_000, cat('c0')), tx('card', '2026-01-10', -1_000, cat('c0'))],
      current: START,
    });
    expect(p.working.card).toBe(0);
    expect(cell(r, START, 'c0').available).toBe(0);
    expect(card(r, START, 'card').available).toBe(0); // was $10 under rule 2 as written
    expect(checkIdentity(p, r, START).ok).toBe(true);
  });

  it('on any mix of card spending, refunds, statement credits, cash inflows and payments, card debt = payment category + unbudgeted debt − credit held', () => {
    const ev = fc.record({
      kind: fc.constantFrom(
        'buy',
        'splitBuy',
        'refund',
        'linked',
        'splitLinked',
        'cashIn',
        'cashOut',
        'pay',
        'credit',
      ),
      x: amt(1, 20_000),
      c: fc.integer({ min: 0, max: 1 }),
      m: fc.integer({ min: 0, max: 1 }),
      d: fc.integer({ min: 1, max: 28 }),
    });
    fc.assert(
      fc.property(
        amt(0, 30_000),
        fc.array(ev, { maxLength: 14 }),
        fc.array(fc.record({ c: fc.integer({ min: 0, max: 2 }), x: amt(0, 10_000) }), { maxLength: 3 }),
        (debt, evs, asg) => {
          const cur = addMonths(START, 2);
          const buys: LogicalTxn[] = [];
          const sorted = [...evs].sort((a, b) => a.m - b.m || a.d - b.d);
          const txns: LogicalTxn[] = [];
          let bal = -debt;
          const onCard = (n: number) => {
            bal += n;
            return true;
          };
          for (const e of sorted) {
            const date = `${addMonths(START, e.m)}-${String(e.d).padStart(2, '0')}`;
            const c = `c${e.c}`;
            if (e.kind === 'buy') {
              bal -= e.x;
              const t = tx('card', date, -e.x, cat(c));
              buys.push(t);
              txns.push(t);
            } else if (e.kind === 'splitBuy') {
              // Split across both categories; the first part may be zero-sized away from the second.
              bal -= e.x;
              const a0 = Math.floor(e.x / 3);
              const t = tx('card', date, -e.x, {
                type: 'split',
                lines: [
                  { id: 's0', categoryId: `c${e.c}`, amount: cents(-a0) },
                  { id: 's1', categoryId: `c${1 - e.c}`, amount: cents(-(e.x - a0)) },
                ],
              });
              buys.push(t);
              txns.push(t);
            } else if (e.kind === 'splitLinked' && buys.length > 0) {
              // A refund split across both categories, linked to one purchase.
              const b = buys[e.x % buys.length]!;
              const back = txns.filter((t) => t.refundOf === b.key).reduce((s, t) => s + t.amount, 0);
              const r0 = Math.min(e.x, -b.amount - back);
              const h = Math.floor(r0 / 2);
              if (r0 > 1 && onCard(r0))
                txns.push(
                  tx(
                    'card',
                    date,
                    r0,
                    {
                      type: 'split',
                      lines: [
                        { id: 'r0', categoryId: 'c0', amount: cents(h) },
                        { id: 'r1', categoryId: 'c1', amount: cents(r0 - h) },
                      ],
                    },
                    { refundOf: b.key },
                  ),
                );
            } else if (e.kind === 'credit') {
              if (onCard(e.x)) txns.push(tx('card', date, e.x, { type: 'rta' }));
            } else if (e.kind === 'refund') {
              if (onCard(e.x)) txns.push(tx('card', date, e.x, cat(c)));
            } else if (e.kind === 'linked' && buys.length > 0) {
              const b = buys[e.x % buys.length]!;
              const back = txns.filter((t) => t.refundOf === b.key).reduce((s, t) => s + t.amount, 0);
              const r0 = Math.min(e.x, -b.amount - back);
              const bc = b.use.type === 'category' ? b.use.categoryId : c;
              // (A split purchase is refunded into one category here; splitLinked splits the refund too.)
              if (r0 > 0 && onCard(r0)) txns.push(tx('card', date, r0, cat(bc), { refundOf: b.key }));
            } else if (e.kind === 'cashIn') txns.push(tx('chk', date, e.x, cat(c)));
            else if (e.kind === 'cashOut') txns.push(tx('chk', date, -e.x, cat(c)));
            else if (e.kind === 'pay' && onCard(e.x)) {
              txns.push(tx('chk', date, -e.x, { type: 'transfer', otherAccountId: 'card' }));
              txns.push(tx('card', date, e.x, { type: 'transfer', otherAccountId: 'chk' }));
            }
          }
          const assignments: Assignment[] = asg.map((a) => ({
            categoryId: a.c === 2 ? 'pay_card' : `c${a.c}`,
            month: START,
            amount: a.x,
          }));
          const { r, p } = run({
            accounts: [
              { ...CHK, startingBalance: cents(500_000) },
              { ...CARD, startingBalance: cents(-debt) },
            ],
            categories: cats(2, ['card']),
            assignments,
            txns,
            current: cur,
          });
          expect(checkIdentity(p, r, cur).ok).toBe(true);
          const owed = -p.working.card!;
          const P = card(r, cur, 'card').available;
          const K = r.unbudgetedCardDebt.card!;
          const Cr = r.months.at(-1)!.snapshot.credit?.card ?? 0;
          // Every dollar the card owes is set aside or tracked as unbudgeted debt; a credit balance is held by
          // the category or RTA that received it (D-25).
          expect(P + K - Cr + 0).toBe(owed + 0);
          expect(bal + 0).toBe(p.working.card! + 0);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('chunked recompute (decisions.md D-22)', () => {
  it('a chain of chunks, each starting from the previous chunk’s snapshot, equals one full recompute', () => {
    fc.assert(
      fc.property(ledgerArb, fc.integer({ min: 1, max: 3 }), (g, size) => {
        const p = project({
          accounts: g.accounts,
          txns: g.txns,
          startMonth: START,
          today: `${g.current}-14`,
        });
        const base = {
          startMonth: START,
          currentMonth: g.current,
          categories: g.categories,
          assignments: g.assignments,
          lines: p.lines,
        };
        const full = computeBudget(base);
        const months: ComputeResult['months'] = [];
        let snapshot: ComputeResult['months'][number]['snapshot'] | undefined;
        let last: ComputeResult | undefined;
        for (let from = START; ;) {
          const until = addMonths(from, size - 1);
          // As the recompute does: a chunk that reaches the current month runs to the end.
          const isFinal = until >= full.through || until >= g.current;
          const r = computeBudget({
            ...base,
            ...(snapshot ? { snapshot } : {}),
            ...(isFinal ? {} : { until }),
          });
          months.push(...r.months);
          last = r;
          if (isFinal) break;
          snapshot = r.months[r.months.length - 1]!.snapshot;
          from = addMonths(until, 1);
        }
        expect(last!.rta).toBe(full.rta);
        for (const m of full.months) expect(months.find((x) => x.month === m.month)).toEqual(m);
      }),
      { numRuns: RUNS },
    );
  });
});
