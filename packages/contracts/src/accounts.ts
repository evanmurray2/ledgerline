// Accounts contracts: one account's row, the Accounts screen, and an account's starting balance. Split from index.ts,
// which re-exports them (the register's RegisterView stays there, next to TxnListRow).
import { z } from 'zod';
import { cents, date, id, month } from './scalars.js';

export const AccountRow = z.object({
  id,
  name: z.string(),
  kind: z.enum(['checking', 'savings', 'credit']),
  institution: z.string(),
  mask: z.string().nullable(),
  /** Bank-reported (cleared). Cards: amount owed, positive. */
  bank: cents,
  pending: cents,
  /** Cleared + pending, excluding won't-clear. */
  working: cents,
  syncedAt: z.number().int().nullable(),
  connectionStatus: z.enum(['ok', 'login_required', 'error']),
  drift: cents.nullable(),
  /**
   * A row from before the budget start that came in after the link, in the last 7 days (D-?): "Starting debt
   * updated: Hertz $187.53".
   */
  startNote: z.string().nullable().optional(),
  statement: z.object({ balance: cents, due: date.nullable(), covered: z.boolean() }).nullable(),
  meta: z.string(),
});
export type AccountRow = z.infer<typeof AccountRow>;

export const AccountsView = z.object({
  netWorth: cents,
  netWorthChange: cents,
  month,
  owedOut: cents,
  groups: z.array(z.object({ name: z.string(), total: cents, accounts: z.array(AccountRow) })),
  repairs: z.array(
    z.object({ connectionId: id, institution: z.string(), lastSynced: z.number().int().nullable() }),
  ),
  failures: z.array(
    z.object({
      connectionId: id,
      institution: z.string(),
      lastGood: z.number().int().nullable(),
      nextRetry: z.number().int().nullable(),
    }),
  ),
  alerts: z.array(
    z.object({
      kind: z.enum([
        'monitor',
        'sync',
        'history_changed',
        'ambiguous_match',
        'vanished_pending',
        'possible_reissue',
        'identity',
      ]),
      text: z.string(),
      /** The stored alert's id when you can dismiss it (POST /api/alerts/:id/dismiss); absent for live checks. */
      id: z.string().optional(),
      /** The transaction it is about, when that row still exists. */
      txnKey: z.string().optional(),
    }),
  ),
});
export type AccountsView = z.infer<typeof AccountsView>;

/**
 * How the bank's balance at link became the account's starting balance (D-?). Money terms: positive is money in a
 * checking account; a card's debt is negative.
 */
export const StartBalance = z.object({
  /** The account's budget start: rows dated before it are part of the starting balance or history. */
  from: date,
  /** The bank's balance when you linked (or saved it in Setup). */
  atLink: cents,
  rows: z.array(
    z.object({
      key: z.string(),
      payee: z.string(),
      date,
      amount: cents,
      pending: z.boolean(),
      /** 'before': from before the start, not in the balance at link. 'linkDay': in it, counted in the budget. */
      role: z.enum(['before', 'linkDay']),
    }),
  ),
  /** The starting balance the budget uses. */
  total: cents,
  /** The day late rows stop joining, or null for an account without a bank link. */
  settlesOn: date.nullable(),
  settling: z.boolean(),
  /** The latest row that came in after the link, in the last 7 days. */
  recent: z.object({ payee: z.string(), date, amount: cents }).nullable(),
});
export type StartBalance = z.infer<typeof StartBalance>;
