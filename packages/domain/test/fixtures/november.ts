// The prototype's November 2026, rebuilt from transactions (docs/prototype). Every number the prototype shows is
// computed by the Money rules from these rows; nothing is typed in as a result. Choices made to build it are in
// decisions.md (D-13, D-15, D-16, D-17). Today is Nov 14, 2026.
import { cents, parseCents, type Cents } from '../../src/money.js';
import { month, type Month } from '../../src/month.js';
import type { Assignment, BudgetCategory } from '../../src/budget/compute.js';
import type { LedgerAccount, LogicalTxn, TxnUse, OwedMark } from '../../src/budget/project.js';
import type { OwedItem, PaybackLink } from '../../src/reimburse.js';

export const START = month('2026-10');
export const CURRENT = month('2026-11');
export const TODAY = '2026-11-14';

const $ = (s: string): Cents => parseCents(s);

export const accounts: LedgerAccount[] = [
  { id: 'checking', kind: 'checking', budgetFrom: '2026-10-01', startingBalance: $('4295.66') },
  { id: 'ally', kind: 'savings', budgetFrom: '2026-10-01', startingBalance: $('8868.80') },
  { id: 'marcus', kind: 'savings', budgetFrom: '2026-10-03', startingBalance: $('9000.00') },
  // Rule 8: card debt at budget start never touches RTA.
  { id: 'sapphire', kind: 'credit', budgetFrom: '2026-10-01', startingBalance: $('-1500.00') },
  { id: 'freedom', kind: 'credit', budgetFrom: '2026-10-01', startingBalance: $('-187.30') },
];

export const groups: Record<string, string[]> = {
  Bills: ['rent', 'electric', 'internet', 'subs'],
  Everyday: ['groceries', 'dining', 'gas', 'shopping', 'household', 'health', 'personal'],
  Savings: ['invest', 'car', 'vacation', 'gifts', 'emergency', 'home'],
};

export const categories: BudgetCategory[] = [
  ...Object.values(groups)
    .flat()
    .map((id) => ({ id, kind: id === 'invest' ? ('saving' as const) : ('spending' as const) })),
  { id: 'pay_sapphire', kind: 'cc_payment', cardAccountId: 'sapphire' },
  { id: 'pay_freedom', kind: 'cc_payment', cardAccountId: 'freedom' },
];

const OCT = month('2026-10');
const NOV = month('2026-11');
const asg = (m: Month, rows: Record<string, string>): Assignment[] =>
  Object.entries(rows).map(([categoryId, a]) => ({ categoryId, month: m, amount: $(a) }));

export const assignments: Assignment[] = [
  ...asg(OCT, {
    rent: '1000',
    electric: '95',
    internet: '79.99',
    subs: '65',
    groceries: '600',
    dining: '200',
    gas: '120',
    shopping: '200',
    household: '100',
    health: '75',
    personal: '100',
    invest: '1500',
    car: '360',
    vacation: '1250',
    gifts: '300',
    emergency: '15000',
    home: '2057.63',
    pay_sapphire: '1500',
    pay_freedom: '187.30',
  }),
  ...asg(NOV, {
    rent: '1000',
    electric: '95',
    internet: '80',
    subs: '65',
    groceries: '600',
    dining: '200',
    gas: '120',
    shopping: '200',
    household: '100',
    health: '75',
    personal: '100',
    invest: '1500',
    gifts: '170',
  }),
];

let seq = 0;
function t(
  key: string,
  accountId: string,
  date: string,
  amount: string,
  use: TxnUse | string,
  extra: Partial<LogicalTxn> = {},
): LogicalTxn {
  const u: TxnUse =
    typeof use === 'string' ? (use === 'rta' ? { type: 'rta' } : { type: 'category', categoryId: use }) : use;
  return { key, accountId, date, amount: $(amount), status: 'posted', seq: ++seq, use: u, ...extra };
}
const xfer = (otherAccountId: string): TxnUse => ({ type: 'transfer', otherAccountId });
const uncat: TxnUse = { type: 'uncategorized' };
const owe = (itemId: string, amount: string): OwedMark => ({ itemId, amount: $(amount) });

export const txns: LogicalTxn[] = [
  // ---------------- October
  t('o-vanguard', 'checking', '2026-10-01', '-1500', 'invest'),
  t('o-electric', 'checking', '2026-10-05', '-107.34', 'electric'), // $12.34 cash overspending left uncovered
  t('o-subs', 'checking', '2026-10-08', '-65', 'subs'),
  t('o-wholefoods', 'sapphire', '2026-10-09', '-327.10', 'groceries'),
  t('o-rei', 'sapphire', '2026-10-11', '-54.00', 'shopping'),
  t('o-safeway', 'checking', '2026-10-12', '-272.90', 'groceries'),
  t('o-to-marcus', 'checking', '2026-10-12', '-500', xfer('marcus')),
  t('o-from-checking-m', 'marcus', '2026-10-12', '500', xfer('checking')),
  t('o-payroll-1', 'checking', '2026-10-15', '3100', 'rta'),
  t('o-to-ally', 'checking', '2026-10-15', '-500', xfer('ally')),
  t('o-from-checking-a', 'ally', '2026-10-15', '500', xfer('checking')),
  t('o-comcast', 'checking', '2026-10-16', '-79.99', 'internet'),
  t('o-dining', 'checking', '2026-10-18', '-200', 'dining'),
  t('o-gas', 'checking', '2026-10-20', '-120', 'gas'),
  // Work trip fronted in full on Freedom: owed to you, so it comes out of RTA and moves to Freedom's payment
  // category in full (rule 5); Vacation is not charged.
  t('o-united', 'freedom', '2026-10-20', '-412.60', 'vacation', { owed: [owe('united', '412.60')] }),
  t('o-target', 'checking', '2026-10-22', '-146', 'shopping'),
  t('o-household', 'checking', '2026-10-24', '-68.45', 'household'),
  t('o-health', 'checking', '2026-10-25', '-75', 'health'),
  t('o-personal', 'checking', '2026-10-26', '-100', 'personal'),
  t('o-gifts', 'checking', '2026-10-27', '-44', 'gifts'),
  t('o-freedom-pay', 'checking', '2026-10-28', '-599.90', xfer('freedom')),
  t('o-freedom-pay-in', 'freedom', '2026-10-28', '599.90', xfer('checking')),
  t('o-payroll-2', 'checking', '2026-10-30', '3100', 'rta'),
  // Rent $3,000; the rule marks 2/3 owed by Sam, so Rent is charged $1,000 and $2,000 comes out of RTA.
  t('o-rent', 'checking', '2026-10-31', '-3000', 'rent', { owed: [owe('rent', '2000')] }),

  // ---------------- November (checking)
  t('n-vanguard', 'checking', '2026-11-01', '-1500', 'invest'),
  t('n-subs', 'checking', '2026-11-02', '-64.45', 'subs'),
  t('n-zelle', 'checking', '2026-11-03', '1000', 'rta'), // matched to Rent: pays back $1,000 of the $2,000
  t('n-sapphire-pay', 'checking', '2026-11-04', '-1288.30', xfer('sapphire')),
  t('n-gas', 'checking', '2026-11-05', '-10.90', 'gas'),
  t('n-check-1043', 'checking', '2026-11-05', '-120', 'gifts', { status: 'pending' }), // added by you, not at bank
  t('n-groceries', 'checking', '2026-11-06', '-142.20', 'groceries'),
  t('n-dining', 'checking', '2026-11-07', '-136.15', 'dining'),
  t('n-electric', 'checking', '2026-11-08', '-53.70', 'electric'),
  t('n-shopping', 'checking', '2026-11-09', '-200.80', 'shopping'),
  t('n-safeway', 'checking', '2026-11-10', '-41.18', 'groceries'),
  t('n-personal', 'checking', '2026-11-12', '-85', 'personal'),
  t('n-to-marcus', 'checking', '2026-11-12', '-500', xfer('marcus')),
  t('n-from-checking-m', 'marcus', '2026-11-12', '500', xfer('checking')),
  t('n-payroll', 'checking', '2026-11-13', '3100', 'rta'),
  t('n-venmo', 'checking', '2026-11-14', '1018', 'rta'), // money in from a person: Ready to Assign (D-98)
  t('n-comcast', 'checking', '2026-11-16', '-79.99', 'internet', { status: 'upcoming' }), // counts on its date
  t('n-rent', 'checking', '2026-11-30', '-3000', 'rent', {
    status: 'upcoming',
    owed: [owe('rent-nov', '2000')],
  }),
  // ---------------- November (savings)
  t('n-ally-interest', 'ally', '2026-11-01', '31.20', 'rta'),
  // ---------------- November (Sapphire)
  t('n-costco', 'sapphire', '2026-11-03', '-182.40', {
    type: 'split',
    lines: [
      { id: 'costco-g', categoryId: 'groceries', amount: $('-140.00') },
      { id: 'costco-h', categoryId: 'household', amount: $('-42.40') },
    ],
  }),
  t('n-rei-refund', 'sapphire', '2026-11-04', '54.00', 'shopping', { refundOf: 'o-rei' }),
  t('n-sapphire-pay-in', 'sapphire', '2026-11-04', '1288.30', xfer('checking')),
  t('n-nopa', 'sapphire', '2026-11-08', '-36.00', 'dining', { owed: [owe('nopa', '18.00')] }),
  t('n-points', 'sapphire', '2026-11-08', '24.10', 'rta'), // rewards statement credit (D-13)
  t('n-marriott', 'sapphire', '2026-11-12', '-200.00', 'vacation', { status: 'pending', wontClear: true }),
  t('n-uber', 'sapphire', '2026-11-13', '-36.00', 'dining', { status: 'pending' }), // your estimate; bank $31.40
  t('n-amazon-s', 'sapphire', '2026-11-13', '-38.10', uncat),
  t('n-tj', 'sapphire', '2026-11-14', '-64.22', 'groceries'),
  t('n-bluebottle', 'sapphire', '2026-11-14', '-6.75', uncat),
  t('n-shell', 'sapphire', '2026-11-14', '-45.00', 'gas', { status: 'pending' }),
  // ---------------- November (Freedom)
  t('n-ticketmaster', 'freedom', '2026-11-02', '-96.00', 'gifts'),
  t('n-target', 'freedom', '2026-11-06', '-49.15', 'household'),
  t('n-amazon-f', 'freedom', '2026-11-11', '-23.20', uncat),
  t('n-cvs', 'freedom', '2026-11-11', '-18.43', uncat),
  t('n-shakeshack', 'freedom', '2026-11-14', '-28.10', 'dining'), // the purchase that overspent Dining
];

export const owedItems: OwedItem[] = [
  { id: 'rent', txnKey: 'o-rent', amount: $('2000'), expectBy: '2026-11-15' },
  { id: 'nopa', txnKey: 'n-nopa', amount: $('18'), expectBy: '2026-11-10' },
  { id: 'united', txnKey: 'o-united', amount: $('412.60'), expectBy: '2026-12-04' },
];
export const paybacks: PaybackLink[] = [{ inflowKey: 'n-zelle', itemId: 'rent', amount: $('1000') }];

/** Bank-reported balances on Nov 14 (posted only; cards as amount owed). */
export const bank = {
  checking: $('4212.40'),
  ally: $('9400'),
  marcus: $('10000'),
  sapphire: $('842.17'),
  freedom: $('214.88'),
};

export const zero = cents(0);
