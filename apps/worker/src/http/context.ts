import type { Context } from 'hono';
import type { Env } from '../env.js';

export interface Vars {
  userId: string;
  email: string;
  budgetId: string;
  requestId: string;
  /** Hash id of the signed-in session ('' for the ops token and local development). */
  sessionId: string;
  /** Changes when the budget's database is restored; phones holding a copy download it again (D-45). */
  syncEpoch: string;
  /**
   * Whether the caller is an admin (docs/open-signup.md 5). The server always sets it; the phone's engine doesn't, so
   * screens it answers treat the user as able to link banks and the server decides.
   */
  isAdmin?: boolean;
  /** When this user's recovery code was used, while its notice shows (routes/signup.ts). */
  recoveryNoticeAt?: number | null;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
export type Ctx = Context<AppEnv>;

/**
 * Whether this caller may link a new bank (docs/open-signup.md 5): admins, and everyone once `OTHER_USERS_BANKS` is
 * `on` (only for a Plaid plan with no lifetime link limit). Plaid Trial's 10 links are for the whole Plaid account.
 */
export function canLinkBanks(c: Ctx): boolean {
  return c.get('isAdmin') !== false || c.env.OTHER_USERS_BANKS === 'on';
}

/** Structured logs with an allowlist of fields: never amounts, names, descriptions or tokens. */
export function log(
  event: string,
  fields: {
    requestId?: string;
    route?: string;
    status?: number;
    code?: string;
    ms?: number;
    count?: number;
  } = {},
): void {
  console.log(JSON.stringify({ event, ...fields }));
}
