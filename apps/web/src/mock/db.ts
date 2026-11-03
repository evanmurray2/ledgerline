// Dev/test-only in-memory budget reproducing the prototype's November 2026. Imported only from
// src/mock/install.ts, which main.tsx loads behind `import.meta.env.VITE_MOCK === '1'`, so production builds
// never contain it. Numbers come from docs/prototype; the logic here is a plausible stand-in for the Worker,
// not the real budget engine.
import type {
  AccountRow,
  AccountsView,
  ActivityView,
  AssignView,
  AttentionItem,
  BudgetCategoryRow,
  BudgetView,
  CardRow,
  CategoriesView,
  CategorySheet,
  CategoryStatus,
  ConnectionsView,
  MatchView,
  OwedView,
  PayeesView,
  RegisterView,
  ReportsView,
  RuleBody,
  RulesView,
  Session,
  Target,
  TxnListRow,
  TxnSheet,
} from '@ledgerline/contracts';

export type Scenario = 'default' | 'firstrun' | 'empty' | 'readonly' | 'resting' | 'syncfail' | 'newmonth';

type GroupKey = 'bills' | 'everyday' | 'savings';

interface Cat {
  id: string;
  name: string;
  group: GroupKey;
  kind: 'spending' | 'saving';
  assigned: number;
  spent: number;
  available: number;
  /** Refill amount (monthly), when the target is a refill. */
  refill: number | null;
  bill: boolean;
  invest: boolean;
  noTarget: boolean;
  reached: boolean;
  /** Monthly share for a balance-by-date goal, and what's been added this month toward it. */
  need: number | null;
  added: number;
  goal: string | null;
  baseDetail: string | null;
  overNote: string | null;
  carry: string | null;
  target: Target;
  targetText: string;
  archived: boolean;
  archivedMeta?: string;
}

interface Txn {
  key: string;
  payee: string;
  rawName: string;
  accountId: string;
  date: string;
  amount: number;
  status: 'pending' | 'posted' | 'upcoming';
  wontClear: boolean;
  categoryId: string | null;
  /** Shown when there's no category (Ready to Assign, Transfer, Waiting to match…). */
  label: string | null;
  badge: string | null;
  badgeKind: TxnListRow['badgeKind'];
  sub: string | null;
  sheet: TxnListRow['sheet'];
  kind: TxnSheet['kind'];
  section: 'match' | 'xfer' | 'needs' | 'check' | 'pending' | 'upcoming' | 'posted' | 'register';
  checkAction?: 'dismiss' | 'review';
  history?: { title: string; categories: string[]; consistent: boolean } | null;
  estimate?: number | null;
  bankAmount?: number | null;
  memo?: string | null;
  categorizedBy?: string | null;
  split?: { categoryId: string; amount: number }[];
  hidden?: boolean;
  /** Card spending that waits for a category counts against this card. */
  card?: 'sapphire' | 'freedom';
  budgetMonth?: string;
}

interface Owed {
  id: string;
  txnKey: string;
  label: string;
  sub: string;
  categoryId: string;
  amount: number;
  matched: number;
  owedTotal: number;
  expectBy: string;
  status: 'open' | 'late' | 'paid_back' | 'closed' | 'canceled';
}

const ACCOUNTS: Record<
  string,
  { name: string; short: string; kind: AccountRow['kind']; inst: string; mask: string }
> = {
  chk: {
    name: 'Everyday Checking',
    short: 'Everyday Checking',
    kind: 'checking',
    inst: 'Chase',
    mask: '0912',
  },
  ally: { name: 'Ally Savings', short: 'Ally Savings', kind: 'savings', inst: 'Ally', mask: '3301' },
  marcus: { name: 'Marcus Savings', short: 'Marcus Savings', kind: 'savings', inst: 'Marcus', mask: '4471' },
  sapphire: { name: 'Sapphire Preferred', short: 'Sapphire', kind: 'credit', inst: 'Chase', mask: '4417' },
  freedom: { name: 'Freedom Unlimited', short: 'Freedom', kind: 'credit', inst: 'Chase', mask: '8820' },
};

const SYNC_TODAY = Date.UTC(2026, 10, 14, 17, 42); // Nov 14, 9:42 AM Pacific
const SYNC_ALLY = Date.UTC(2026, 10, 12, 14, 10); // Nov 12, 6:10 AM Pacific

function fmt(c: number): string {
  const neg = c < 0;
  const s = String(Math.abs(c)).padStart(3, '0');
  return (neg ? '−$' : '$') + s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + s.slice(-2);
}
function fmtWhole(c: number): string {
  return fmt(c).replace(/\.00$/, '');
}

function cat(
  id: string,
  name: string,
  group: GroupKey,
  available: number,
  assigned: number,
  spent: number,
  o: Partial<Cat> & { targetText: string; target: Target },
): Cat {
  return {
    id,
    name,
    group,
    kind: o.invest ? 'saving' : 'spending',
    assigned,
    spent,
    available,
    refill: null,
    bill: false,
    invest: false,
    noTarget: false,
    reached: false,
    need: null,
    added: 0,
    goal: null,
    baseDetail: null,
    overNote: null,
    carry: null,
    archived: false,
    ...o,
  };
}

const refillT = (amount: number): Target => ({ type: 'refill', amount, periodMonths: 1, anchor: '2026-11' });

function initialCats(): Cat[] {
  return [
    cat('rent', 'Rent', 'bills', 100000, 100000, 0, {
      bill: true,
      refill: 100000,
      baseDetail: 'your $1,000 of $3,000 · Nov 30',
      target: refillT(100000),
      targetText: 'Refill to $1,000 every month',
    }),
    cat('electric', 'Electric', 'bills', 4130, 9500, 5370, {
      bill: true,
      refill: 9500,
      target: refillT(9500),
      targetText: 'Refill to $95 every month',
    }),
    cat('internet', 'Internet', 'bills', 8000, 8000, 0, {
      bill: true,
      refill: 8000,
      baseDetail: 'Comcast $79.99 on Nov 16',
      target: refillT(8000),
      targetText: 'Refill to $80 every month',
    }),
    cat('subs', 'Subscriptions', 'bills', 55, 6500, 6445, {
      bill: true,
      refill: 6500,
      target: refillT(6500),
      targetText: 'Refill to $65 every month',
    }),
    cat('groceries', 'Groceries', 'everyday', 21240, 60000, 38760, {
      refill: 60000,
      target: refillT(60000),
      targetText: 'Refill to $600 every month',
    }),
    cat('dining', 'Dining out', 'everyday', -1825, 20000, 21825, {
      refill: 20000,
      overNote: 'Shake Shack on Freedom overspent it',
      target: refillT(20000),
      targetText: 'Refill to $200 every month',
    }),
    cat('gas', 'Gas', 'everyday', 6410, 12000, 5590, {
      refill: 12000,
      target: refillT(12000),
      targetText: 'Refill to $120 every month',
    }),
    cat('shopping', 'Shopping', 'everyday', 5320, 20000, 14680, {
      refill: 20000,
      target: refillT(20000),
      targetText: 'Refill to $200 every month',
    }),
    cat('household', 'Household', 'everyday', 4000, 10000, 9155, {
      refill: 10000,
      carry: '$31.55 carried from October',
      target: refillT(10000),
      targetText: 'Refill to $100 every month',
    }),
    cat('health', 'Health', 'everyday', 7500, 7500, 0, {
      refill: 7500,
      target: refillT(7500),
      targetText: 'Refill to $75 every month',
    }),
    cat('personal', 'Personal care', 'everyday', 1500, 10000, 8500, {
      refill: 10000,
      target: refillT(10000),
      targetText: 'Refill to $100 every month',
    }),
    cat('invest', 'Investments', 'savings', 0, 150000, 150000, {
      invest: true,
      kind: 'saving',
      baseDetail: '$1,500 to Vanguard on Nov 1',
      target: { type: 'set_aside', amount: 150000 },
      targetText: 'Invest $1,500 every month',
    }),
    cat('car', 'Car insurance', 'savings', 36000, 0, 0, {
      need: 9000,
      goal: '$540 by Jan 15',
      target: { type: 'refill', amount: 54000, periodMonths: 6, anchor: '2027-01' },
      targetText: '$540 by Jan 15, every 6 months',
    }),
    cat('vacation', 'Vacation', 'savings', 125000, 0, 0, {
      need: 25000,
      goal: '$3,000 by Jun 2027',
      target: { type: 'by_date', amount: 300000, targetMonth: '2027-06' },
      targetText: '$3,000 by Jun 2027 (funded by the start of June)',
    }),
    cat('gifts', 'Gifts', 'savings', 21000, 17000, 21600, {
      refill: 17000,
      target: refillT(17000),
      targetText: 'Refill to $170 every month',
    }),
    cat('emergency', 'Emergency fund', 'savings', 1500000, 0, 0, {
      reached: true,
      baseDetail: 'goal $15,000 reached',
      target: { type: 'no_date', amount: 1500000, monthly: null },
      targetText: '$15,000 by Dec 2026',
    }),
    cat('home', 'Home repairs', 'savings', 205763, 0, 0, {
      noTarget: true,
      baseDetail: 'kept for repairs',
      target: { type: 'none' },
      targetText: 'No target',
    }),
    cat('pet', 'Pet', 'everyday', 0, 0, 0, {
      archived: true,
      archivedMeta: 'Archived Oct 2026',
      noTarget: true,
      target: { type: 'none' },
      targetText: 'No target',
    }),
    cat('gym', 'Gym', 'savings', 0, 0, 0, {
      archived: true,
      archivedMeta: 'Archived Nov 2026',
      noTarget: true,
      target: { type: 'none' },
      targetText: 'No target',
    }),
  ];
}

function t(
  key: string,
  payee: string,
  accountId: string,
  date: string,
  amount: number,
  section: Txn['section'],
  o: Partial<Txn> = {},
): Txn {
  return {
    key,
    payee,
    rawName: payee.toUpperCase(),
    accountId,
    date,
    amount,
    status: 'posted',
    wontClear: false,
    categoryId: null,
    label: null,
    badge: null,
    badgeKind: null,
    sub: null,
    sheet: 'txn',
    kind: amount > 0 ? 'income' : 'posted',
    section,
    ...o,
  };
}

function initialTxns(): Txn[] {
  return [
    t('venmo', 'Venmo cashout', 'chk', '2026-11-14', 101800, 'match', {
      label: 'not in Ready to Assign',
      badge: 'Waiting to match · Rent and Nopa?',
      badgeKind: 'match',
      sub: 'held',
      sheet: 'match',
      rawName: 'VENMO CASHOUT',
      kind: 'income',
    }),
    t('xfer', 'Transfer out of Everyday Checking', 'chk', '2026-11-10', -20000, 'xfer', {
      label: '2 accounts got $200',
      badge: 'Pick the other side',
      badgeKind: 'alert',
      sub: 'which one?',
      sheet: 'transfer',
      rawName: 'ONLINE TRANSFER',
      kind: 'transfer',
    }),
    t('shake', 'Shake Shack', 'freedom', '2026-11-14', -2810, 'check', {
      categoryId: 'dining',
      badge: 'Cleared $4.10 higher',
      badgeKind: 'alert',
      sub: 'you estimated $24.00',
      checkAction: 'dismiss',
      rawName: 'SHAKE SHACK #1182',
      estimate: 2400,
      bankAmount: 2810,
    }),
    t('check', 'Check #1043', 'chk', '2026-11-05', -12000, 'check', {
      status: 'pending',
      categoryId: 'gifts',
      badge: 'Not at the bank after 9 days',
      badgeKind: 'alert',
      sub: 'not at bank',
      checkAction: 'review',
      sheet: 'checkPending',
      rawName: 'Added by you',
      kind: 'manual',
    }),
    t('a1', 'Amazon', 'sapphire', '2026-11-13', -3810, 'needs', {
      card: 'sapphire',
      rawName: 'AMZN MKTP US*2K4',
      history: { title: 'You’ve used for Amazon', categories: ['shopping', 'household'], consistent: false },
    }),
    t('a2', 'Amazon', 'freedom', '2026-11-11', -2320, 'needs', {
      card: 'freedom',
      rawName: 'AMAZON.COM*9X1',
      history: { title: 'You’ve used for Amazon', categories: ['shopping', 'household'], consistent: false },
    }),
    t('cvs', 'CVS Pharmacy', 'freedom', '2026-11-11', -1843, 'needs', {
      card: 'freedom',
      rawName: 'CVS/PHARMACY #0812',
      history: null,
    }),
    t('bb', 'Blue Bottle Coffee', 'sapphire', '2026-11-14', -675, 'needs', {
      card: 'sapphire',
      rawName: 'SQ *BLUE BOTTLE COFFEE',
      history: { title: 'Every past Blue Bottle Coffee', categories: ['dining'], consistent: true },
    }),
    t('uber', 'Uber Eats', 'sapphire', '2026-11-13', -3600, 'pending', {
      status: 'pending',
      categoryId: 'dining',
      badge: 'Your estimate',
      badgeKind: 'est',
      sub: 'bank $31.40',
      kind: 'pending',
      rawName: 'UBER *EATS PENDING',
      estimate: 3600,
      bankAmount: 3140,
    }),
    t('shell', 'Shell', 'sapphire', '2026-11-14', -4500, 'pending', {
      status: 'pending',
      categoryId: 'gas',
      badge: 'Card hold',
      badgeKind: 'hold',
      sub: 'card hold',
      kind: 'pending',
      rawName: 'SHELL OIL 57442',
      bankAmount: 4500,
    }),
    t('marriott', 'Marriott Downtown', 'sapphire', '2026-11-12', -20000, 'pending', {
      status: 'pending',
      wontClear: true,
      categoryId: 'vacation',
      badge: 'Won’t clear',
      badgeKind: 'hold',
      sub: 'not counted',
      kind: 'pending',
      rawName: 'MARRIOTT DOWNTOWN SF',
      bankAmount: 20000,
    }),
    t('comcast', 'Comcast', 'chk', '2026-11-16', -7999, 'upcoming', {
      status: 'upcoming',
      categoryId: 'internet',
      label: 'monthly',
      kind: 'upcoming',
    }),
    t('rent-up', 'Rent', 'chk', '2026-11-30', -300000, 'upcoming', {
      status: 'upcoming',
      categoryId: 'rent',
      label: 'monthly',
      badge: 'Owed to you · rule',
      badgeKind: 'owed',
      sub: '$2,000 fronted for Sam',
      kind: 'upcoming',
    }),
    t('tj', 'Trader Joe’s', 'sapphire', '2026-11-14', -6422, 'posted', {
      categoryId: 'groceries',
      badge: 'By rule',
      badgeKind: 'rule',
      rawName: 'TRADER JOE S #236 OAKLAND CA',
      categorizedBy: 'rule 3',
    }),
    t('payroll', 'Acme Corp payroll', 'chk', '2026-11-13', 310000, 'posted', {
      label: 'Ready to Assign',
      rawName: 'ACME CORP DIR DEP PPD',
      categorizedBy: 'rule 2',
      kind: 'income',
    }),
    t('auto', 'Everyday Checking → Marcus', 'chk', '2026-11-12', -50000, 'posted', {
      label: 'paired automatically',
      badge: 'Transfer',
      badgeKind: 'rule',
      sub: 'transfer',
      rawName: 'ONLINE TRANSFER TO MARCUS 4471',
      kind: 'transfer',
    }),
    t('nopa', 'Nopa', 'sapphire', '2026-11-08', -3600, 'posted', {
      categoryId: 'dining',
      badge: 'Owed to you · Half',
      badgeKind: 'owed',
      sub: '$18 owed to you',
      rawName: 'NOPA SAN FRANCISCO',
    }),
    t('zelle', 'Zelle from Sam', 'chk', '2026-11-03', 100000, 'posted', {
      label: 'Ready to Assign',
      badge: 'Paid back',
      badgeKind: 'match',
      sub: 'paid back Rent',
      rawName: 'ZELLE FROM SAM R',
      kind: 'paidBack',
      memo: 'Alex and Sam, October rent',
    }),
    // Register-only rows (the prototype's Activity list shows the ones above).
    t('safeway', 'Safeway', 'chk', '2026-11-10', -4118, 'register', {
      categoryId: 'groceries',
      categorizedBy: 'rule 10',
    }),
    t('payment-chk', 'Chase card payment', 'chk', '2026-11-04', -128830, 'register', {
      label: 'Sapphire payment · transfer',
      badge: 'Transfer',
      kind: 'transfer',
    }),
    t('vanguard', 'Vanguard', 'chk', '2026-11-01', -150000, 'register', {
      categoryId: 'invest',
      rawName: 'VANGUARD BUY INVESTMENT',
    }),
    t('payment-card', 'Payment, thank you', 'sapphire', '2026-11-04', 128830, 'register', {
      label: 'Transfer from Everyday Checking',
      badge: 'Transfer',
      kind: 'transfer',
    }),
    t('rei', 'REI', 'sapphire', '2026-11-04', 5400, 'register', {
      categoryId: 'shopping',
      label: 'Refund',
      kind: 'refund',
      rawName: 'REI #48 RETURN',
    }),
    t('points', 'Points back', 'sapphire', '2026-11-08', 2410, 'register', {
      label: 'Rewards · to Ready to Assign',
      kind: 'income',
    }),
    t('costco', 'Costco', 'sapphire', '2026-11-03', -18240, 'register', {
      label: 'Split · Groceries $140.00 · Household $42.40',
      split: [
        { categoryId: 'groceries', amount: -14000 },
        { categoryId: 'household', amount: -4240 },
      ],
    }),
    t('target', 'Target', 'freedom', '2026-11-06', -4915, 'register', { categoryId: 'household' }),
    t('ticketmaster', 'Ticketmaster', 'freedom', '2026-11-02', -9600, 'register', { categoryId: 'gifts' }),
    t('ally-int', 'Interest paid', 'ally', '2026-11-01', 3120, 'register', {
      label: 'Ready to Assign · income',
      kind: 'income',
    }),
    t('ally-oct', 'Transfer from Everyday Checking', 'ally', '2026-10-15', 50000, 'register', {
      label: 'Paired automatically',
      badge: 'Transfer',
      kind: 'transfer',
    }),
    t('marcus-in', 'Transfer from Everyday Checking', 'marcus', '2026-11-12', 50000, 'register', {
      label: 'Paired automatically',
      badge: 'Transfer',
      kind: 'transfer',
    }),
    t('marcus-oct', 'Transfer from Everyday Checking', 'marcus', '2026-10-12', 50000, 'register', {
      label: 'Paired automatically',
      badge: 'Transfer',
      kind: 'transfer',
    }),
    // Deposits that could be the other side of the unclear $200 transfer (D-15).
    t('marcus-200', 'Deposit', 'marcus', '2026-11-11', 20000, 'register', {
      label: 'Held until the transfer is sorted',
      rawName: 'DEPOSIT FROM CHASE',
      kind: 'income',
    }),
    t('ally-200', 'Deposit', 'ally', '2026-11-12', 20000, 'register', {
      label: 'Held until the transfer is sorted',
      rawName: 'ACH DEPOSIT',
      kind: 'income',
    }),
  ];
}

function initialOwed(): Owed[] {
  return [
    {
      id: 'rent',
      txnKey: 'rent-oct',
      label: 'Rent · Sam',
      sub: 'Oct 31 · Everyday Checking · they owe 2/3',
      categoryId: 'rent',
      amount: 100000,
      matched: 100000,
      owedTotal: 200000,
      expectBy: '2026-11-15',
      status: 'open',
    },
    {
      id: 'nopa',
      txnKey: 'nopa',
      label: 'Nopa · Alex',
      sub: 'Nov 8 · Sapphire · they owe half',
      categoryId: 'dining',
      amount: 1800,
      matched: 0,
      owedTotal: 3600,
      expectBy: '2026-11-10',
      status: 'late',
    },
    {
      id: 'united',
      txnKey: 'united',
      label: 'United Airlines · work',
      sub: 'Oct 20 · Freedom · work trip',
      categoryId: 'vacation',
      amount: 41260,
      matched: 0,
      owedTotal: 41260,
      expectBy: '2026-12-04',
      status: 'open',
    },
  ];
}

interface RuleRow {
  id: string;
  body: RuleBody & { id: string };
  summary: string;
  matches90d: number;
}

function rule(n: number, when: string, then: string, uses: number, body: Partial<RuleBody>): RuleRow {
  const id = `r${n}`;
  return {
    id,
    summary: `${when} → ${then}`,
    matches90d: uses,
    body: {
      id,
      name: when,
      conditions: { all: [] },
      actions: [{ type: 'flag_review' }],
      applyToPending: true,
      stopAfter: true,
      enabled: true,
      ...body,
    },
  };
}

function initialRules(): RuleRow[] {
  const payee = (v: string) => ({ field: 'payee' as const, op: 'is' as const, value: v });
  const setCat = (c: string) => ({ type: 'set_category' as const, categoryId: c });
  return [
    rule(
      1,
      'Payee is Rent (Zelle to Bay Prop Mgmt)',
      'Rent · $2,000 owed to you · count in previous month if day 1–5',
      3,
      {
        name: 'Rent',
        conditions: {
          all: [payee('Bay Prop Mgmt'), { field: 'amount', op: 'between', min: -310000, max: -290000 }],
        },
        actions: [
          setCat('rent'),
          { type: 'mark_owed', fixed: 200000 },
          { type: 'previous_month_if_within_days', days: 5 },
        ],
      },
    ),
    rule(2, 'Payee is Acme Corp payroll', 'Ready to Assign', 6, {
      conditions: { all: [payee('Acme Corp payroll')] },
      actions: [{ type: 'flag_review' }],
    }),
    rule(3, 'Payee is Trader Joe’s', 'Groceries', 14, {
      conditions: { all: [payee('Trader Joe’s')] },
      actions: [setCat('groceries')],
    }),
    rule(4, 'Payee is Comcast', 'Internet', 2, {
      conditions: { all: [payee('Comcast')] },
      actions: [setCat('internet')],
    }),
    rule(5, 'Payee is PG&E', 'Electric', 2, {
      conditions: { all: [payee('PG&E')] },
      actions: [setCat('electric')],
    }),
    rule(6, 'Payee is Shell or Chevron', 'Gas', 5, {
      conditions: { all: [], any: [[payee('Shell')], [payee('Chevron')]] },
      actions: [setCat('gas')],
    }),
    rule(7, 'Description contains “VANGUARD”', 'Investments', 2, {
      conditions: { all: [{ field: 'description', op: 'contains', value: 'VANGUARD' }] },
      actions: [setCat('invest')],
    }),
    rule(8, 'Payee is Uber Eats, amount under $60', 'Dining out', 4, {
      conditions: { all: [payee('Uber Eats'), { field: 'amount', op: 'between', min: -6000, max: 0 }] },
      actions: [setCat('dining')],
    }),
    rule(9, 'Payee is Netflix or Spotify', 'Subscriptions', 4, {
      conditions: { all: [], any: [[payee('Netflix')], [payee('Spotify')]] },
      actions: [setCat('subs')],
    }),
    rule(10, 'Payee is Safeway or Whole Foods', 'Groceries', 7, {
      conditions: { all: [], any: [[payee('Safeway')], [payee('Whole Foods')]] },
      actions: [setCat('groceries')],
    }),
    rule(11, 'Payee is Blue Bottle Coffee', 'Dining out', 1, {
      conditions: { all: [payee('Blue Bottle Coffee')] },
      actions: [setCat('dining')],
    }),
    rule(12, 'Account is Freedom, description has “REWARDS”', 'Rewards (to card payment)', 1, {
      conditions: {
        all: [
          { field: 'account', op: 'is', value: 'freedom' },
          { field: 'description', op: 'contains', value: 'REWARDS' },
        ],
      },
      actions: [{ type: 'flag_review' }],
    }),
  ];
}

export class MockDb {
  scenario: Scenario;
  cats: Cat[] = initialCats();
  txns: Txn[] = initialTxns();
  owed: Owed[] = initialOwed();
  rules: RuleRow[] = initialRules();
  rta = 98190;
  /** Extra money released into each card's payment category (covering overspending, categorizing). */
  cardFund = { sapphire: 0, freedom: 0 };
  writeState: Session['writeState'] = 'ok';
  setupStep: Session['budget']['setupStep'] = 'done';
  tracking = true;
  noteButton = false;
  merged = false;
  linked = 4;
  checkDeleted = false;
  allyRepaired = false;
  /** When pull to sync last brought the set-up banks up to date (null: the seeded 9:42 AM). */
  refreshedAt: number | null = null;
  syncFailed = false;
  usageEvents: unknown[] = [];
  notes: unknown[] = [];
  nextId = 100;

  constructor(scenario: Scenario = 'default') {
    this.scenario = scenario;
    if (scenario === 'readonly' || scenario === 'resting') this.writeState = 'readonly';
    if (scenario === 'firstrun') {
      this.setupStep = 'start';
      this.linked = 0;
    }
    if (scenario === 'syncfail') this.syncFailed = true;
    if (scenario === 'empty') this.makeEmpty();
    if (scenario === 'newmonth') this.makeNewMonth();
  }

  /** December 1: every category keeps what it had left, nothing assigned yet (prototype StateNewMonth). */
  private makeNewMonth() {
    for (const c of this.cats) {
      c.available = Math.max(0, c.available);
      c.assigned = 0;
      c.spent = 0;
      c.added = 0;
    }
    this.rta = 276165;
  }

  get currentMonth() {
    return this.scenario === 'newmonth' ? '2026-12' : this.scenario === 'empty' ? '2026-10' : '2026-11';
  }
  get today() {
    return this.scenario === 'newmonth'
      ? '2026-12-01'
      : this.scenario === 'empty'
        ? '2026-10-01'
        : '2026-11-14';
  }

  private makeEmpty() {
    for (const c of this.cats) {
      c.assigned = 0;
      c.spent = 0;
      c.available = 0;
      c.refill = null;
      c.need = null;
      c.reached = false;
      c.invest = false;
      c.noTarget = true;
      c.baseDetail = 'No target yet';
      c.target = { type: 'none' };
      c.targetText = 'No target';
    }
    this.cats = this.cats.filter((c) =>
      ['rent', 'electric', 'internet', 'groceries', 'dining', 'gas'].includes(c.id),
    );
    this.txns = [];
    this.owed = [];
    this.rta = 2184000;
  }

  // ------------------------------------------------------------------ budget engine (plausible, not real)

  catById(id: string): Cat | undefined {
    return this.cats.find((c) => c.id === id);
  }

  private waits(card: 'sapphire' | 'freedom') {
    return this.txns
      .filter((x) => x.card === card && x.categoryId === null && !x.hidden && x.section === 'needs')
      .reduce((a, x) => a - x.amount, 0);
  }

  cards(): CardRow[] {
    if (this.scenario === 'empty') {
      return [
        {
          accountId: 'sapphire',
          categoryId: 'pay-sapphire',
          name: 'Sapphire Preferred',
          available: 0,
          owed: 104260,
          budgetedPending: 0,
          uncategorized: 0,
          need: 104260,
          short: 104260,
          status: 'short',
          statement: { balance: 104260, due: '2026-10-25', covered: false },
          detail: 'Card balance $1,042.60 · needs funding · statement due Oct 25',
        },
        {
          accountId: 'freedom',
          categoryId: 'pay-freedom',
          name: 'Freedom Unlimited',
          available: 0,
          owed: 17080,
          budgetedPending: 0,
          uncategorized: 0,
          need: 17080,
          short: 17080,
          status: 'short',
          statement: null,
          detail: 'Card balance $170.80 · needs funding',
        },
      ];
    }
    const dining = this.catById('dining')!;
    const diningCovered = Math.min(1825, Math.max(0, dining.assigned - 20000));
    const defs = [
      {
        id: 'sapphire' as const,
        name: 'Sapphire Preferred',
        pay: 87832 + this.cardFund.sapphire,
        base: 92317,
        owed: 84217,
        pending: 8100,
        stmt: { balance: 61140, due: '2026-11-25' },
      },
      {
        id: 'freedom' as const,
        name: 'Freedom Unlimited',
        pay: 15500 + diningCovered + this.cardFund.freedom,
        base: 21488,
        owed: 21488,
        pending: 0,
        stmt: { balance: 14515, due: '2026-12-02' },
      },
    ];
    return defs.map((d) => {
      const waits = this.waits(d.id);
      const need = d.base - waits;
      const short = Math.max(0, need - d.pay);
      const statementText = `statement ${fmt(d.stmt.balance)} due ${d.stmt.due === '2026-11-25' ? 'Nov 25' : 'Dec 2'}`;
      return {
        accountId: d.id,
        categoryId: `pay-${d.id}`,
        name: d.name,
        available: d.pay,
        owed: d.owed,
        budgetedPending: d.pending,
        uncategorized: waits,
        need,
        short,
        status: short > 0 ? 'short' : 'covered',
        statement: { balance: d.stmt.balance, due: d.stmt.due, covered: d.pay >= d.stmt.balance },
        detail:
          short > 0
            ? `${fmt(short)} of card spending not covered`
            : statementText + (waits ? ` · ${fmt(waits)} waits for a category` : ''),
      } satisfies CardRow;
    });
  }

  private statusOf(c: Cat): {
    status: CategoryStatus;
    fix: BudgetCategoryRow['fix'];
    detail: string;
    need: number;
  } {
    let status: CategoryStatus = 'funded';
    let fix: BudgetCategoryRow['fix'] = null;
    let need = 0;
    if (c.available < 0) {
      status = 'overspent';
      fix = { verb: 'Cover', amount: -c.available };
      need = -c.available;
    } else if (c.invest) status = 'invested';
    else if (c.noTarget) status = 'no_target';
    else if (c.reached) status = 'funded';
    else if (c.need !== null) {
      const left = c.need - c.added;
      if (left > 0) {
        status = 'underfunded';
        fix = { verb: 'Fund', amount: left };
        need = left;
      }
    } else if (c.refill !== null && c.available + c.spent < c.refill) {
      status = 'underfunded';
      need = c.refill - c.available - c.spent;
      fix = { verb: 'Fund', amount: need };
    } else if (c.refill !== null && c.id === 'gifts' && c.available > c.refill) {
      status = 'overfunded';
      fix = { verb: 'Move', amount: -(c.available - c.refill) };
    } else if (c.refill !== null && !c.bill) {
      const fast = c.spent * 100 > 77 * (c.spent + c.available);
      if (c.available * 5 < c.refill || fast) {
        status = 'low';
        const add = Math.max(100, Math.ceil((c.refill * 35 - c.available * 100) / 10000) * 100);
        fix = { verb: 'Add', amount: add };
      }
    }
    let d = c.baseDetail ?? '';
    if (status === 'overspent') d = c.overNote ?? 'overspent';
    else if (c.need !== null && c.goal)
      d =
        status === 'underfunded'
          ? `needs ${fmt(need)} this month · ${c.goal}`
          : `this month’s share is in · ${c.goal}`;
    else if (c.id === 'gifts')
      d =
        status === 'overfunded'
          ? `${fmt(-(fix?.amount ?? 0))} more than this month’s ${fmt(c.refill!)}`
          : 'back to this month’s target';
    else if (c.id === 'rent' && status === 'underfunded') d = `needs ${fmt(need)} by Nov 30`;
    else if (c.refill !== null && !d) {
      d = `${fmt(c.available)} left of ${fmt(c.spent + c.available > 0 ? c.spent + c.available : c.refill)}`;
      if (c.carry) d += ` · ${c.carry}`;
    }
    if (status === 'funded' && c.added > 0 && c.need === null) d += ` · added ${fmt(c.added)}`;
    if (status === 'funded' && c.added > 0 && c.need !== null) d += ` · added ${fmt(c.added)}`;
    return { status, fix, detail: d, need };
  }

  catRow(c: Cat): BudgetCategoryRow {
    const s = this.statusOf(c);
    const hasBar = c.refill !== null && c.id !== 'gifts';
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      assigned: c.assigned,
      spent: c.spent,
      activity: -c.spent,
      available: c.available,
      status: s.status,
      detail: s.detail,
      leftPercent: hasBar
        ? Math.max(0, Math.min(100, Math.round((c.available * 100) / Math.max(1, c.spent + c.available))))
        : null,
      need: s.need,
      fix: s.fix,
      targetText: c.targetText,
      creditOverspent:
        c.id === 'dining' && c.available < 0
          ? [{ cardAccountId: 'freedom', cardName: 'Freedom Unlimited', amount: -c.available }]
          : [],
    };
  }

  owedOut() {
    return this.owed
      .filter((o) => o.status === 'open' || o.status === 'late')
      .reduce((a, o) => a + o.amount, 0);
  }

  attention(): AttentionItem[] {
    const out: AttentionItem[] = [];
    const sec: Partial<Record<CategoryStatus, AttentionItem['section']>> = {
      overspent: 'Overspent',
      underfunded: 'Underfunded',
      low: 'Low',
      overfunded: 'Overfunded',
    };
    if (this.rta < 0) {
      out.push({
        section: 'Ready to Assign',
        key: 'rta-negative',
        name: 'Ready to Assign',
        amount: this.rta,
        detail: 'More is assigned than you have. Take it back from a category.',
        categoryId: null,
        fix: { verb: 'Move money', amount: -this.rta },
        link: 'category',
      });
    }
    for (const c of this.cats.filter((x) => !x.archived)) {
      const row = this.catRow(c);
      const section = sec[row.status];
      if (section && row.fix)
        out.push({
          section,
          key: `cat-${c.id}`,
          name: c.name,
          amount: c.available,
          detail: row.detail,
          categoryId: c.id,
          fix: { verb: row.fix.verb, amount: row.fix.amount },
          link: 'category',
        });
    }
    const nopa = this.owed.find((o) => o.id === 'nopa' && o.status === 'late');
    if (nopa)
      out.push({
        section: 'Owed to you',
        key: 'owed-nopa',
        name: 'Nopa · Alex',
        amount: 1800,
        detail: 'Late: expected back by Nov 10',
        categoryId: null,
        fix: { verb: 'Review', amount: 1800 },
        link: 'owed',
      });
    const rentOpen = this.owed.some((o) => o.id === 'rent');
    const short = 200000 - this.rta;
    if (rentOpen && short > 0 && this.currentMonth === '2026-11') {
      const venmoWaiting = this.txns.some((x) => x.key === 'venmo' && !x.hidden);
      out.push({
        section: 'Owed to you',
        key: 'owed-rent-front',
        name: 'Rent on Nov 30',
        amount: -short,
        detail: `Fronts $2,000 for Sam. Ready to Assign has ${fmt(this.rta)}, so it would go ${fmt(this.rta - 200000)}.${venmoWaiting ? ' Matching the Venmo money adds $1,018.' : ''}`,
        categoryId: null,
        fix: { verb: 'Review', amount: short },
        link: 'owed',
      });
    }
    return out;
  }

  budget(month: string): BudgetView {
    const groups = (['bills', 'everyday', 'savings'] as const)
      .map((g) => {
        const cats = this.cats.filter((c) => c.group === g && !c.archived).map((c) => this.catRow(c));
        return {
          id: `g-${g}`,
          name: g === 'bills' ? 'Bills' : g === 'everyday' ? 'Everyday' : 'Savings',
          isBills: g === 'bills',
          total: cats.reduce((a, c) => a + c.available, 0),
          categories: cats,
        };
      })
      .filter((g) => g.categories.length > 0);
    const attention = this.attention();
    const nopaLate = this.owed.some((o) => o.status === 'late');
    return {
      month,
      currentMonth: this.currentMonth,
      minMonth: this.scenario === 'empty' ? '2026-10' : '2026-10',
      maxMonth: this.currentMonth,
      rta: this.rta,
      rtaUpdating: false,
      cards: this.cards(),
      owed: { out: this.owedOut(), late: nopaLate ? 1 : 0, status: nopaLate ? 'late' : 'tracking' },
      groups,
      archived: [],
      attention,
      underfundedTotal: attention
        .filter((a) => a.section === 'Underfunded')
        .reduce((a, x) => a + (x.fix?.amount ?? 0), 0),
      syncProblem: this.syncFailed ? 'Chase didn’t finish syncing' : null,
    };
  }

  assignView(month: string): AssignView {
    const suggestions: AssignView['suggestions'] = this.attention()
      .filter((a) => a.categoryId && a.fix)
      .map((a) => ({
        categoryId: a.categoryId!,
        name: a.name,
        reason: a.section === 'Overspent' ? ('cover' as const) : ('target' as const),
        detail: `${a.section} · ${a.detail}`,
        amount: a.fix!.amount,
      }));
    for (const card of this.cards().filter((c) => c.short > 0 && this.scenario === 'empty'))
      suggestions.unshift({
        categoryId: card.categoryId,
        name: card.name,
        reason: 'card',
        detail: card.detail,
        amount: card.short,
      });
    return { month, rta: this.rta, suggestions };
  }

  /** Adds `amount` to a category's assignment (negative takes money back to Ready to Assign). */
  addAssigned(id: string, amount: number) {
    if (id.startsWith('pay-')) {
      const card = id.slice(4) as 'sapphire' | 'freedom';
      this.cardFund[card] += amount;
      this.rta -= amount;
      return;
    }
    const c = this.catById(id);
    if (!c) throw new MockHttpError(404, 'not_found', 'No such category');
    c.assigned += amount;
    c.available += amount;
    c.added += amount;
    this.rta -= amount;
  }

  move(from: string, to: string, amount: number) {
    if (from !== 'rta') this.addAssigned(from, -amount);
    if (to !== 'rta') this.addAssigned(to, amount);
  }

  // ------------------------------------------------------------------ transactions

  private accountName(id: string) {
    return ACCOUNTS[id]?.short ?? id;
  }

  catName(id: string | null): string | null {
    if (!id) return null;
    if (id.startsWith('pay-'))
      return id === 'pay-sapphire' ? 'Sapphire Preferred payment' : 'Freedom Unlimited payment';
    return this.catById(id)?.name ?? null;
  }

  row(x: Txn): TxnListRow {
    const catLabel = x.split ? null : this.catName(x.categoryId);
    let label = catLabel ?? x.label;
    if (catLabel && x.status === 'upcoming' && x.label) label = `${catLabel} · ${x.label}`;
    return {
      key: x.key,
      payee: x.payee,
      accountId: x.accountId,
      accountName: this.accountName(x.accountId),
      date: x.date,
      amount: x.amount,
      status: x.status,
      wontClear: x.wontClear,
      categoryLabel: x.split ? x.label : label,
      badge: x.badge,
      badgeKind: x.badgeKind,
      sub: x.sub,
      sheet: x.sheet,
    };
  }

  private visible(section: Txn['section']) {
    return this.txns.filter((x) => x.section === section && !x.hidden);
  }

  activity(filter: 'all' | 'attention' | 'pending', q: string, month?: string): ActivityView {
    const ql = q.trim().toLowerCase();
    // As on the server: a month shows that budget month's posted rows (a search looks through every month), and
    // pending and upcoming rows only on this month.
    const m = month && !ql ? month : undefined;
    const inMonth = (x: Txn) => !m || (x.budgetMonth ?? x.date.slice(0, 7)) === m;
    const past = !!m && m < this.currentMonth;
    const match = (x: Txn) =>
      !ql ||
      `${x.payee} ${fmt(x.amount)} ${fmt(-x.amount)}`.toLowerCase().includes(ql) ||
      // A category's name matches too, as on the server (Reports opens Activity searching for one).
      (this.catName(x.categoryId) ?? '').toLowerCase().includes(ql);
    const byDateDesc = (a: Txn, b: Txn) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    const moneyToMatch = this.visible('match');
    const transfersToSort = this.visible('xfer');
    const needs = this.visible('needs').filter((x) => x.categoryId === null);
    const checkThese = this.visible('check');
    const attentionCount = moneyToMatch.length + transfersToSort.length + needs.length + checkThese.length;
    const pending = this.visible('pending').concat(
      filter === 'pending' ? this.visible('check').filter((x) => x.status === 'pending') : [],
    );
    const showAttn = filter !== 'pending';
    const showRest = filter !== 'attention';
    const pendingCounted =
      pending.filter((x) => !x.wontClear).reduce((a, x) => a - x.amount, 0) +
      (filter === 'pending'
        ? 0
        : this.visible('check')
            .filter((x) => x.status === 'pending')
            .reduce((a, x) => a - x.amount, 0));
    return {
      attentionCount,
      notPostedCount:
        this.visible('pending').length +
        this.visible('check').filter((x) => x.status === 'pending').length +
        this.visible('upcoming').length,
      moneyToMatch: showAttn ? moneyToMatch.filter(match).map((x) => this.row(x)) : [],
      transfersToSort: showAttn ? transfersToSort.filter(match).map((x) => this.row(x)) : [],
      needsCategory: showAttn
        ? needs.filter(match).map((x) => ({
            ...this.row(x),
            history: x.history
              ? {
                  title: x.history.title,
                  categories: x.history.categories.map((c) => this.catName(c) ?? c),
                  consistent: x.history.consistent,
                }
              : null,
          }))
        : [],
      checkThese: showAttn
        ? checkThese.filter(match).map((x) => ({ ...this.row(x), action: x.checkAction ?? 'review' }))
        : [],
      pending: showRest && !past ? pending.filter(match).map((x) => this.row(x)) : [],
      pendingTotal: pendingCounted,
      upcoming:
        showRest && !past
          ? this.visible('upcoming')
              .filter(match)
              .map((x) => this.row(x))
          : [],
      posted:
        filter === 'all'
          ? this.visible('posted')
              .filter(match)
              .filter(inMonth)
              .sort(byDateDesc)
              .map((x) => this.row(x))
          : [],
      nextCursor: null,
      categoryPicker: (['everyday', 'bills', 'savings'] as const).map((g) => ({
        group: g === 'bills' ? 'Bills' : g === 'everyday' ? 'Everyday' : 'Savings',
        categories: this.cats
          .filter((c) => c.group === g && !c.archived)
          .map((c) => ({ id: c.id, name: c.name, available: c.available })),
      })),
    };
  }

  txn(key: string): Txn {
    const x = this.txns.find((y) => y.key === key);
    if (!x) throw new MockHttpError(404, 'not_found', 'No such transaction');
    return x;
  }

  txnSheet(key: string): TxnSheet {
    const x = this.txn(key);
    const owed = this.owed
      .filter((o) => o.txnKey === key)
      .map((o) => ({
        id: o.id,
        amount: o.amount,
        matched: o.matched,
        expectBy: o.expectBy,
        status: o.status,
      }));
    return {
      key: x.key,
      kind: x.kind,
      payee: x.payee,
      rawName: x.rawName,
      accountId: x.accountId,
      accountName: ACCOUNTS[x.accountId]?.name ?? x.accountId,
      date: x.date,
      postedDate: x.status === 'posted' ? x.date : null,
      amount: x.amount,
      bankAmount: x.bankAmount ?? null,
      estimatedAmount: x.estimate ?? null,
      status: x.status,
      wontClear: x.wontClear,
      categoryId: x.categoryId,
      categoryLabel: x.categoryId ? this.catName(x.categoryId) : x.label,
      categorizedBy: x.categorizedBy ?? null,
      split: x.split
        ? x.split.map((s, i) => ({
            id: `${x.key}-${i}`,
            categoryId: s.categoryId,
            amount: s.amount,
            memo: null,
            absorbsRemainder: i === x.split!.length - 1,
          }))
        : null,
      memo: x.memo ?? null,
      budgetMonth: x.budgetMonth ?? x.date.slice(0, 7),
      budgetMonthOverridden: !!x.budgetMonth,
      owed:
        x.key === 'nopa'
          ? [{ id: 'nopa', amount: 1800, matched: 0, expectBy: '2026-11-10', status: 'late' }]
          : owed,
      paybacks:
        x.key === 'zelle'
          ? [{ inflowKey: 'zelle', itemId: 'rent', amount: 100000, label: 'Rent · Oct 31' }]
          : [],
      refundOf: x.key === 'rei' ? { key: 'rei-oct', label: 'REI · Oct 28' } : null,
      alerts: x.key === 'shake' ? ['Cleared $4.10 higher than your estimate'] : [],
    };
  }

  categorize(keys: string[], categoryId: string | null, toRta?: boolean) {
    for (const key of keys) {
      const x = this.txn(key);
      const prev = x.categoryId;
      if (prev === categoryId && !toRta) continue;
      if (prev) this.unspend(x, prev);
      if (toRta) {
        x.categoryId = null;
        x.label = 'Ready to Assign';
        this.rta += x.amount;
      } else {
        x.categoryId = categoryId;
        if (categoryId) this.spend(x, categoryId);
      }
      if (x.section === 'needs' && (categoryId || toRta)) x.section = 'posted';
      else if (x.section === 'posted' && x.card && categoryId === null && !toRta) x.section = 'needs';
    }
  }

  private spend(x: Txn, categoryId: string) {
    const c = this.catById(categoryId);
    if (!c) return;
    const out = -x.amount;
    if (x.card) this.cardFund[x.card] += Math.max(0, Math.min(c.available, out));
    c.available -= out;
    c.spent += out;
  }

  private unspend(x: Txn, categoryId: string) {
    const c = this.catById(categoryId);
    if (!c) return;
    const out = -x.amount;
    c.available += out;
    c.spent -= out;
    if (x.card) this.cardFund[x.card] -= Math.max(0, Math.min(c.available, out));
  }

  matchView(key: string): MatchView {
    const x = this.txn(key);
    const open = this.owed.filter((o) => o.status === 'open' || o.status === 'late');
    let left = x.amount;
    return {
      inflow: this.row(x),
      open: open.map((o) => {
        const suggested = o.id === 'united' ? 0 : Math.min(o.amount, Math.max(0, left));
        left -= suggested;
        return {
          id: o.id,
          label: o.id === 'rent' ? 'Rent' : o.id === 'nopa' ? 'Nopa' : 'United Airlines',
          still: o.amount,
          expectBy: o.expectBy,
          late: o.status === 'late',
          suggested,
        };
      }),
    };
  }

  // ------------------------------------------------------------------ owed, accounts, reports

  owedView(): OwedView {
    const shortfall = Math.max(0, 200000 - this.rta);
    return {
      out: this.owedOut(),
      items: this.owed.map((o) => ({
        id: o.id,
        txnKey: o.txnKey,
        label: o.label,
        sub: o.sub,
        categoryName: this.catName(o.categoryId),
        amount: o.owedTotal,
        matched: o.matched,
        still: o.status === 'open' || o.status === 'late' ? o.amount : 0,
        expectBy: o.expectBy,
        status: o.status,
      })),
      projected:
        this.owed.some((o) => o.id === 'rent' && (o.status === 'open' || o.status === 'late')) &&
        this.currentMonth === '2026-11'
          ? [{ key: 'rent-nov30', date: '2026-11-30', owed: 200000, shortfall, label: 'Rent on Nov 30' }]
          : [],
    };
  }

  /** Names you gave accounts (Rename on the register). */
  accountNames = new Map<string, string>();

  private accountRow(id: string): AccountRow {
    const a = ACCOUNTS[id]!;
    const ally = id === 'ally' && !this.allyRepaired;
    const chaseFail = this.syncFailed && a.inst === 'Chase';
    const synced = ally
      ? SYNC_ALLY
      : chaseFail
        ? Date.UTC(2026, 10, 14, 14, 10)
        : (this.refreshedAt ?? SYNC_TODAY);
    const base = {
      id,
      name: this.accountNames.get(id) ?? a.name,
      kind: a.kind,
      institution: a.inst,
      mask: a.mask,
      syncedAt: synced,
      connectionStatus: ally ? ('login_required' as const) : chaseFail ? ('error' as const) : ('ok' as const),
      drift: null,
    };
    const syncText = ally ? 'last synced Nov 12' : chaseFail ? 'last synced 6:10 AM' : 'synced 9:42 AM';
    switch (id) {
      case 'chk': {
        const pending = this.checkDeleted ? 0 : -12000;
        return {
          ...base,
          bank: 421240,
          pending,
          working: 421240 + pending,
          statement: null,
          meta: `Chase · ${syncText}`,
        };
      }
      case 'ally':
        return {
          ...base,
          bank: 940000,
          pending: 0,
          working: 940000,
          statement: null,
          meta: `Ally · ${syncText}`,
        };
      case 'marcus':
        return {
          ...base,
          bank: 1000000,
          pending: 0,
          working: 1000000,
          statement: null,
          meta: `Marcus · ${syncText}`,
        };
      case 'sapphire':
        return {
          ...base,
          bank: 84217,
          pending: 27640,
          working: 92317,
          statement: { balance: 61140, due: '2026-11-25', covered: true },
          meta: 'Statement $611.40 due Nov 25 · covered',
        };
      default:
        return {
          ...base,
          bank: 21488,
          pending: 0,
          working: 21488,
          statement: { balance: 14515, due: '2026-12-02', covered: true },
          meta: 'Statement $145.15 due Dec 2 · covered',
        };
    }
  }

  accounts(): AccountsView {
    const cash = ['chk', 'ally', 'marcus'].map((id) => this.accountRow(id));
    const cards = ['sapphire', 'freedom'].map((id) => this.accountRow(id));
    return {
      netWorth: 2255535,
      netWorthChange: 231042,
      month: this.currentMonth,
      owedOut: this.owedOut(),
      groups: [
        { name: 'Cash', total: cash.reduce((a, r) => a + r.bank, 0), accounts: cash },
        { name: 'Credit cards', total: -cards.reduce((a, r) => a + r.bank, 0), accounts: cards },
      ],
      repairs: this.allyRepaired
        ? []
        : [{ connectionId: 'c-ally', institution: 'Ally', lastSynced: SYNC_ALLY }],
      failures: this.syncFailed
        ? [
            {
              connectionId: 'c-chase',
              institution: 'Chase',
              lastGood: Date.UTC(2026, 10, 14, 14, 10),
              nextRetry: Date.UTC(2026, 10, 14, 18, 15),
            },
          ]
        : [],
      alerts: [],
    };
  }

  register(id: string, show: 'all' | 'pending' | 'needs' | 'transfers'): RegisterView {
    const account = this.accountRow(id);
    const card = account.kind === 'credit';
    const rows = this.txns.filter((x) => x.accountId === id && !x.hidden && x.status !== 'upcoming');
    const keep = (x: Txn) =>
      show === 'all' ||
      (show === 'pending' && x.status === 'pending') ||
      (show === 'needs' && x.categoryId === null && x.section === 'needs') ||
      (show === 'transfers' && (x.kind === 'transfer' || x.sheet === 'transfer'));
    const pending = rows.filter((x) => x.status === 'pending');
    const posted = rows
      .filter((x) => x.status === 'posted')
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const days: RegisterView['days'] = [];
    if (pending.some(keep))
      days.push({ label: 'Pending', balance: null, rows: pending.filter(keep).map((x) => this.regRow(x)) });
    let bal = card ? account.bank : account.bank;
    const dates = [...new Set(posted.map((x) => x.date))];
    for (const d of dates) {
      const dayRows = posted.filter((x) => x.date === d);
      const shown = dayRows.filter(keep);
      if (shown.length)
        days.push({ label: d, balance: card ? bal : bal, rows: shown.map((x) => this.regRow(x)) });
      const net = dayRows.reduce((a, x) => a + x.amount, 0);
      bal = card ? bal + net : bal - net;
    }
    const note =
      id === 'freedom' && this.cards().find((c) => c.accountId === 'freedom')!.short > 0
        ? 'Dining out is $18.25 overspent on this card, so its payment category is $18.25 short. Cover Dining out on Budget to fix both.'
        : null;
    return { account, days, note };
  }

  private regRow(x: Txn): TxnListRow {
    const r = this.row(x);
    if (x.section === 'needs' && x.categoryId === null)
      return { ...r, categoryLabel: null, badge: 'Needs category', badgeKind: 'alert' };
    return r;
  }

  reports(month: string): ReportsView {
    const oct = month === '2026-10';
    const byCategory = oct
      ? [
          ['rent', 'Rent', 100000],
          ['groceries', 'Groceries', 61230],
          ['dining', 'Dining out', 34110],
          ['shopping', 'Shopping', 20800],
          ['gas', 'Gas', 12140],
          ['personal', 'Personal care', 11500],
          ['subs', 'Subscriptions', 6445],
          ['electric', 'Electric', 5815],
        ]
      : this.cats
          .filter((c) => c.spent > 0 && !c.invest && c.id !== 'rent')
          .map((c) => [c.id, c.name, c.id === 'dining' ? c.spent : c.spent] as const)
          .sort((a, b) => b[2] - a[2]);
    return {
      month,
      monthToDate: !oct,
      tiles: oct
        ? { spent: 252040, invested: 150000, income: 620000, rewards: 3180 }
        : { spent: 131925, invested: 150000, income: 313120, rewards: 2410 },
      byCategory: byCategory.map(([id, name, spent]) => ({
        categoryId: String(id),
        name: String(name),
        spent: Number(spent),
      })),
      stillOwed: this.owedOut(),
      trend: [
        ['2026-06', 241000, 620000],
        ['2026-07', 288000, 620000],
        ['2026-08', 219000, 620000],
        ['2026-09', 264000, 620000],
        ['2026-10', 252040, 620000],
        ['2026-11', 131925, 313120],
      ].map(([m, spent, income]) => ({
        month: String(m),
        spent: Number(spent),
        income: Number(income),
        invested: 150000,
      })),
      netWorth: [
        1512000, 1580400, 1655010, 1702300, 1764120, 1820540, 1865300, 1911000, 1968800, 2012430, 2024493,
        2255535,
      ].map((value, i) => ({ month: i === 0 ? '2025-12' : `2026-${String(i).padStart(2, '0')}`, value })),
    };
  }

  categorySheet(id: string, month: string): CategorySheet {
    const c = this.catById(id);
    if (!c) throw new MockHttpError(404, 'not_found', 'No such category');
    const row = this.catRow(c);
    const statusText: Record<CategoryStatus, string> = {
      overspent: 'Overspent',
      underfunded: 'Underfunded',
      funded: 'Funded',
      overfunded: 'Overfunded',
      low: 'Low',
      invested: 'Invested',
      no_target: 'No target',
    };
    const recent = this.txns
      .filter(
        (x) =>
          (x.categoryId === id || x.split?.some((s) => s.categoryId === id)) &&
          !x.hidden &&
          x.status !== 'upcoming',
      )
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const groceries = id === 'groceries';
    const others = this.cats
      .filter((o) => o.id !== id && !o.archived)
      .map((o) => {
        const r = this.catRow(o);
        const why =
          r.status === 'overspent'
            ? `${fmt(o.available)}, overspent`
            : r.status === 'underfunded'
              ? `needs ${fmtWhole(r.need)}`
              : fmt(o.available);
        return { id: o.id, label: `${o.name} (${why})`, status: r.status };
      })
      .sort((a, b) =>
        a.status === 'overspent'
          ? -1
          : b.status === 'overspent'
            ? 1
            : a.status === 'underfunded'
              ? -1
              : b.status === 'underfunded'
                ? 1
                : 0,
      );
    return {
      id: c.id,
      name: c.name,
      month,
      status: row.status,
      statusText:
        groceries && row.status === 'funded'
          ? 'Funded · 65% spent, 47% of month gone'
          : `${statusText[row.status]} · ${row.detail}`,
      assigned: c.assigned,
      spent: c.spent,
      available: c.available,
      target: c.target,
      targetText: c.targetText,
      targetHelp:
        c.target.type === 'refill'
          ? 'Leftover rolls over and lowers next month’s need'
          : c.target.type === 'none'
            ? 'Add a target to see what it needs each month'
            : 'Reached in even monthly steps',
      lastMonthAssigned: groceries ? 64000 : c.assigned,
      rta: this.rta,
      recent: recent.slice(0, 3).map((x) => {
        const r = this.row(x);
        const s = x.split?.find((p) => p.categoryId === id);
        return s ? { ...r, amount: s.amount, categoryLabel: 'split' } : r;
      }),
      recentTotal: groceries ? 9 : recent.length,
      moveOptions: [
        ...others.map(({ id: oid, label }) => ({ id: oid, label })),
        { id: 'rta', label: 'Ready to Assign' },
      ],
    };
  }

  setTarget(id: string, target: Target) {
    const c = this.catById(id);
    if (!c) throw new MockHttpError(404, 'not_found', 'No such category');
    c.target = target;
    c.noTarget = target.type === 'none';
    if (target.type === 'refill' && target.periodMonths === 1) {
      c.refill = target.amount;
      c.targetText = `Refill to ${fmtWhole(target.amount)} every month`;
    } else if (target.type === 'refill') {
      c.targetText = `Refill to ${fmtWhole(target.amount)} every ${target.periodMonths === 12 ? 'year' : `${target.periodMonths} months`}`;
    } else if (target.type === 'set_aside') c.targetText = `Set aside ${fmtWhole(target.amount)} every month`;
    else if (target.type === 'by_date') c.targetText = `${fmtWhole(target.amount)} by ${target.targetMonth}`;
    else if (target.type === 'no_date') c.targetText = `${fmtWhole(target.amount)}, no date`;
    else {
      c.refill = null;
      c.need = null;
      c.targetText = 'No target';
      c.baseDetail = c.baseDetail ?? 'no target';
    }
  }

  // ------------------------------------------------------------------ settings

  categoriesView(): CategoriesView {
    const groupName = { bills: 'Bills', everyday: 'Everyday', savings: 'Savings' };
    const meta = (c: Cat) =>
      c.invest
        ? 'Saving or investing · invest $1,500 monthly'
        : c.target.type === 'refill' && c.target.periodMonths === 1
          ? `Refill monthly · ${fmtWhole(c.target.amount)}`
          : c.id === 'emergency'
            ? '$15,000 · reached'
            : c.id === 'car'
              ? '$540 by Jan 15, every 6 months'
              : c.id === 'vacation'
                ? '$3,000 by Jun 2027'
                : c.targetText;
    return {
      groups: [
        {
          id: 'g-cards',
          name: 'Credit card payments',
          isBills: false,
          system: true,
          categories: this.cards().map((card) => ({
            id: card.categoryId,
            name: card.name,
            kind: 'cc_payment' as const,
            meta: 'One per card',
            available: card.available,
          })),
        },
        ...(['bills', 'everyday', 'savings'] as const).map((g) => ({
          id: `g-${g}`,
          name: groupName[g],
          isBills: g === 'bills',
          system: false,
          categories: this.cats
            .filter((c) => c.group === g && !c.archived)
            .map((c) => ({ id: c.id, name: c.name, kind: c.kind, meta: meta(c), available: c.available })),
        })),
      ],
      archived: this.cats
        .filter((c) => c.archived)
        .map((c) => ({ id: c.id, name: c.name, meta: c.archivedMeta ?? 'Archived today' })),
    };
  }

  rulesView(): RulesView {
    return {
      rules: this.rules.map((r) => ({ ...r.body, id: r.id, summary: r.summary, matches90d: r.matches90d })),
    };
  }

  payeesView(): PayeesView {
    return {
      suggestions: this.merged
        ? []
        : [
            {
              name: 'Blue Bottle Coffee',
              rawNames: ['SQ *BLUE BOTTLE COFFEE', 'TST* BLUE BOTTLE', 'BLUEBOTTLECOFFEE OAKLAND'],
              transactions: 11,
              payeeIds: ['p-bb', 'p-bb2', 'p-bb3'],
            },
          ],
      payees: [
        { id: 'p-amazon', name: 'Amazon', transactions: 9, remember: false, defaultCategory: null },
        {
          id: 'p-bb',
          name: 'Blue Bottle Coffee',
          transactions: this.merged ? 11 : 5,
          remember: true,
          defaultCategory: 'Dining out',
        },
        { id: 'p-comcast', name: 'Comcast', transactions: 2, remember: true, defaultCategory: 'Internet' },
        { id: 'p-cvs', name: 'CVS Pharmacy', transactions: 3, remember: false, defaultCategory: null },
        { id: 'p-rent', name: 'Rent', transactions: 3, remember: true, defaultCategory: 'Rent' },
        { id: 'p-tj', name: 'Trader Joe’s', transactions: 14, remember: true, defaultCategory: 'Groceries' },
        { id: 'p-uber', name: 'Uber Eats', transactions: 6, remember: true, defaultCategory: 'Dining out' },
        { id: 'p-venmo', name: 'Venmo cashout', transactions: 4, remember: false, defaultCategory: null },
      ],
    };
  }

  connectionsView(): ConnectionsView {
    return {
      used: this.linked,
      limit: 10,
      environment: 'sandbox',
      items:
        this.scenario === 'firstrun'
          ? Array.from({ length: this.linked }, (_, i) => ({
              id: `c-new-${i}`,
              institution: ['Chase', 'Ally', 'Marcus'][i] ?? 'Sandbox Bank',
              accounts:
                [
                  'Everyday Checking, Sapphire Preferred, Freedom Unlimited',
                  'Ally Savings',
                  'Marcus Savings',
                ][i] ?? 'Plaid Checking',
              status: 'ok' as const,
              lastSynced: SYNC_TODAY,
              linkedAt: SYNC_TODAY,
              setupDone: true,
            }))
          : [
              {
                id: 'c-chase',
                institution: 'Chase',
                accounts: 'Everyday Checking, Sapphire Preferred, Freedom Unlimited',
                status: this.syncFailed ? 'error' : 'ok',
                lastSynced: SYNC_TODAY,
                linkedAt: Date.UTC(2026, 9, 1, 16),
                setupDone: true,
              },
              {
                id: 'c-ally',
                institution: 'Ally',
                accounts: 'Ally Savings',
                status: this.allyRepaired ? 'ok' : 'login_required',
                lastSynced: this.allyRepaired ? SYNC_TODAY : SYNC_ALLY,
                linkedAt: Date.UTC(2026, 9, 1, 16),
                setupDone: true,
              },
              {
                id: 'c-marcus',
                institution: 'Marcus',
                accounts: 'Marcus Savings',
                status: 'ok',
                lastSynced: SYNC_TODAY,
                linkedAt: Date.UTC(2026, 9, 3, 16),
                setupDone: true,
              },
              {
                id: 'c-chase-old',
                institution: 'Chase',
                accounts: 'Duplicate login from setup',
                status: 'removed',
                lastSynced: null,
                linkedAt: Date.UTC(2026, 9, 1, 15),
                setupDone: true,
              },
              ...Array.from({ length: Math.max(0, this.linked - 4) }, (_, i) => ({
                id: `c-new-${i}`,
                institution: 'Sandbox Bank',
                accounts: 'Plaid Checking',
                status: 'ok' as const,
                lastSynced: SYNC_TODAY,
                linkedAt: SYNC_TODAY,
                setupDone: true,
              })),
            ],
    };
  }

  session(): Session {
    return {
      user: { email: 'owner@example.com', login: 'evanmurray' },
      budget: {
        id: 'b1',
        name: 'Ledgerline',
        startMonth: this.setupStep === 'done' ? '2026-10' : null,
        timeZone: 'America/Los_Angeles',
        currentMonth: this.currentMonth,
        today: this.today,
        setupStep: this.setupStep,
      },
      appVersion: '0.1.0',
      writeState: this.writeState,
      readOnlyUntil: this.writeState === 'readonly' ? '2026-11-15T00:00:00.000Z' : null,
      readsPaused: this.scenario === 'resting',
      settings: { tracking: this.tracking, noteButton: this.noteButton },
    };
  }

  newId(prefix: string) {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }
}

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type { Txn, Cat, Owed };
