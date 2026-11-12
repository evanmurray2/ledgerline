// One transaction as a list row (Activity, registers, category sheet).
import type { TxnListRow } from '@ledgerline/contracts';
import { cents, formatCents } from '@ledgerline/domain';
import { inRta, type TxRow } from '../ledger/ledger.js';
import type { OwedOnRow } from './owed-rows.js';

export type ListSource = TxRow;

/**
 * A bank row dated before its account's budget start, pending or posted: outside the budget (Budget start). It is
 * history, or part of the starting balance when it wasn't in the balance at link (ledger/start-part.ts, D-67).
 */
export function isHistory(t: Pick<TxRow, 'source' | 'date' | 'budget_from'>): boolean {
  return t.source === 'bank' && !!t.budget_from && t.date < t.budget_from;
}

/**
 * Whether a list leaves the row out: posted "Before your budget" rows are never listed (D-61, D-62). A pending one
 * from before the start is listed under Pending, as the account's pending total counts it, with that badge (D-67).
 */
export function hiddenFromLists(t: Pick<TxRow, 'source' | 'status' | 'date' | 'budget_from'>): boolean {
  return isHistory(t) && t.status === 'posted';
}

/** hiddenFromLists as SQL, negated: rows the app lists. */
export const NOT_HISTORY = `NOT (source = 'bank' AND status = 'posted' AND budget_from IS NOT NULL AND date < budget_from)`;

/** isHistory as SQL, negated: rows in the budget, the only ones that can need you. */
export const IN_BUDGET_ROWS = `NOT (source = 'bank' AND budget_from IS NOT NULL AND date < budget_from)`;

export function categoryLabel(
  t: TxRow,
  categoryNames: ReadonlyMap<string, string>,
  hasSplit = false,
): string | null {
  if (t.transfer_state === 'paired') return 'Transfer';
  if (t.transfer_state === 'unsorted') return null;
  if (t.transfer_state === 'manual') return 'Transfer';
  if (hasSplit) return 'Split';
  if (inRta(t)) return 'Ready to Assign';
  if (t.category_id) return categoryNames.get(t.category_id) ?? 'Category';
  return null;
}

export function listRow(
  t: TxRow,
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
  extra: {
    owed?: OwedOnRow | null;
    /** Money in that paid back owed purchases: their categories' names (owed-rows.ts). */
    paidFor?: readonly string[] | null;
    stale?: boolean;
    split?: boolean;
    /** What the split's lines leave out of the amount (D-82). */
    splitOff?: number;
  } = {},
): TxnListRow {
  let badge: string | null = null;
  let badgeKind: TxnListRow['badgeKind'] = null;
  let sub: string | null = null;
  let sheet: TxnListRow['sheet'] = 'txn';
  const history = isHistory(t);
  if (history && !t.wont_clear) {
    // Before the account's budget start: shown for reference, never budgeted, never needs anything.
    badge = 'Before your budget';
    badgeKind = 'hold';
    sub = t.status === 'pending' ? 'starting balance' : 'not budgeted';
  } else if (t.wont_clear) {
    badge = 'Won’t clear';
    badgeKind = 'hold';
    sub = 'not counted';
  } else if (t.transfer_state === 'unsorted') {
    badge = 'Pick the account';
    badgeKind = 'alert';
    sub = 'which one?';
    sheet = 'transfer';
  } else if (t.source === 'manual' && t.status === 'pending') {
    badge = extra.stale ? 'Not at the bank yet' : 'Added by you';
    badgeKind = extra.stale ? 'alert' : 'mine';
    sub = 'added by you';
    if (extra.stale) sheet = 'checkPending';
  } else if (t.status === 'pending' && t.estimated_amount !== null && t.bank_amount !== null) {
    badge = 'Your estimate';
    badgeKind = 'est';
    sub = `bank ${formatCents(-(t.bank_amount ?? 0)).replace('−', '')}`;
  } else if (t.status === 'pending' && t.account_kind === 'credit') {
    badge = 'Card hold';
    badgeKind = 'hold';
    sub = 'card hold';
  } else if (extra.paidFor) {
    // Which purchases it paid back: the money is in Ready to Assign (the category tag), since the owed part never
    // came out of their categories.
    badge = extra.paidFor.length === 1 ? `Paid back · ${extra.paidFor[0]}` : 'Paid back';
    badgeKind = 'match';
  } else if (extra.owed) {
    // What the category counts: the purchase less the owed part, so the category's list adds up to its Spent.
    if (t.amount < 0 && extra.owed.total > 0)
      sub = `your share ${formatCents(Math.max(0, -t.amount - extra.owed.total))}`;
    // Just what is still owed ("$25 owed"); "Paid" once money back covers it.
    if (extra.owed.status === 'paid_back') {
      badge = 'Paid';
      badgeKind = 'match';
    } else if (extra.owed.status === 'closed') {
      badge = 'Closed out';
      badgeKind = 'hold';
    } else {
      badge = `${formatCents(extra.owed.still)} owed`;
      badgeKind = 'owed';
    }
  } else if (t.transfer_state === 'paired') {
    badge = 'Transfer';
    badgeKind = 'rule';
    sub = 'transfer';
  } else if (t.categorized_by === 'rule' || t.categorized_by === 'payee') {
    // Only rows categorized before rules were removed: they keep their chip (D-60). Nothing new is set this way.
    badge = 'By rule';
    badgeKind = 'rule';
  }
  if (t.alert && !t.reviewed_at && !history) {
    const a = JSON.parse(t.alert) as string[];
    const changed = a.find((x) => x.startsWith('amount_changed'));
    if (changed) {
      const [, before, after] = changed.split(':');
      const diff = Math.abs(Number(after)) - Math.abs(Number(before));
      badge = `Cleared ${formatCents(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'}`;
      badgeKind = 'alert';
      sub = `you estimated ${formatCents(Math.abs(Number(before)))}`;
    } else if (a.includes('cleared_despite_wont_clear')) {
      badge = 'Cleared after all';
      badgeKind = 'alert';
    }
  }
  if (extra.splitOff && !history) {
    badge = `Split ${formatCents(Math.abs(extra.splitOff))} off`;
    badgeKind = 'alert';
    sub = 'fix the split';
  }
  return {
    key: t.key,
    payee: t.payee,
    accountId: t.account_id,
    accountName: accountNames.get(t.account_id) ?? t.account_name,
    date: t.date,
    amount: cents(t.amount),
    status: t.status,
    wontClear: t.wont_clear === 1,
    categoryLabel: categoryLabel(t, categoryNames, extra.split) ?? (history ? 'Not budgeted' : null),
    badge,
    badgeKind,
    sub,
    sheet,
  };
}
