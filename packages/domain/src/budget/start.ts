// Which bank rows belong to an account's starting balance (D-?). The budget starts on a date: a row dated before
// budgetFrom is part of the starting balance, one dated on or after it is in the budget. The stored starting balance
// is the bank's balance at the moment of the link, so two kinds of rows need an adjustment:
//
// - 'before': dated before budgetFrom but not in the balance at link: pending then (pending at link), or posted
//   rows Plaid sent only later (settling). They add to the starting balance.
// - 'linkDay': dated on or after budgetFrom but already posted and in the balance at link (the link day's own
//   rows). They are in the budget like any row and come out of the starting balance, so they count once.
//
// Every other row dated before budgetFrom is history: already in the balance at link, never budgeted.
import { type IsoDate, addDays } from '../month.js';

export type StartRole = 'before' | 'linkDay';

/** A late posted row from before the budget start counts in the starting balance only within this many days. */
export const SETTLE_DAYS = 14;
/** Rows Plaid sends this soon after the connection's first row are the first sync: in the balance at link. */
export const FIRST_SYNC_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The link of the connection a row came from. Only bank connections (Plaid) have one; CSV imports don't. */
export interface LinkInfo {
  /** When the connection was linked. Settling runs SETTLE_DAYS from here. */
  linkedAt: number;
  /**
   * When the stored starting balance was read: the link, or a later save of the bank's balance (Setup's last step).
   * Rows that arrived by then are in it.
   */
  balanceAt?: number;
  /** When the connection's first row arrived: the start of its first sync. Null before any row. */
  firstSeen: number | null;
}

export interface StartRoleInput {
  source: 'bank' | 'manual';
  status: 'pending' | 'posted' | 'upcoming';
  /** Budget date (authorized date for card purchases). */
  date: IsoDate;
  /** When this row (for a posted row: the posted version) first arrived, epoch ms. */
  firstSeenAt: number;
  /** Pending when its account was linked (stored at filing; kept when the row posts). */
  pendingAtLink: boolean;
}

/** The last moment a late row can still join the starting balance. */
export function settlesAt(link: LinkInfo): number {
  return link.linkedAt + SETTLE_DAYS * DAY_MS;
}

export function startRole(t: StartRoleInput, budgetFrom: IsoDate, link: LinkInfo | null): StartRole | null {
  if (t.source !== 'bank') return null;
  // The stored starting balance is the balance at link only for a link on or after the budget start (the app links
  // after choosing the start; a day's slack for time zones). Otherwise only the pending rule applies.
  const atStart =
    !!link && link.firstSeen !== null && link.linkedAt >= Date.parse(`${budgetFrom}T00:00:00Z`) - DAY_MS;
  if (t.date < budgetFrom) {
    if (t.pendingAtLink || t.status === 'pending') return 'before';
    if (!link || link.firstSeen === null || !atStart) return null;
    if (inBalance(t, link)) return null;
    return t.firstSeenAt <= settlesAt(link) && t.date >= addDays(budgetFrom, -SETTLE_DAYS) ? 'before' : null;
  }
  if (!link || link.firstSeen === null || !atStart || t.status !== 'posted' || t.pendingAtLink) return null;
  // Only a first sync that ran right after the link shows what the balance at link held: rows that arrive hours
  // later may have posted after it.
  if (link.firstSeen > link.linkedAt + FIRST_SYNC_MS) return null;
  return inBalance(t, link) ? 'linkDay' : null;
}

/** The row arrived with the first sync, or before the stored balance was read, so that balance holds it. */
function inBalance(t: Pick<StartRoleInput, 'firstSeenAt'>, link: LinkInfo): boolean {
  return t.firstSeenAt <= Math.max((link.firstSeen ?? 0) + FIRST_SYNC_MS, link.balanceAt ?? 0);
}

/** A row that arrived after the stored balance was read: one you didn't see at link. */
export function cameInLater(firstSeenAt: number, link: LinkInfo | null): boolean {
  return !!link && link.firstSeen !== null && !inBalance({ firstSeenAt }, link);
}
