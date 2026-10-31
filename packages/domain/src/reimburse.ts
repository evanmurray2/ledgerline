// The Owed to you list (Reimbursement links): not a category, holds no money. Still owed = amount expected minus
// the paybacks linked to it; an item is paid back when that reaches zero.
import { type Cents, cents } from './money.js';
import type { IsoDate } from './month.js';

export interface OwedItem {
  id: string;
  txnKey: string;
  amount: Cents;
  expectBy: IsoDate | null;
  closedAt?: IsoDate | null;
  canceledAt?: IsoDate | null;
}

export interface PaybackLink {
  /** The inflow paying the item. */
  inflowKey: string;
  itemId: string;
  amount: Cents;
}

export type OwedStatus = 'open' | 'late' | 'paid_back' | 'closed' | 'canceled';

export interface OwedRow extends OwedItem {
  matched: Cents;
  stillOwed: Cents;
  status: OwedStatus;
}

export function owedList(
  items: readonly OwedItem[],
  links: readonly PaybackLink[],
  today: IsoDate,
): OwedRow[] {
  const matched = new Map<string, number>();
  for (const l of links) matched.set(l.itemId, (matched.get(l.itemId) ?? 0) + l.amount);
  return items.map((it) => {
    const m = matched.get(it.id) ?? 0;
    const still = Math.max(0, it.amount - m);
    let status: OwedStatus;
    if (it.canceledAt) status = 'canceled';
    else if (it.closedAt) status = 'closed';
    else if (still === 0) status = 'paid_back';
    else if (it.expectBy && it.expectBy < today) status = 'late';
    else status = 'open';
    return {
      ...it,
      matched: cents(m),
      stillOwed: cents(status === 'open' || status === 'late' ? still : 0),
      status,
    };
  });
}

/** "$1,430.60 out": what is still owed on open and late items. */
export function owedOut(rows: readonly OwedRow[]): Cents {
  let s = 0;
  for (const r of rows) s += r.stillOwed;
  return cents(s);
}
