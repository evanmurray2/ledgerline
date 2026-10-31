import type { Cents } from '../money.js';
import type { IsoDate, Month } from '../month.js';

/**
 * A budget line is one effect of one logical transaction on the budget. Lines are derived from bank rows, manual
 * pending rows and the overlay (see project.ts) and are the only input computeBudget() reads besides assignments.
 *
 * Amounts are signed cents: outflows negative, inflows positive. Within a month, lines are processed by date, then
 * cash before card on the same day, then `seq` (time added).
 */
export type BudgetLine = RtaLine | CategoryLine | OwedLine | CloseLine | PaymentLine | DebtLine;

interface Base {
  /** txn_key:n — unique per line. */
  id: string;
  month: Month;
  date: IsoDate;
  seq: number;
}

/** Inflow to (or reversal out of) Ready to Assign: starting balances, income, rewards, matched paybacks. */
export interface RtaLine extends Base {
  kind: 'rta';
  accountId: string;
  card: boolean;
  amount: Cents;
}

/** Category activity on a cash or card account. Card inflows are refunds (rule 3). */
export interface CategoryLine extends Base {
  kind: 'cat';
  accountId: string;
  card: boolean;
  categoryId: string;
  amount: Cents;
  /** For card refunds: the id of the linked purchase line. */
  refundOf?: string;
}

/** The owed part of an outflow (rule 5 / Reimbursement links): charged to RTA; on a card also moved to P in full. */
export interface OwedLine extends Base {
  kind: 'owed';
  accountId: string;
  card: boolean;
  /** Positive owed amount. */
  amount: Cents;
  itemId: string;
}

/** Close (rule 11): charges the open owed amount to the original category in the closing month and adds it to RTA. */
export interface CloseLine extends Base {
  kind: 'close';
  categoryId: string;
  /** Positive closed amount. */
  amount: Cents;
  itemId: string;
}

/** Payment from cash to a card (rule 4): a transfer that draws down the card's payment category. */
export interface PaymentLine extends Base {
  kind: 'payment';
  cardAccountId: string;
  /** Positive amount paid. */
  amount: Cents;
}

export function lineOrder(a: BudgetLine, b: BudgetLine): number {
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ca = 'card' in a && a.card ? 1 : 0;
  const cb = 'card' in b && b.card ? 1 : 0;
  if (ca !== cb) return ca - cb;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * A card's starting debt (rule 8). It never touches RTA and P starts at 0; it only enters the unbudgeted card debt
 * that the rule 10 identity accounts for.
 */
export interface DebtLine extends Base {
  kind: 'debt';
  cardAccountId: string;
  /** Positive amount owed at budget start (or link). */
  amount: Cents;
}
