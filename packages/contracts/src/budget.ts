// The Budget screen, Assign, Move money and the category sheet.
import { z } from 'zod';
import { cents, date, id, month } from './scalars.js';
import { TxnListRow } from './txn-list-row.js';

export const CategoryStatus = z.enum([
  'overspent',
  'underfunded',
  'funded',
  'overfunded',
  'low',
  'invested',
  'no_target',
]);
export type CategoryStatus = z.infer<typeof CategoryStatus>;

export const BudgetCategoryRow = z.object({
  id,
  name: z.string(),
  kind: z.enum(['spending', 'saving']),
  assigned: cents,
  /** Outflows this month, your share, positive. */
  spent: cents,
  activity: cents,
  available: cents,
  status: CategoryStatus,
  /** The row's second line, e.g. "$387.60 of $600.00 spent", "needs $90.00 this month · $540 by Jan 15". */
  detail: z.string(),
  /** Share of this month's money left, 0–100, or null when the row shows no bar. */
  leftPercent: z.number().int().min(0).max(100).nullable(),
  need: cents,
  /** The one-tap fix for Needs attention (positive = into the category). */
  fix: z.object({ verb: z.enum(['Cover', 'Fund', 'Add', 'Move']), amount: cents }).nullable(),
  targetText: z.string(),
  /** Card overspending explained: which card's payment category is short because of this category. */
  creditOverspent: z.array(z.object({ cardAccountId: id, cardName: z.string(), amount: cents })),
});
export type BudgetCategoryRow = z.infer<typeof BudgetCategoryRow>;

export const CardRow = z.object({
  accountId: id,
  categoryId: id,
  name: z.string(),
  /** Payment category available (P). */
  available: cents,
  /** Card bank balance (amount owed, positive). */
  owed: cents,
  budgetedPending: cents,
  uncategorized: cents,
  need: cents,
  short: cents,
  status: z.enum(['covered', 'short']),
  statement: z.object({ balance: cents, due: date.nullable(), covered: z.boolean() }).nullable(),
  detail: z.string(),
});
export type CardRow = z.infer<typeof CardRow>;

export const AttentionItem = z.object({
  section: z.enum([
    'Ready to Assign',
    'Overspent',
    'Card payments',
    'Underfunded',
    'Low',
    'Overfunded',
    'Owed to you',
  ]),
  key: z.string(),
  name: z.string(),
  amount: cents,
  detail: z.string(),
  /** Category to fix with `fix.amount`, or a screen link. */
  categoryId: id.nullable(),
  fix: z
    .object({ verb: z.enum(['Cover', 'Fund', 'Add', 'Move', 'Review', 'Move money']), amount: cents })
    .nullable(),
  link: z.enum(['owed', 'category', 'assign', 'card']).nullable(),
  /** Card payments: the card account, whose screen the row opens. */
  accountId: id.nullable().optional(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

export const BudgetView = z.object({
  month,
  currentMonth: month,
  minMonth: month,
  maxMonth: month,
  rta: cents,
  /** True while an older edit is still being recalculated (decisions.md D-22). */
  rtaUpdating: z.boolean(),
  cards: z.array(CardRow),
  owed: z.object({ out: cents, late: z.number().int(), status: z.enum(['late', 'tracking']) }),
  groups: z.array(
    z.object({
      id,
      name: z.string(),
      isBills: z.boolean(),
      total: cents,
      categories: z.array(BudgetCategoryRow),
    }),
  ),
  archived: z.array(BudgetCategoryRow),
  attention: z.array(AttentionItem),
  /** Fund-all total for the Underfunded section. */
  underfundedTotal: cents,
  syncProblem: z.string().nullable(),
  /** Categories pinned to the top of Budget, oldest pin first (D-74). May name archived or removed ones. */
  pinned: z.array(id).default([]),
  /**
   * How this month's Ready to Assign came about, for the "has started" card: the current month only, after the
   * budget's first month; else null. Each part is a total computeBudget() already keeps, and
   * `rta = left − overspent + income + paidBack + closedOut − owed − assigned`.
   */
  carryOver: z
    .object({
      /** The month before. */
      from: month,
      /** Ready to Assign at the end of `from`, before its cash overspending (rule 6) came out. */
      left: cents,
      /** Cash overspending `from` left uncovered, which came out of Ready to Assign (rule 6), positive. */
      overspent: cents,
      /** Money into Ready to Assign this month that pays back nothing. */
      income: cents,
      /** The part of this month's money in that paid back what is owed to you. */
      paidBack: cents,
      /** What Close out gave back to Ready to Assign this month (rule 11; negative for a close undone). */
      closedOut: cents,
      /** The owed parts of this month's purchases, out of Ready to Assign until paid back, positive. */
      owed: cents,
      /** Assigned in this month and later months. */
      assigned: cents,
    })
    .nullable()
    .default(null),
});
export type BudgetView = z.infer<typeof BudgetView>;

export const AssignRequest = z.object({
  month,
  /** Each item adds `amount` (may be negative) to the category's assignment for the month. */
  items: z
    .array(
      z.object({
        categoryId: id,
        amount: cents,
        /**
         * What the device showed assigned to the category in the month. When sent, the server adds only if that is
         * still so, and refuses with 409 `changed` otherwise: two devices (or tabs) tapping Assign on the same
         * suggestions don't add them twice.
         */
        was: cents.optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const MoveRequest = z.object({
  month,
  from: id.or(z.literal('rta')),
  to: id.or(z.literal('rta')),
  amount: cents.positive(),
});
export const SetAssignedRequest = z.object({ month, categoryId: id, assigned: cents });
export const MutationResult = z.object({ ok: z.literal(true), rta: cents, rtaUpdating: z.boolean() });
/**
 * What the server answers to a change (D-45): it no longer works out Ready to Assign, so `rta` is absent; the app
 * syncs and fills it from the phone's own compute before showing the result.
 */
export const MutationAck = z.object({
  ok: z.literal(true),
  rta: cents.optional(),
  rtaUpdating: z.boolean().optional(),
});
export type MutationAck = z.infer<typeof MutationAck>;
export type MutationResult = z.infer<typeof MutationResult>;

export const AssignSuggestion = z.object({
  categoryId: id,
  name: z.string(),
  reason: z.enum(['cover', 'target', 'card']),
  detail: z.string(),
  amount: cents,
  /** Ticked when the sheet opens: overspending, card shortfalls and underfunded targets, not Low categories. */
  preselected: z.boolean(),
});
export const AssignView = z.object({
  month,
  rta: cents,
  suggestions: z.array(AssignSuggestion),
  /** What each category has assigned in the month (none: 0), sent back as `was` with an assignment. */
  assigned: z.record(z.string(), cents).default({}),
});
export type AssignView = z.infer<typeof AssignView>;

export const Target = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('refill'),
    amount: cents,
    periodMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
    anchor: month,
  }),
  z.object({ type: z.literal('set_aside'), amount: cents }),
  z.object({ type: z.literal('by_date'), amount: cents, targetMonth: month }),
  z.object({ type: z.literal('no_date'), amount: cents, monthly: cents.nullable() }),
  z.object({ type: z.literal('none') }),
]);
export type Target = z.infer<typeof Target>;

export const CategorySheet = z.object({
  id,
  name: z.string(),
  month,
  status: CategoryStatus,
  statusText: z.string(),
  assigned: cents,
  spent: cents,
  available: cents,
  target: Target,
  targetText: z.string(),
  targetHelp: z.string(),
  lastMonthAssigned: cents,
  /** Available at the start of the month (what the month before left), which a target's monthly need counts from. */
  carry: cents.default(0),
  rta: cents,
  recent: z.array(TxnListRow),
  recentTotal: z.number().int(),
});
export type CategorySheet = z.infer<typeof CategorySheet>;

export const TargetRequest = z.object({ categoryId: id, month, target: Target });
