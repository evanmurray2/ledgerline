// One transaction as a list row (Activity, registers, category sheet).
import type { TxnListRow } from '@ledgerline/contracts';
import { cents, formatCents } from '@ledgerline/domain';
import type { TxRow } from '../ledger/ledger.js';

export type ListSource = TxRow;

/**
 * A bank row dated before its account's budget start, pending or posted: outside the budget (Budget start). It is
 * history, or part of the starting balance when it wasn't in the balance at link (ledger/start-part.ts, D-?).
 */
export function isHistory(t: Pick<TxRow, 'source' | 'date' | 'budget_from'>): boolean {
  return t.source === 'bank' && !!t.budget_from && t.date < t.budget_from;
}

/** isHistory as SQL, negated: rows the app lists. "Before your budget" rows are never listed (D-61, D-62). */
export const NOT_HISTORY = `NOT (source = 'bank' AND budget_from IS NOT NULL AND date < budget_from)`;

export function categoryLabel(
  t: TxRow,
  categoryNames: ReadonlyMap<string, string>,
  hasSplit = false,
): string | null {
  if (t.wtm_state === 'waiting' || t.wtm_state === 'send_back') return 'Waiting to match';
  if (t.transfer_state === 'paired') return 'Transfer';
  if (t.transfer_state === 'unsorted') return null;
  if (t.transfer_state === 'manual') return 'Transfer';
  if (hasSplit) return 'Split';
  if (t.to_rta === 1 || t.wtm_state === 'matched' || t.wtm_state === 'income') return 'Ready to Assign';
  if (t.category_id) return categoryNames.get(t.category_id) ?? 'Category';
  return null;
}

export function listRow(
  t: TxRow,
  accountNames: ReadonlyMap<string, string>,
  categoryNames: ReadonlyMap<string, string>,
  extra: {
    owed?: { amount: number; label: string } | null;
    paidBack?: boolean;
    stale?: boolean;
    split?: boolean;
  } = {},
): TxnListRow {
  let badge: string | null = null;
  let badgeKind: TxnListRow['badgeKind'] = null;
  let sub: string | null = null;
  let sheet: TxnListRow['sheet'] = 'txn';
  const history = isHistory(t);
  if (history) {
    // Before the account's budget start: shown for reference, never budgeted, never needs anything.
    badge = 'Before your budget';
    badgeKind = 'hold';
    sub = 'not budgeted';
  } else if (t.wont_clear) {
    badge = 'Won’t clear';
    badgeKind = 'hold';
    sub = 'not counted';
  } else if (t.wtm_state === 'waiting' || t.wtm_state === 'send_back') {
    badge = 'Waiting to match';
    badgeKind = 'match';
    sub = 'held';
    sheet = 'match';
  } else if (t.transfer_state === 'unsorted') {
    badge = 'Pick the other side';
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
  } else if (extra.paidBack) {
    badge = 'Paid back';
    badgeKind = 'match';
  } else if (extra.owed) {
    badge = `Owed to you · ${extra.owed.label}`;
    badgeKind = 'owed';
    sub = `${formatCents(extra.owed.amount)} owed to you`;
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
      badge = 'Cleared despite won’t clear';
      badgeKind = 'alert';
    }
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
