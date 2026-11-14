// Small answers many routes share. Moved from apps/web/src/api/endpoints.ts; index.ts re-exports them.
import { z } from 'zod';
import { MutationResult } from './budget.js';

/** A change the server took, with nothing more to say. */
export const OkResult = z.object({ ok: z.literal(true) });
/** A change that made (or kept) a row: its id. */
export const OkIdResult = z.object({ ok: z.literal(true), id: z.string() });
/** `otherKey`: the row a transfer was paired with, for Undo (pick it again); absent when Undo can't pair them again. */
export const UnpairResult = MutationResult.extend({ otherKey: z.string().optional() });
/** Tab badge counts, cheaply: shown on every screen. */
export const Badges = z.object({
  activity: z.number().int(),
  accounts: z.number().int(),
  rta: z.number().int(),
  rtaUpdating: z.boolean(),
});
export type Badges = z.infer<typeof Badges>;
