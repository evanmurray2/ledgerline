// The small builders the Money rules tests share: categories, accounts, transactions and one project-then-compute
// run. Split from money-rules.property.test.ts.
import fc from 'fast-check';
import {
  computeBudget,
  type Assignment,
  type BudgetCategory,
  type ComputeResult,
} from '../src/budget/compute.js';
import { project, type LedgerAccount, type LogicalTxn, type TxnUse } from '../src/budget/project.js';
import { cents } from '../src/money.js';
import { month, type Month } from '../src/month.js';

export const START = month('2026-01');
export const RUNS = Number(process.env.FC_RUNS ?? 300);

// ---------------------------------------------------------------- small builders

export const amt = (lo: number, hi: number) => fc.integer({ min: lo, max: hi }).map((n) => cents(n));

export function cats(n: number, cards: string[]): BudgetCategory[] {
  return [
    ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: 'spending' as const })),
    ...cards.map((c) => ({ id: `pay_${c}`, kind: 'cc_payment' as const, cardAccountId: c })),
  ];
}

export function run(o: {
  accounts: LedgerAccount[];
  categories: BudgetCategory[];
  assignments: Assignment[];
  txns: LogicalTxn[];
  current: Month;
  today?: string;
}): { r: ComputeResult; p: ReturnType<typeof project> } {
  const p = project({
    accounts: o.accounts,
    txns: o.txns,
    startMonth: START,
    today: o.today ?? `${o.current}-28`,
  });
  const r = computeBudget({
    startMonth: START,
    currentMonth: o.current,
    categories: o.categories,
    assignments: o.assignments,
    lines: p.lines,
  });
  return { r, p };
}

export const cell = (r: ComputeResult, m: Month, c: string) =>
  r.months.find((x) => x.month === m)!.categories[c]!;
export const card = (r: ComputeResult, m: Month, c: string) => r.months.find((x) => x.month === m)!.cards[c]!;

let seq = 0;
export function tx(
  accountId: string,
  date: string,
  amount: number,
  use: TxnUse,
  extra: Partial<LogicalTxn> = {},
): LogicalTxn {
  seq++;
  return { key: `t${seq}`, accountId, date, amount: cents(amount), status: 'posted', seq, use, ...extra };
}
export const cat = (categoryId: string): TxnUse => ({ type: 'category', categoryId });

export const CHK: LedgerAccount = {
  id: 'chk',
  kind: 'checking',
  budgetFrom: '2026-01-01',
  startingBalance: cents(0),
};
export const CARD: LedgerAccount = {
  id: 'card',
  kind: 'credit',
  budgetFrom: '2026-01-01',
  startingBalance: cents(0),
};
