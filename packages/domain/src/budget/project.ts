// From logical transactions (bank rows + manual pending + overlay, one row per transaction as v_transaction
// exposes them) to the budget lines computeBudget() reads, plus the terms of the rule 10 identity that are not
// budget lines: Waiting to match, unsorted transfer sides, uncategorized amounts and ledger working balances.
import { type Cents, cents } from '../money.js';
import { type IsoDate, type Month, monthOfDate } from '../month.js';
import type { BudgetLine } from './lines.js';

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
  /** A person-to-person inflow held for matching (rule 9). */
  | { type: 'waiting' };

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
  /** Pending at link (or the posted row it became): budgeted even if dated before budgetFrom. */
  pendingAtLink?: boolean;
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

export function isHistory(t: LogicalTxn, acct: LedgerAccount): boolean {
  return t.date < acct.budgetFrom && !t.pendingAtLink;
}

export function project(o: ProjectOptions): Projection {
  const accounts = new Map(o.accounts.map((a) => [a.id, a]));
  const lines: BudgetLine[] = [];
  const working: Record<string, number> = {};
  let waiting = 0;
  let unsorted = 0;
  let uncategorized = 0;
  let counted = 0;

  for (const a of o.accounts) {
    working[a.id] = a.startingBalance;
    const m = clampMonth(monthOfDate(a.budgetFrom), o.startMonth);
    if (a.kind === 'credit') {
      // Rule 8: a card's starting debt never touches RTA; P starts at 0.
      if (a.startingBalance < 0) {
        lines.push({
          kind: 'debt',
          id: `start:${a.id}`,
          month: m,
          date: a.budgetFrom,
          seq: -1,
          cardAccountId: a.id,
          amount: cents(-a.startingBalance),
        });
      }
    } else if (a.startingBalance !== 0) {
      // Rule 8: checking and savings become RTA inflows at budget start (or link).
      lines.push({
        kind: 'rta',
        id: `start:${a.id}`,
        month: m,
        date: a.budgetFrom,
        seq: -1,
        accountId: a.id,
        card: false,
        amount: a.startingBalance,
      });
    }
  }

  for (const t of o.txns) {
    const acct = accounts.get(t.accountId);
    if (!acct) continue;
    if (isHistory(t, acct)) continue;
    if (t.wontClear) continue;
    if (t.status === 'upcoming' && t.date > o.today) continue;
    counted++;
    working[acct.id] = (working[acct.id] ?? 0) + t.amount;
    const card = acct.kind === 'credit';
    const month = clampMonth(t.budgetMonth ?? monthOfDate(t.date), o.startMonth);
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
          if (sl.categoryId === null) {
            uncategorized += amt;
          } else if (amt !== 0) {
            lines.push({
              kind: 'cat',
              id: `${t.key}:${n}`,
              ...base,
              accountId: acct.id,
              card,
              categoryId: sl.categoryId,
              amount: cents(amt),
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
        const other = accounts.get(u.otherAccountId);
        // Budget → budget: no category. Cash out to a card is a card payment and draws down its payment category.
        if (!card && other?.kind === 'credit' && t.amount < 0) {
          lines.push({
            kind: 'payment',
            id: `${t.key}:0`,
            ...base,
            cardAccountId: other.id,
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
      case 'waiting':
        waiting += t.amount;
        break;
    }
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
