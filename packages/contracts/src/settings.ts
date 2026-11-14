// Settings contracts: categories and groups, payees, account names, bank links, setup, and the app's own settings.
// Split from index.ts, which re-exports them.
import { z } from 'zod';
import { cents, id, month } from './scalars.js';
import { HIDDEN_CHARS, payeeName } from './names.js';

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
  name: payeeName.optional(),
});
export const MergeResult = z.object({ ok: z.literal(true), undoId: z.string() });
export type MergeResult = z.infer<typeof MergeResult>;
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
export const RenamePayee = z.object({ name: payeeName, remember: z.boolean().optional() });

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

/** A bank link's token; with `hosted`, the address of Plaid's own page for it. */
export const LinkToken = z.object({ linkToken: z.string(), hostedUrl: z.string().optional() });
/** Refresh all: how many bank links it started. */
export const RefreshAllResult = z.object({ ok: z.literal(true), started: z.number().int() });
