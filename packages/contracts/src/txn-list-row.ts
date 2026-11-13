import { z } from 'zod';
import { cents, date, id } from './scalars.js';

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
