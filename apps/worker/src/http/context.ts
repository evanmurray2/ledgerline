import type { Context } from 'hono';
import type { Env } from '../env.js';

export interface Vars {
  userId: string;
  email: string;
  budgetId: string;
  requestId: string;
  /** Hash id of the signed-in session ('' for the ops token and local development). */
  sessionId: string;
  /** Changes when the budget's database is restored; phones holding a copy download it again (D-44). */
  syncEpoch: string;
}

export type AppEnv = { Bindings: Env; Variables: Vars };
export type Ctx = Context<AppEnv>;

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
