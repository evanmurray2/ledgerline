// API contract shared by the Worker (apps/worker) and the SPA (apps/web). Zod schemas validate every request in
// the Worker; the SPA uses the inferred types. Money is integer cents everywhere; months are 'YYYY-MM', dates
// 'YYYY-MM-DD'. Mutations require `content-type: application/json` and the `x-ledgerline: 1` header.
import { z } from 'zod';
import { calendarDate, cents, date, id, month } from './scalars.js';
import { AccountRow, StartBalance } from './accounts.js';

export * from './accounts.js';
export * from './budget.js';
export * from './txn-list-row.js';
export * from './txn-sheet.js';
export * from './names.js';
export * from './settings.js';
export * from './auth.js';
export * from './results.js';
import { payeeName } from './names.js';
import { TxnListRow } from './txn-list-row.js';

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
  payeeName: payeeName.optional(),
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
  payee: payeeName,
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
  /**
   * Money in from the last 60 days that paid back what is owed to you, newest first (at most 10): each with how much
   * of it was matched and the items it paid back.
   */
  paidBack: z
    .array(
      z.object({
        key: z.string(),
        payee: z.string(),
        date,
        /** How much of it paid back owed items. All of it is in Ready to Assign (D-98). */
        matched: cents,
        items: z.array(z.object({ id, label: z.string(), amount: cents })),
      }),
    )
    .default([]),
});
export type OwedView = z.infer<typeof OwedView>;
export const OwedAction = z.object({
  /** reopen: undoes Close out or Remove the mark (D-80). */
  action: z.enum(['close', 'cancel', 'snooze', 'reopen']),
  expectBy: calendarDate.optional(),
});

// ---------------------------------------------------------------- accounts

export const RegisterDay = z.object({
  label: z.string(),
  balance: cents.nullable(),
  rows: z.array(TxnListRow),
});
export type RegisterDay = z.infer<typeof RegisterDay>;

/**
 * Where the next older page of a register starts: its rows are dated before `before`, and `balance` is the running
 * balance just before that day (the bank balance walked back over every newer row). Sent back as is to
 * `GET /accounts/:id/register/older?before=&balance=`.
 */
export const RegisterCursor = z.object({ before: date, balance: cents });
export type RegisterCursor = z.infer<typeof RegisterCursor>;

export const RegisterView = z.object({
  account: AccountRow,
  days: z.array(RegisterDay),
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
  /** A page lists about REGISTER_ROWS of the newest rows, in whole days; true when there are older ones it leaves out. */
  more: z.boolean().optional(),
  /** Where the older rows start (Show older); null when this page holds the oldest. */
  older: RegisterCursor.nullable().optional(),
});
export type RegisterView = z.infer<typeof RegisterView>;

/** An older page of a register: posted days only (pending and upcoming rows are all on the first page). */
export const RegisterPage = z.object({ days: z.array(RegisterDay), older: RegisterCursor.nullable() });
export type RegisterPage = z.infer<typeof RegisterPage>;

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

// ---------------------------------------------------------------- ops

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
  /**
   * Accounts nobody opened for 24 months, marked and deleted 30 days later (docs/privacy.md 5.8), and deletions
   * under way. Counts only; added by the Worker for the ops token.
   */
  idleAccounts: z.object({ marked: z.number().int(), deleting: z.number().int() }).optional(),
});
export type HealthView = z.infer<typeof HealthView>;

export const ApiError = z.object({ error: z.string(), message: z.string() });
