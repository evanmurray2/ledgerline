// Permanent regression test: the prototype's November numbers (docs/prototype), reproduced exactly by the
// Money rules from transactions.
import { describe, expect, it } from 'vitest';
import { computeBudget, type ComputeResult } from '../src/budget/compute.js';
import { project, type LogicalTxn } from '../src/budget/project.js';
import { checkIdentity } from '../src/budget/identity.js';
import { parseCents as $ } from '../src/money.js';
import { owedList, owedOut } from '../src/reimburse.js';
import * as F from './fixtures/november.js';

function run(extraAssignments: { categoryId: string; amount: string }[] = [], txns: LogicalTxn[] = F.txns) {
  const p = project({ accounts: F.accounts, txns, startMonth: F.START, today: F.TODAY });
  const r = computeBudget({
    startMonth: F.START,
    currentMonth: F.CURRENT,
    categories: F.categories,
    assignments: [
      ...F.assignments,
      ...extraAssignments.map((a) => ({ categoryId: a.categoryId, month: F.CURRENT, amount: $(a.amount) })),
    ],
    lines: p.lines,
  });
  return { p, r, nov: r.months.find((m) => m.month === F.CURRENT)! };
}

const avail = (r: ReturnType<typeof run>, id: string) => r.nov.categories[id]!.available;
const groupTotal = (r: ReturnType<typeof run>, g: string) =>
  F.groups[g]!.reduce((s, id) => s + avail(r, id), 0);

/** Rule 7: fully funded when P = card balance + budgeted pending − uncategorized card spending. */
function cardNeed(p: ReturnType<typeof project>, card: string, uncategorized: string): number {
  return -p.working[card]! - $(uncategorized);
}

describe('November 2026 (prototype numbers)', () => {
  const base = run();

  it('Ready to Assign is $1,999.90 (the Venmo $1,018 is in it, D-98)', () => {
    expect(base.r.rta).toBe($('1999.90'));
  });

  it('uncategorized is $86.48', () => {
    expect(base.p.uncategorizedNet).toBe($('-86.48'));
  });

  it('cash is $23,612.40 at the bank and $23,492.40 working', () => {
    const working = base.p.working;
    expect(working.checking).toBe($('4092.40')); // after the $120 check that hasn't cleared
    expect(working.ally).toBe($('9400'));
    expect(working.marcus).toBe($('10000'));
    expect(working.checking! + working.ally! + working.marcus!).toBe($('23492.40'));
    expect(F.bank.checking + F.bank.ally + F.bank.marcus).toBe($('23612.40'));
    expect(working.checking! - $('-120')).toBe(F.bank.checking);
  });

  it('Sapphire owes $842.17 + $81.00 budgeted pending; payment category $878.32, covered', () => {
    expect(-base.p.working.sapphire!).toBe($('923.17'));
    expect(-base.p.working.sapphire! - $('81.00')).toBe(F.bank.sapphire);
    const P = base.nov.cards.sapphire!.available;
    expect(P).toBe($('878.32'));
    expect(P).toBe(cardNeed(base.p, 'sapphire', '44.85')); // Covered (Blue Bottle $6.75 + Amazon $38.10 wait)
    expect(P >= $('611.40')).toBe(true); // statement covered
  });

  it('Freedom owes $214.88; payment category $155.00, $18.25 short from Dining out', () => {
    expect(-base.p.working.freedom!).toBe(F.bank.freedom);
    const P = base.nov.cards.freedom!.available;
    expect(P).toBe($('155.00'));
    expect(cardNeed(base.p, 'freedom', '41.63') - P).toBe($('18.25'));
    expect(avail(base, 'dining')).toBe($('-18.25'));
    expect(base.nov.categories.dining!.creditOverspent).toEqual({ freedom: $('18.25') });
    expect(P >= $('145.15')).toBe(true); // statement covered even though the category is short
  });

  it('category groups: Bills $1,121.85, Everyday $441.45, Savings $18,877.63', () => {
    expect(groupTotal(base, 'Bills')).toBe($('1121.85'));
    expect(groupTotal(base, 'Everyday')).toBe($('441.45'));
    expect(groupTotal(base, 'Savings')).toBe($('18877.63'));
  });

  it('every category matches the prototype', () => {
    const expected: Record<string, string> = {
      rent: '1000',
      electric: '41.30',
      internet: '80',
      subs: '0.55',
      groceries: '212.40',
      dining: '-18.25',
      gas: '64.10',
      shopping: '53.20',
      household: '40.00',
      health: '75',
      personal: '15',
      invest: '0',
      car: '360',
      vacation: '1250',
      gifts: '210',
      emergency: '15000',
      home: '2057.63',
    };
    for (const [id, v] of Object.entries(expected)) expect([id, avail(base, id)]).toEqual([id, $(v)]);
  });

  it('Owed to you is a list, not a category: $1,430.60 out, Nopa late', () => {
    const rows = owedList(F.owedItems, F.paybacks, F.TODAY);
    expect(owedOut(rows)).toBe($('1430.60'));
    expect(rows.find((r) => r.id === 'nopa')!.status).toBe('late');
    expect(rows.find((r) => r.id === 'rent')!.stillOwed).toBe($('1000'));
    expect(F.categories.some((c) => c.id === 'owed')).toBe(false);
  });

  it('identity: $22,354.35 working = non-payment categories + RTA − uncategorized', () => {
    const rep = checkIdentity(base.p, base.r, F.CURRENT);
    expect(rep.terms.working).toBe($('22354.35'));
    expect(rep.terms.categories).toBe($('20440.93'));
    expect(rep.terms.unbudgetedCardDebt).toBe(0);
    expect(rep.terms.unsortedNet).toBe(0);
    expect(rep.terms.laterMonths).toBe(0);
    expect(rep.ok).toBe(true);
    expect(rep.literal).toBe(true);
    // Word for word: 22,354.35 = 20,440.93 + 1,999.90 − 86.48
    expect($('20440.93') + $('1999.90') - $('86.48')).toBe($('22354.35'));
  });

  it('after covering Dining $18.25, funding Car insurance $90 and Vacation $250, adding $20 to Personal care and moving $40 back from Gifts: RTA $1,661.65', () => {
    const after = run([
      { categoryId: 'dining', amount: '18.25' },
      { categoryId: 'car', amount: '90' },
      { categoryId: 'vacation', amount: '250' },
      { categoryId: 'personal', amount: '20' },
      { categoryId: 'gifts', amount: '-40' },
    ]);
    expect(after.r.rta).toBe($('1661.65'));
    expect(avail(after, 'dining')).toBe(0);
    // Covering Dining funds Shake Shack, so Freedom's payment category is covered too (D-17).
    expect(after.nov.cards.freedom!.available).toBe($('173.25'));
    expect(after.nov.cards.freedom!.available).toBe(cardNeed(after.p, 'freedom', '41.63'));
    expect(checkIdentity(after.p, after.r, F.CURRENT).literal).toBe(true);
  });

  it('October: $12.34 of Electric cash overspending was left uncovered and reduces RTA', () => {
    const oct = base.r.months.find((m) => m.month === F.START)!;
    expect(oct.categories.electric!.cashOverspent).toBe($('12.34'));
    expect(base.r.rtaParts.uncovered).toBe($('12.34'));
  });

  it("the prototype's unclear $200 transfer needs the unsorted-transfer term (D-15)", () => {
    const withTransfer = run(
      [],
      [
        ...F.txns,
        {
          key: 'x-out',
          accountId: 'checking',
          date: '2026-11-10',
          amount: $('-200'),
          status: 'posted',
          seq: 900,
          use: { type: 'unsorted' },
        },
        {
          key: 'x-m',
          accountId: 'marcus',
          date: '2026-11-11',
          amount: $('200'),
          status: 'posted',
          seq: 901,
          use: { type: 'unsorted' },
        },
        {
          key: 'x-a',
          accountId: 'ally',
          date: '2026-11-12',
          amount: $('200'),
          status: 'posted',
          seq: 902,
          use: { type: 'unsorted' },
        },
      ],
    );
    const rep = checkIdentity(withTransfer.p, withTransfer.r, F.CURRENT);
    expect(withTransfer.r.rta).toBe($('1999.90'));
    expect(rep.terms.unsortedNet).toBe($('200'));
    expect(rep.ok).toBe(true);
    // Without the unsorted term the listed identity is off by exactly $200.
    expect(rep.terms.working - (rep.terms.categories + rep.terms.rta + rep.terms.uncategorizedNet)).toBe(
      $('200'),
    );
  });
});

export type { ComputeResult };
