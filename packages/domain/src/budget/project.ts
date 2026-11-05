// From logical transactions (bank rows + manual pending + overlay, one row per transaction as v_transaction
// exposes them) to the budget lines computeBudget() reads, plus the terms of the rule 10 identity that are not
// budget lines: Waiting to match, unsorted transfer sides, uncategorized amounts and ledger working balances.
import { type Cents, cents } from '../money.js';
import { type IsoDate, type Month, monthOfDate } from '../month.js';
import type { BudgetLine } from './lines.js';
import type { StartRole } from './start.js';

export type AccountKind = 'checking' | 'savings' | 'credit';

export interface LedgerAccount {
  id: string;
  kind: AccountKind;
  /** Later of budget start and link date; earlier transactions are history. */
  budgetFrom: IsoDate;
  /**
   * Balance at budgetFrom, excluding pending (rule 8). Checking and savings: positive money. Cards: negative (debt).
   * For accounts linked after go-live this is the confirmed starting balance at link.
   */
  startingBalance: Cents;
}

export type TxnUse =
  | { type: 'category'; categoryId: string }
  | { type: 'split'; lines: { id: string; categoryId: string | null; amount: Cents }[] }
  | { type: 'rta' }
  | { type: 'uncategorized' }
  /** Paired with another budget account; a cash outflow to a card is a card payment (rule 4). */
  | { type: 'transfer'; otherAccountId: string }
  /** An unclear transfer side held aside until you pick (Transfer detection). */
  | { type: 'unsorted' }
  /** Marked by hand as a transfer to or from an account that isn't linked (decisions.md D-20). */
  | { type: 'offbudget' }
  /**
   * A person-to-person inflow held for matching (rule 9). `matched` is the part already matched to owed items
   * (it goes to RTA); the rest waits.
   */
  | { type: 'waiting'; matched?: Cents };

export interface OwedMark {
  itemId: string;
  /** Owed amount, positive. */
  amount: Cents;
  /** Split line it belongs to, if the transaction is split. */
  splitLineId?: string;
  /** Rule 11: Close charges the open amount to the original category in the closing month. */
  closed?: { month: Month; date: IsoDate; amount: Cents };
  canceled?: boolean;
}

export interface LogicalTxn {
  key: string;
  accountId: string;
  /** Effective date for budgeting (authorized date for card purchases when the bank gives one). */
  date: IsoDate;
  /** Effective amount: your estimate on a bank pending row when set, else the bank amount. Outflow negative. */
  amount: Cents;
  status: 'pending' | 'posted' | 'upcoming';
  wontClear?: boolean;
  /** Time added, for same-day ordering. */
  seq: number;
  /** Budget-month override ("counted in Oct", "Save for December"). */
  budgetMonth?: Month;
  /**
   * How the row relates to the starting balance (start.ts, D-67): 'before' rows (dated before budgetFrom, not in the
   * balance at link) join the starting balance; 'linkDay' rows (in the budget, already in the balance at link) come
   * out of it.
   */
  startRole?: StartRole;
  use: TxnUse;
  /** Card refunds: the purchase this refunds. */
  refundOf?: string;
  owed?: OwedMark[];
}

export interface Projection {
  lines: BudgetLine[];
  waitingToMatch: Cents;
  unsortedNet: Cents;
  uncategorizedNet: Cents;
  /** Ledger working balance per account: starting balance + budgeted transactions (pending in, won't-clear out). */
  working: Record<string, Cents>;
  /** Transactions that count in the budget (not history, not won't-clear, not future upcoming). */
  counted: number;
}

export interface ProjectOptions {
  accounts: readonly LedgerAccount[];
  txns: readonly LogicalTxn[];
  /** Budget start month (first budget month). */
  startMonth: Month;
  /** Today in the budget's time zone; upcoming rows count from their date. */
  today: IsoDate;
}

/** Dated before the account's budget start and not part of its starting balance: never counted. */
export function isHistory(t: LogicalTxn, acct: LedgerAccount): boolean {
  return t.date < acct.budgetFrom && t.startRole !== 'before';
}

/**
 * A line that moves the account's starting balance by `amount` (money terms: positive adds to a checking balance or
 * takes from a card's debt), as startLines() places it: in the start month, on budgetFrom, before that day's rows.
 */
function startShiftLine(key: string, a: LedgerAccount, startMonth: Month, amount: number): BudgetLine[] {
  if (amount === 0) return [];
  const base = {
    id: `${key}:start`,
    month: clampMonth(monthOfDate(a.budgetFrom), startMonth),
    date: a.budgetFrom,
    seq: -1,
  };
  return a.kind === 'credit'
    ? [{ kind: 'debt', ...base, cardAccountId: a.id, amount: cents(-amount) }]
    : [{ kind: 'rta', ...base, accountId: a.id, card: false, amount: cents(amount) }];
}

/** Lines for an account's starting balance (rule 8). */
export function startLines(a: LedgerAccount, startMonth: Month): BudgetLine[] {
  const m = clampMonth(monthOfDate(a.budgetFrom), startMonth);
  if (a.kind === 'credit') {
    // Rule 8: a card's starting debt never touches RTA; P starts at 0.
    return a.startingBalance < 0
      ? [
          {
            kind: 'debt',
            id: `start:${a.id}`,
            month: m,
            date: a.budgetFrom,
            seq: -1,
            cardAccountId: a.id,
            amount: cents(-a.startingBalance),
          },
        ]
      : [];
  }
  // Rule 8: checking and savings become RTA inflows at budget start (or link).
  return a.startingBalance !== 0
    ? [
        {
          kind: 'rta',
          id: `start:${a.id}`,
          month: m,
          date: a.budgetFrom,
          seq: -1,
          accountId: a.id,
          card: false,
          amount: a.startingBalance,
        },
      ]
    : [];
}

export interface TxnEffect {
  /** False when the transaction doesn't count (history, won't clear, upcoming not yet due). */
  counts: boolean;
  lines: BudgetLine[];
  waiting: number;
  unsorted: number;
  uncategorized: number;
  /**
   * Added to the account's working balance besides the transaction's amount: a 'linkDay' row's amount comes out of
   * the starting balance, so it is in the working balance once.
   */
  startShift: number;
}

/** One transaction's effect on the budget. Transactions are independent of each other, so lines can be rebuilt per transaction. */
export function linesForTxn(
  t: LogicalTxn,
  acct: LedgerAccount,
  accountKinds: ReadonlyMap<string, AccountKind>,
  startMonth: Month,
  today: IsoDate,
): TxnEffect {
  const none: TxnEffect = {
    counts: false,
    lines: [],
    waiting: 0,
    unsorted: 0,
    uncategorized: 0,
    startShift: 0,
  };
  if (isHistory(t, acct)) return none;
  if (t.wontClear) return none;
  if (t.status === 'upcoming' && t.date > today) return none;
  // Part of the starting balance (D-67): no category, Owed to you or transfer; it only moves the starting balance.
  if (t.date < acct.budgetFrom)
    return { ...none, counts: true, lines: startShiftLine(t.key, acct, startMonth, t.amount) };
  const lines: BudgetLine[] = [];
  let waiting = 0;
  let unsorted = 0;
  let uncategorized = 0;
  const card = acct.kind === 'credit';
  const month = clampMonth(t.budgetMonth ?? monthOfDate(t.date), startMonth);
  const base = { month, date: t.date, seq: t.seq };
  const u = t.use;

  // Owed parts of an outflow (Reimbursement links): out of RTA, not the category. Cancelled marks are ignored.
  const owedBySplit = new Map<string, number>();
  let owedWhole = 0;
  for (const ow of t.owed ?? []) {
    if (ow.canceled || t.amount >= 0) continue;
    lines.push({
      kind: 'owed',
      id: `${t.key}:owed:${ow.itemId}`,
      ...base,
      accountId: acct.id,
      card,
      amount: ow.amount,
      itemId: ow.itemId,
    });
    if (ow.splitLineId) owedBySplit.set(ow.splitLineId, (owedBySplit.get(ow.splitLineId) ?? 0) + ow.amount);
    else owedWhole += ow.amount;
    if (ow.closed) {
      const catId = owedCategory(u, ow.splitLineId);
      if (catId) {
        lines.push({
          kind: 'close',
          id: `${t.key}:close:${ow.itemId}`,
          month: ow.closed.month,
          date: ow.closed.date,
          seq: t.seq,
          categoryId: catId,
          amount: ow.closed.amount,
          itemId: ow.itemId,
        });
      }
    }
  }

  switch (u.type) {
    case 'category': {
      const amt = t.amount < 0 ? t.amount + owedWhole : t.amount;
      if (amt !== 0) {
        lines.push({
          kind: 'cat',
          id: `${t.key}:0`,
          ...base,
          accountId: acct.id,
          card,
          categoryId: u.categoryId,
          amount: cents(amt),
          ...(t.refundOf ? { refundOf: `${t.refundOf}:0` } : {}),
        });
      }
      break;
    }
    case 'split': {
      u.lines.forEach((sl, n) => {
        const amt =
          sl.amount < 0 ? sl.amount + (owedBySplit.get(sl.id) ?? 0) + (n === 0 ? owedWhole : 0) : sl.amount;
        if (sl.categoryId === null) uncategorized += amt;
        else if (amt !== 0) {
          lines.push({
            kind: 'cat',
            id: `${t.key}:${n}`,
            ...base,
            accountId: acct.id,
            card,
            categoryId: sl.categoryId,
            amount: cents(amt),
            // A split refund keeps its link: each refund line gives back from the same purchase (rule 3).
            ...(t.refundOf && amt > 0 ? { refundOf: `${t.refundOf}:0` } : {}),
          });
        }
      });
      break;
    }
    case 'rta':
      lines.push({ kind: 'rta', id: `${t.key}:0`, ...base, accountId: acct.id, card, amount: t.amount });
      break;
    case 'uncategorized':
      uncategorized += t.amount + (t.amount < 0 ? owedWhole : 0);
      break;
    case 'transfer': {
      // Budget → budget: no category. Cash out to a card is a card payment and draws down its payment category.
      if (!card && accountKinds.get(u.otherAccountId) === 'credit' && t.amount < 0) {
        lines.push({
          kind: 'payment',
          id: `${t.key}:0`,
          ...base,
          cardAccountId: u.otherAccountId,
          amount: cents(-t.amount),
        });
      }
      break;
    }
    case 'offbudget':
      // Money leaving or entering the budget accounts with no category: it comes from or goes to RTA.
      lines.push({ kind: 'rta', id: `${t.key}:0`, ...base, accountId: acct.id, card, amount: t.amount });
      break;
    case 'unsorted':
      unsorted += t.amount;
      break;
    case 'waiting': {
      const m = Math.min(u.matched ?? 0, t.amount);
      if (m > 0)
        lines.push({ kind: 'rta', id: `${t.key}:0`, ...base, accountId: acct.id, card, amount: cents(m) });
      waiting += t.amount - m;
      break;
    }
  }
  if (t.startRole === 'linkDay') {
    lines.push(...startShiftLine(t.key, acct, startMonth, -t.amount));
    return { counts: true, lines, waiting, unsorted, uncategorized, startShift: -t.amount };
  }
  return { counts: true, lines, waiting, unsorted, uncategorized, startShift: 0 };
}

export function project(o: ProjectOptions): Projection {
  const accounts = new Map(o.accounts.map((a) => [a.id, a]));
  const kinds = new Map(o.accounts.map((a) => [a.id, a.kind]));
  const lines: BudgetLine[] = [];
  const working: Record<string, number> = {};
  let waiting = 0;
  let unsorted = 0;
  let uncategorized = 0;
  let counted = 0;
  for (const a of o.accounts) {
    working[a.id] = a.startingBalance;
    lines.push(...startLines(a, o.startMonth));
  }
  for (const t of o.txns) {
    const acct = accounts.get(t.accountId);
    if (!acct) continue;
    const e = linesForTxn(t, acct, kinds, o.startMonth, o.today);
    if (!e.counts) continue;
    counted++;
    working[acct.id] = (working[acct.id] ?? 0) + t.amount + e.startShift;
    lines.push(...e.lines);
    waiting += e.waiting;
    unsorted += e.unsorted;
    uncategorized += e.uncategorized;
  }
  const w: Record<string, Cents> = {};
  for (const [k, v] of Object.entries(working)) w[k] = cents(v);
  return {
    lines,
    waitingToMatch: cents(waiting),
    unsortedNet: cents(unsorted),
    uncategorizedNet: cents(uncategorized),
    working: w,
    counted,
  };
}

function owedCategory(u: TxnUse, splitLineId?: string): string | null {
  if (u.type === 'category') return u.categoryId;
  if (u.type === 'split')
    return (splitLineId ? u.lines.find((l) => l.id === splitLineId) : u.lines[0])?.categoryId ?? null;
  return null;
}

function clampMonth(m: Month, start: Month): Month {
  return m < start ? start : m;
}
