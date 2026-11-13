// The transaction sheet's contract (GET /api/transactions/:key). Split from index.ts, which re-exports it.
import { z } from 'zod';
import { cents, date, id, month } from './scalars.js';

export const TxnSheet = z.object({
  key: z.string(),
  kind: z.enum([
    'pending',
    'posted',
    'income',
    'refund',
    'paidBack',
    'transfer',
    'manual',
    'upcoming',
    'history',
  ]),
  /** A 'history' row that is part of the account's starting balance (D-67), not just before it. */
  inStartingBalance: z.boolean().optional(),
  /** A transfer between accounts (paired, or to an account that isn't linked): no payee, `payee` names the transfer. */
  transfer: z.boolean().optional(),
  payee: z.string(),
  /** The payee this transaction is under; null for a manual entry (it has only a name) and for a transfer. */
  payeeId: id.nullable().optional(),
  rawName: z.string(),
  accountId: id,
  accountName: z.string(),
  /** A paired transfer: the account on the other side. */
  otherAccountName: z.string().nullable().optional(),
  date,
  postedDate: date.nullable(),
  amount: cents,
  bankAmount: cents.nullable(),
  estimatedAmount: cents.nullable(),
  status: z.enum(['pending', 'posted', 'upcoming']),
  wontClear: z.boolean(),
  categoryId: id.nullable(),
  categoryLabel: z.string().nullable(),
  categorizedBy: z.string().nullable(),
  split: z
    .array(
      z.object({
        id,
        categoryId: id.nullable(),
        amount: cents,
        memo: z.string().nullable(),
        absorbsRemainder: z.boolean(),
        /** The line is owed to you (an owed item open for it). */
        owed: z.boolean().optional(),
      }),
    )
    .nullable(),
  memo: z.string().nullable(),
  budgetMonth: month,
  budgetMonthOverridden: z.boolean(),
  owed: z.array(
    z.object({
      id,
      /** The share picked when it was marked: a fraction (half, all) or a fixed amount (custom). */
      share: z.enum(['half', 'all', 'custom']),
      amount: cents,
      matched: cents,
      expectBy: date.nullable(),
      status: z.string(),
    }),
  ),
  paybacks: z.array(z.object({ inflowKey: z.string(), itemId: id, amount: cents, label: z.string() })),
  /**
   * A card refund's purchase (txn_link refund_of): the payment category gives back what it set aside for it (Money
   * rule 3). Linked and unlinked with POST /api/transactions/:key/refund-of.
   */
  refundOf: z
    .object({
      key: z.string(),
      label: z.string(),
      /** The purchase's category, which the refund can go back to; null for a split or uncategorized purchase. */
      categoryId: id.nullable().optional(),
      categoryName: z.string().nullable().optional(),
    })
    .nullable(),
  /**
   * The other row of a pair made by your entry and a bank row (a cover, or the posted charge that took your entry):
   * "Not the same" (POST /api/transactions/:key/not-same) undoes it.
   */
  pairedWith: z.object({ label: z.string() }).nullable(),
  alerts: z.array(z.string()),
});
export type TxnSheet = z.infer<typeof TxnSheet>;

/** A purchase a card refund can be linked to. */
export const RefundCandidate = z.object({
  key: z.string(),
  payee: z.string(),
  date,
  /** Money out: negative. */
  amount: cents,
  categoryLabel: z.string().nullable(),
});
export type RefundCandidate = z.infer<typeof RefundCandidate>;

/**
 * GET /api/transactions/:key/refund-of: the purchases on the same card in the 90 days up to the refund, newest first.
 * `suggested` has the ones from the refund's payee (docs/design.md, Credit card refunds); `others` the rest.
 */
export const RefundOfView = z.object({
  suggested: z.array(RefundCandidate),
  others: z.array(RefundCandidate),
});
export type RefundOfView = z.infer<typeof RefundOfView>;

/** Links a card refund to a purchase on the same card, or with `purchaseKey: null` unlinks it ("Not this purchase"). */
export const RefundLink = z.object({ purchaseKey: z.string().min(1).nullable() });
