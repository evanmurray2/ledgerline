// What list rows say about Owed to you: on a purchase, what is still owed and your share (what its category
// counts); on money in, the categories of the purchases it paid back. The money doesn't change: the owed part comes
// out of Ready to Assign and a payback goes back to it (Reimbursement links). The labels only make a category's
// list add up to its Spent.
import { cents, type OwedStatus, owedList } from '@ledgerline/domain';
import type { Stmt } from '@ledgerline/db/sql';
import type { Scoped } from '../db/scoped.js';

/**
 * Each owed item with the category its purchase counts in, as `owedCategory` in packages/domain picks it: its split
 * line's category, else a split purchase's first line, else the purchase's category.
 */
export const OWED_ITEMS_SQL = `SELECT e.id, e.txn_key, e.amount, e.canceled_at, e.closed_at,
    coalesce(
      (SELECT sp.category_id FROM txn_split sp WHERE sp.budget_id = e.budget_id AND sp.id = e.split_id),
      (SELECT sp.category_id FROM txn_split sp WHERE sp.budget_id = e.budget_id AND sp.txn_key = e.txn_key ORDER BY sp.sort LIMIT 1),
      (SELECT o.category_id FROM txn_overlay o WHERE o.budget_id = e.budget_id AND o.txn_key = e.txn_key)
    ) AS category_id
  FROM expected_reimbursement e WHERE e.budget_id = ?1`;

export const PAYBACK_LINKS_SQL = `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`;

export interface OwedItemRow {
  id: string;
  txn_key: string;
  amount: number;
  canceled_at: number | null;
  closed_at: number | null;
  category_id: string | null;
}

export interface PaybackLinkRow {
  from_key: string;
  to_key: string;
  amount: number;
}

/** A purchase's owed items together: what is still owed, its status, and the owed total its category leaves out. */
export interface OwedOnRow {
  still: number;
  status: OwedStatus;
  /** Owed amounts not cancelled, positive: the purchase's category counts its amount less this. */
  total: number;
}

export interface OwedLabels {
  owed: Map<string, OwedOnRow>;
  /** Money in → names of the categories whose purchases it paid back, in the order first matched. */
  paidFor: Map<string, string[]>;
}

export function owedStatements(s: Scoped): Stmt[] {
  return [s.q(OWED_ITEMS_SQL), s.q(PAYBACK_LINKS_SQL)];
}

export function owedLabels(
  items: readonly OwedItemRow[],
  links: readonly PaybackLinkRow[],
  categoryNames: ReadonlyMap<string, string>,
  today: string,
): OwedLabels {
  const owed = new Map<string, OwedOnRow>();
  for (const o of owedList(
    items.map((o) => ({
      id: o.id,
      txnKey: o.txn_key,
      amount: cents(o.amount),
      expectBy: null,
      closedAt: o.closed_at ? 'x' : null,
      canceledAt: o.canceled_at ? 'x' : null,
    })),
    links.map((l) => ({ inflowKey: l.from_key, itemId: l.to_key, amount: cents(l.amount) })),
    today,
  )) {
    if (o.status === 'canceled') continue;
    const was = owed.get(o.txnKey);
    // Several items on one purchase: it is owed while any one is still owed, and closed only if all are.
    const status: OwedStatus = !was
      ? o.status
      : was.status === 'open' || o.status === 'open' || was.status === 'late' || o.status === 'late'
        ? 'open'
        : was.status === 'paid_back' || o.status === 'paid_back'
          ? 'paid_back'
          : 'closed';
    owed.set(o.txnKey, {
      still: (was?.still ?? 0) + o.stillOwed,
      status,
      total: (was?.total ?? 0) + o.amount,
    });
  }
  const categoryOf = new Map(items.map((o) => [o.id, o.category_id]));
  const paidFor = new Map<string, string[]>();
  for (const l of links) {
    const names = paidFor.get(l.from_key) ?? [];
    const c = categoryOf.get(l.to_key);
    const name = c ? categoryNames.get(c) : undefined;
    if (name && !names.includes(name)) names.push(name);
    paidFor.set(l.from_key, names);
  }
  return { owed, paidFor };
}
