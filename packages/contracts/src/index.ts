// API contract shared by the Worker (apps/worker) and the SPA (apps/web). Zod schemas validate every request in
// the Worker; the SPA uses the inferred types. Money is integer cents everywhere; months are 'YYYY-MM', dates
// 'YYYY-MM-DD'. Mutations require `content-type: application/json` and the `x-ledgerline: 1` header.
import { z } from 'zod';
import { calendarDate, cents, date, id, month } from './scalars.js';
import { AccountRow, StartBalance } from './accounts.js';

export * from './accounts.js';

export const CSRF_HEADER = 'x-ledgerline';

// ---------------------------------------------------------------- session

export const Session = z.object({
  user: z.object({ email: z.string(), login: z.string().nullable() }),
  budget: z.object({
    id,
    name: z.string(),
    startMonth: month.nullable(),
    timeZone: z.string(),
    currentMonth: month,
    today: date,
    setupStep: z.enum(['start', 'link', 'categories', 'done']),
  }),
  appVersion: z.string(),
  /** 'ok' | 'paused' (70% of a daily limit) | 'readonly' (90%: banner, writes refused). */
  writeState: z.enum(['ok', 'paused', 'readonly']),
  readOnlyUntil: z.string().nullable(),
  /** 95% of a daily limit: reading stops too, and the app shows what it saved (optional: older Workers omit it). */
  readsPaused: z.boolean().optional(),
  settings: z.object({ tracking: z.boolean(), noteButton: z.boolean() }),
  /** Whether this user may link a new bank (D-75: admins only on Plaid Trial). Older Workers omit it: true. */
  canLinkBanks: z.boolean().optional(),
  /** Always true now. An app from before Plaid's script was removed reads it to pick hosted Link. */
  hostedLink: z.boolean().optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * The header an app sends to say it can open a sealed budget (docs/privacy.md 5.3). Without it, a sealed budget
 * answers every old route "update the app".
 */
export const SEALED_HEADER = 'x-ledgerline-sealed';

/**
 * A request signed with the budget's key (docs/privacy-keys.md 11): the Directory's challenge token, and the
 * signature (hex) over the request.
 */
export const SIGNED_CHALLENGE_HEADER = 'x-ledgerline-challenge';
export const SIGNED_SIGNATURE_HEADER = 'x-ledgerline-signature';

/**
 * What the server says about a signed-in person whose budget is sealed: who they are and what the account may
 * do now. It holds nothing of the budget: the name, the time zone and the months come from the device's copy.
 */
export const SealedSession = z.object({
  sealed: z.literal(true),
  user: z.object({ email: z.string() }),
  budgetId: id,
  appVersion: z.string(),
  writeState: z.enum(['ok', 'paused', 'readonly']),
  readOnlyUntil: z.string().nullable(),
  readsPaused: z.boolean(),
  canLinkBanks: z.boolean(),
  /** When the recovery key last signed in to this account, for 14 days (docs/privacy.md 5.8). */
  recoveryKeyUsedAt: z.string().nullable().optional(),
  /**
   * The budget has no first entry yet (D-102): this device makes its key, its recovery key and its first entry
   * (apps/web/src/keys/budget.ts createBudget), and the budget is locked from then on.
   */
  fresh: z.boolean().optional(),
});
export type SealedSession = z.infer<typeof SealedSession>;

// ---------------------------------------------------------------- budget

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

export const TxnListRow = z.object({
  key: z.string(),
  payee: z.string(),
  accountId: id,
  accountName: z.string(),
  date,
  amount: cents,
  status: z.enum(['pending', 'posted', 'upcoming']),
  wontClear: z.boolean(),
  categoryLabel: z.string().nullable(),
  /** Short badge, e.g. "By rule", "Your estimate", "Pending", "$25 owed", "Paid". */
  badge: z.string().nullable(),
  badgeKind: z
    .enum(['alert', 'match', 'est', 'hold', 'mine', 'paired', 'owed', 'rule', 'transfer'])
    .nullable(),
  sub: z.string().nullable(),
  /** Which sheet opens: pending, posted, income, refund, paid back, transfer pick, match, check pending. */
  sheet: z.enum(['txn', 'transfer', 'match', 'checkPending']),
  /** An upcoming transaction you added that repeats: how often. Left out when it doesn't. */
  repeats: z.enum(['monthly', 'yearly']).optional(),
});
export type TxnListRow = z.infer<typeof TxnListRow>;

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
  moveOptions: z.array(z.object({ id: id.or(z.literal('rta')), label: z.string() })),
});
export type CategorySheet = z.infer<typeof CategorySheet>;

export const TargetRequest = z.object({ categoryId: id, month, target: Target });

// ---------------------------------------------------------------- activity

export const ActivityView = z.object({
  attentionCount: z.number().int(),
  /** Pending and upcoming rows, whatever the filter or search: Activity hides its Not posted yet chip at 0. */
  notPostedCount: z.number().int(),
  transfersToSort: z.array(TxnListRow),
  needsCategory: z.array(
    TxnListRow.extend({
      payeeId: id.nullable().optional(),
      /** The bank's own text, shown under a new payee. */
      rawName: z.string().optional(),
      /** You haven't categorized any of this payee's transactions yet (docs/payees.md 4.2). */
      newPayee: z.boolean().optional(),
      /** A payee you have categorized with exactly this name: "Same as your …?" with Join (docs/payees.md 4.3). */
      sameAs: z.object({ id, name: z.string() }).nullable().optional(),
      /** The categories you've used for this payee in this direction, most used first (docs/payees.md 2.3). */
      history: z
        .object({
          title: z.string(),
          categories: z.array(z.object({ id, name: z.string(), count: z.number().int() })),
        })
        .nullable(),
      /** The suggested category (docs/payees.md 2.1): `categoryId` null with `toRta` for Ready to Assign. */
      suggestion: z
        .object({ categoryId: id.nullable(), toRta: z.boolean(), name: z.string(), strong: z.boolean() })
        .nullable(),
    }),
  ),
  /**
   * `accept`: a bank row that cleared at another amount than your estimate (the bank's amount counts); `dismiss`: any
   * other alert. Both are answered with POST /api/transactions/:key/review, and undone with .../review/undo.
   * `review` opens the sheet.
   */
  checkThese: z.array(TxnListRow.extend({ action: z.enum(['accept', 'dismiss', 'review']) })),
  /**
   * "Same purchase?" (docs/payee-names.md 9.1): one card per bank row that could be your entry or another bank row,
   * with no exact evidence (or several rows with it). Answered with POST /api/same-purchase/:id.
   */
  samePurchase: z.array(
    z.object({ id: z.string(), row: TxnListRow, candidates: z.array(TxnListRow).min(1) }),
  ),
  /**
   * A bank pending row removed with nothing posted after 5 days, usually a released hold (the `vanished_pending`
   * alert). OK dismisses it with POST /api/alerts/:id/dismiss.
   */
  removedByBank: z.array(
    z.object({
      id: z.string(),
      payee: z.string(),
      amount: cents,
      date: z.string().nullable(),
      accountName: z.string().nullable(),
    }),
  ),
  pending: z.array(TxnListRow),
  pendingTotal: cents,
  upcoming: z.array(TxnListRow),
  posted: z.array(TxnListRow),
  nextCursor: z.string().nullable(),
  categoryPicker: z.array(
    z.object({
      group: z.string(),
      categories: z.array(z.object({ id, name: z.string(), available: cents })),
    }),
  ),
  /** With `?category=<id>` (one category's transactions): its name, null when there is no such category. */
  categoryName: z.string().nullable().optional(),
});
export type ActivityView = z.infer<typeof ActivityView>;

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
  refundOf: z.object({ key: z.string(), label: z.string() }).nullable(),
  /**
   * The other row of a pair made by your entry and a bank row (a cover, or the posted charge that took your entry):
   * "Not the same" (POST /api/transactions/:key/not-same) undoes it.
   */
  pairedWith: z.object({ label: z.string() }).nullable(),
  alerts: z.array(z.string()),
  /**
   * A row that can still be called a transfer (not one yet, or one to sort out): the other sides
   * POST /api/transfers/:key/pick takes as `otherKey`, nearest date first. Rows of the opposite amount in another
   * account within 5 days that aren't a transfer yet; a row with `sheet: 'transfer'` waits for this answer too.
   */
  candidates: z.array(TxnListRow).optional(),
});
export type TxnSheet = z.infer<typeof TxnSheet>;

/** How much of money out is owed to you: a share of it, or a typed amount (at most the purchase). */
export const OwedMark = z.object({
  mode: z.enum(['half', 'even', 'all', 'fraction', 'fixed']),
  n: z.number().int().positive().optional(),
  num: z.number().int().optional(),
  den: z.number().int().optional(),
  amount: cents.optional(),
  expectBy: calendarDate.nullable(),
});
export type OwedMark = z.infer<typeof OwedMark>;
export const TxnPatch = z.object({
  categoryId: id.nullable().optional(),
  toRta: z.boolean().optional(),
  split: z
    .array(
      z.object({
        categoryId: id.nullable(),
        amount: cents,
        memo: z.string().max(200).nullable(),
        absorbsRemainder: z.boolean(),
        /** The line is owed to you: it has no category, and an owed item of its amount is made for it. */
        owed: z.boolean().optional(),
      }),
    )
    .nullable()
    .optional(),
  memo: z.string().max(500).nullable().optional(),
  estimatedAmount: cents.nullable().optional(),
  /** A transaction you added (pending or upcoming): its amount, outflow negative. */
  amount: cents.optional(),
  /**
   * A transaction you added: its date. A pending one stays today or earlier (a later date is an upcoming one); an
   * upcoming one counts from its new date.
   */
  date: calendarDate.optional(),
  wontClear: z.boolean().optional(),
  budgetMonth: month.nullable().optional(),
  payeeName: z.string().min(1).max(120).optional(),
  markOwed: OwedMark.nullable().optional(),
});
export const CategorizeRequest = z.object({
  keys: z.array(z.string()).min(1).max(200),
  categoryId: id.nullable(),
  toRta: z.boolean().optional(),
});
export const NewTxnRequest = z.object({
  kind: z.enum(['pending', 'upcoming']),
  accountId: id,
  date: calendarDate,
  /** Outflow negative. */
  amount: cents,
  payee: z.string().min(1).max(120),
  categoryId: id.nullable(),
  /** Money in that goes to Ready to Assign (no category). */
  toRta: z.boolean().optional(),
  repeats: z.enum(['never', 'monthly', 'yearly']),
  /**
   * A pending entry only, with no category: a transfer to (money out) or from (money in) this other account. A pending
   * entry of the opposite amount is added there, and the two are paired; each bank row takes its own side over.
   */
  transferAccountId: id.optional(),
  /** Money out, pending only: the part owed to you, as on the transaction sheet. */
  owed: OwedMark.optional(),
  /** Money in, pending only: the owed items it pays back, as Match money back does; all of it is in Ready to Assign. */
  paysBack: z
    .array(z.object({ itemId: id, amount: cents.positive() }))
    .min(1)
    .optional(),
});
export const MatchRequest = z.object({
  inflowKey: z.string(),
  items: z.array(z.object({ itemId: id, amount: cents.positive() })),
  /**
   * Ignored since D-98: all of a matched inflow is in RTA. Kept, optional, so an edit an older app queued offline (with
   * Keep waiting or I'll send it back) still applies.
   */
  rest: z.enum(['income', 'keep', 'send_back']).optional(),
});
/**
 * The answer to "Which account got this money?": a deposit's key, `null` for a payment, or `unlinked: true` (with
 * `otherKey: null`) for an account that isn't linked, which takes the money out of Ready to Assign (D-20). With
 * `otherKey: null` and `accountId`, the other side hasn't arrived yet: a pending entry of the opposite amount is
 * added in that account, paired with this row, and the bank's row takes it over when it comes (D-83).
 */
export const TransferPick = z.object({
  otherKey: z.string().nullable(),
  unlinked: z.boolean().optional(),
  accountId: id.optional(),
});
/** An answer to "Same purchase?" for one of the card's candidates (its key). */
export const SamePurchaseAnswer = z.object({ answer: z.enum(['yes', 'no']), key: z.string() });
/** Undo of No on a "Same purchase?" card: the candidate the No was about. */
export const SamePurchaseUndo = z.object({ key: z.string() });
export const PendingCheckAction = z.object({ action: z.enum(['keep_waiting', 'delete']) });

export const MatchView = z.object({
  inflow: TxnListRow,
  /** What this money can still pay back: the inflow less what it is already matched to. */
  left: cents,
  open: z.array(
    z.object({
      id,
      label: z.string(),
      still: cents,
      expectBy: date.nullable(),
      late: z.boolean(),
      suggested: cents,
    }),
  ),
});
export type MatchView = z.infer<typeof MatchView>;

// ---------------------------------------------------------------- owed

export const OwedView = z.object({
  out: cents,
  items: z.array(
    z.object({
      id,
      txnKey: z.string(),
      label: z.string(),
      sub: z.string(),
      categoryName: z.string().nullable(),
      amount: cents,
      matched: cents,
      still: cents,
      expectBy: date.nullable(),
      status: z.enum(['open', 'late', 'paid_back', 'closed', 'canceled']),
      /** Closed items: the month Close out counted in, and the amount it moved (Reopen, D-80). */
      closedMonth: month.nullable().optional(),
      closedAmount: cents.nullable().optional(),
    }),
  ),
  projected: z.array(z.object({ key: z.string(), date, owed: cents, shortfall: cents, label: z.string() })),
  /**
   * The newest money in from a person (Zelle, Venmo and the like) in the last 30 days that pays back nothing yet: what
   * Match money back opens (D-98). Null when there is none.
   */
  payback: z.object({ key: z.string(), payee: z.string(), amount: cents, date }).nullable().default(null),
});
export type OwedView = z.infer<typeof OwedView>;
export const OwedAction = z.object({
  /** reopen: undoes Close out or Remove the mark (D-80). */
  action: z.enum(['close', 'cancel', 'snooze', 'reopen']),
  expectBy: calendarDate.optional(),
});

// ---------------------------------------------------------------- accounts

export const RegisterView = z.object({
  account: AccountRow,
  days: z.array(z.object({ label: z.string(), balance: cents.nullable(), rows: z.array(TxnListRow) })),
  note: z.string().nullable(),
  /** Linked accounts only. */
  start: StartBalance.nullable().optional(),
  /** Why Close account can't run yet (the balance, pending rows or a card's payment category isn't $0); null when it can. */
  closeBlock: z.string().nullable(),
  /** A card's payment category available, sent with Close account; null for cash accounts. */
  cardAvailable: cents.nullable(),
  /**
   * A card whose only block to Close is money in its payment category: the Close sheet offers to move it to Ready to
   * Assign first (`POST /budget/move`). Null otherwise.
   */
  closeMove: z.object({ categoryId: id, amount: cents.positive() }).nullable().optional(),
  /** The register lists at most its newest rows (REGISTER_ROWS); true when there are older ones it leaves out. */
  more: z.boolean().optional(),
});
export type RegisterView = z.infer<typeof RegisterView>;

// ---------------------------------------------------------------- reports

export const ReportsView = z.object({
  month,
  monthToDate: z.boolean(),
  tiles: z.object({ spent: cents, invested: cents, income: cents, rewards: cents }),
  byCategory: z.array(z.object({ categoryId: id, name: z.string(), spent: cents })),
  stillOwed: cents,
  trend: z.array(z.object({ month, spent: cents, income: cents, invested: cents })),
  netWorth: z.array(z.object({ month, value: cents })),
});
export type ReportsView = z.infer<typeof ReportsView>;

// ---------------------------------------------------------------- settings

export const CategoriesView = z.object({
  groups: z.array(
    z.object({
      id,
      name: z.string(),
      isBills: z.boolean(),
      system: z.boolean(),
      categories: z.array(
        z.object({
          id,
          name: z.string(),
          kind: z.enum(['spending', 'saving', 'cc_payment']),
          meta: z.string(),
          available: cents,
        }),
      ),
    }),
  ),
  archived: z.array(z.object({ id, name: z.string(), meta: z.string() })),
});
export type CategoriesView = z.infer<typeof CategoriesView>;
export const CategoryUpsert = z.object({
  id: id.optional(),
  name: z.string().min(1).max(60),
  groupId: id.nullable(),
  kind: z.enum(['spending', 'saving']),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  lowThreshold: cents.nullable().optional(),
});
export const GroupUpsert = z.object({
  id: id.optional(),
  name: z.string().min(1).max(60),
  isBills: z.boolean(),
});
/**
 * Archiving a category moves what it still has to Ready to Assign. The phone works that amount out (D-45) and sends
 * it with the change number it worked it out at; the server refuses with 409 `changed` if anything changed since.
 */
export const PinRequest = z.object({ pinned: z.boolean() });
/** Money a category's archive moved to Ready to Assign: this month's available and later months' assignments. */
export const ReturnedMoney = z.array(z.object({ month, amount: cents })).max(130);
export const ArchiveRequest = z.object({
  archived: z.boolean(),
  available: cents.optional(),
  through: z.number().int().nonnegative().optional(),
  /**
   * Undo of an archive: restoring gives back what the archive moved to Ready to Assign (its `returned`). Refused
   * when the category isn't archived any more, so an Undo sent twice gives the money back once.
   */
  giveBack: ReturnedMoney.optional(),
});
export const RemoveCategoryRequest = ArchiveRequest.omit({ archived: true, giveBack: true });
/** What archiving (or removing) a category answers: the money it moved to Ready to Assign, for Undo. */
export const ArchiveResult = z.object({
  ok: z.literal(true),
  rta: cents,
  rtaUpdating: z.boolean(),
  outcome: z.enum(['deleted', 'archived']).optional(),
  returned: ReturnedMoney.default([]),
});
export const ReorderRequest = z.object({ ids: z.array(id).max(500) });

export const PayeesView = z.object({
  /** Payees with at least one transaction from the budget onward (docs/payees.md section 6). */
  payees: z.array(
    z.object({
      id,
      name: z.string(),
      /** Budget transactions only; history isn't counted. */
      transactions: z.number().int(),
      /** The category you've used most for money out to this payee. */
      usual: z.string().nullable(),
      /** That category's id, to offer it first when you add a transaction for this payee. */
      usualId: id.nullable(),
      /** The bank's own texts behind this payee, most used first (at most 10). */
      bankNames: z.array(z.object({ name: z.string(), count: z.number().int() })),
    }),
  ),
  /** Payees not listed (only history), for the same-name check when renaming. */
  others: z.array(z.object({ id, name: z.string() })),
});
export type PayeesView = z.infer<typeof PayeesView>;
/** Join payees into `keep` (rename = merge). `{ ids, name }` from an older app means `keep = ids[0]`. */
export const MergePayees = z.object({
  keep: id.optional(),
  ids: z.array(id).min(2).max(50),
  name: z.string().min(1).max(120).optional(),
});
export const MergeResult = z.object({ ok: z.literal(true), undoId: z.string() });
export type MergeResult = z.infer<typeof MergeResult>;
/** Characters that change how text around them reads (bidi overrides and isolates) or don't show (controls). */
export const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
export const RenameAccount = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a name.')
    .max(60)
    .refine((n) => !HIDDEN_CHARS.test(n), 'Use letters, numbers and punctuation only.'),
});
/**
 * Close an account (only at $0). The app adds what this phone shows: the working balance, a card's payment category
 * available, and the change number it worked them out at; the server refuses if anything changed since.
 */
export const CloseAccount = z.object({
  working: z.number().int().optional(),
  available: z.number().int().optional(),
  through: z.number().int().optional(),
});
export const RenamePayee = z.object({ name: z.string().min(1).max(120), remember: z.boolean().optional() });

export const ConnectionsView = z.object({
  used: z.number().int(),
  limit: z.number().int(),
  environment: z.enum(['sandbox', 'production']),
  items: z.array(
    z.object({
      id,
      institution: z.string(),
      accounts: z.string(),
      status: z.enum(['ok', 'login_required', 'error', 'removed']),
      lastSynced: z.number().int().nullable(),
      linkedAt: z.number().int(),
      /** False while a saved link's accounts still need setting up (Finish setup). */
      setupDone: z.boolean(),
    }),
  ),
});
export type ConnectionsView = z.infer<typeof ConnectionsView>;
export const LinkTokenRequest = z.object({
  mode: z.enum(['new', 'repair']),
  connectionId: id.optional(),
  confirmSlot: z.boolean().optional(),
  /** Link on Plaid's own site (docs/privacy.md 5.7): the answer then holds the page's address. */
  hosted: z.boolean().optional(),
});
/** Asks the server what a hosted Link session came to, and finishes the link if the person did. */
export const LinkFinish = z.object({
  linkToken: z.string().min(1).max(400),
  mode: z.enum(['new', 'repair']),
});
export const LinkFinishResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('waiting') }),
  z.object({ status: z.literal('exited') }),
  z.object({ status: z.literal('repaired') }),
  z.object({ status: z.literal('linked'), connectionId: id }),
]);
export type LinkFinishResult = z.infer<typeof LinkFinishResult>;
export const StartingBalances = z.object({
  accounts: z.array(z.object({ accountId: id, startingBalance: cents })),
});
export const SetupStart = z.object({ startMonth: month });

export const UsageBatch = z.object({
  sessionId: z.string().max(40),
  appVersion: z.string().max(20),
  events: z
    .array(
      z.object({
        at: z.number().int(),
        screen: z
          .string()
          .max(60)
          .regex(/^[a-z0-9_.-]+$/),
        event: z
          .string()
          .max(60)
          .regex(/^[a-z0-9_.-]+$/),
        target: z
          .string()
          .max(60)
          .regex(/^[a-z0-9_.-]+$/)
          .nullable(),
        value: z.number().int().nullable(),
      }),
    )
    .max(500),
});
export type UsageBatch = z.infer<typeof UsageBatch>;
export const NoteRequest = z.object({
  screen: z.string().max(60),
  text: z.string().min(1).max(2000),
  recentEvents: z.array(z.string().max(80)).max(20),
});
export const SettingsPatch = z.object({
  tracking: z.boolean().optional(),
  noteButton: z.boolean().optional(),
});

export const HealthView = z.object({
  ok: z.boolean(),
  connections: z.array(z.object({ id, lastSyncedAt: z.number().int().nullable(), stale: z.boolean() })),
  watermarkLag: z.number().int(),
  usage: z.object({
    day: z.string(),
    rowsRead: z.number().int(),
    rowsWritten: z.number().int(),
    readPct: z.number(),
    writePct: z.number(),
  }),
});
export type HealthView = z.infer<typeof HealthView>;

export const ApiError = z.object({ error: z.string(), message: z.string() });

// ---------------------------------------------------------------- sign-in (decisions.md D-27)

export const AuthStatus = z.object({
  signedIn: z.boolean(),
  hasPasskey: z.boolean(),
  /** No passkey yet and a setup code is configured: show first-time setup. */
  setupOpen: z.boolean(),
  /** Open sign-up is on (D-75); the Turnstile site key the check uses. */
  signupOpen: z.boolean().optional(),
  turnstileSiteKey: z.string().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

export const SecurityView = z.object({
  /** This user can delete their own account (users who aren't admins, D-75). */
  ownAccount: z.boolean().optional(),
  /** Show Settings → Users (admins, once there is anyone else or sign-up is on). */
  usersScreen: z.boolean().optional(),
  passkeys: z.array(
    z.object({ id: z.string(), name: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() }),
  ),
  /** Signed-in sessions on all devices. */
  sessions: z.number().int(),
  /**
   * Other devices "Sign out other devices" would sign out: the other sign-ins, and phones or computers that are
   * signed out but still have the budget saved on them (not listed in `signIns`; signing out others deletes it).
   */
  otherSessions: z.number().int().default(0),
  /**
   * Where you're signed in, newest first: each sign-in, named by device and browser ("iPhone · Safari"). Signing
   * one out ends its sign-in and turns off the budget saved on it (D-45), so the device deletes it.
   */
  signIns: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        signedInAt: z.string(),
        current: z.boolean(),
        /** The budget is saved on it. */
        saved: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type SecurityView = z.infer<typeof SecurityView>;

export const DeviceLink = z.object({ url: z.string(), expiresAt: z.string() });
export type DeviceLink = z.infer<typeof DeviceLink>;
