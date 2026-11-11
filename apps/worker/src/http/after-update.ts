// An edit never lands in the middle of a bank update (D-86 A4, docs/privacy.md 5.4). A bank update that has been
// fetched is filed whole, in its turn (sync/turn.ts); an edit that arrives meanwhile waits for it, so the budget is
// always "the updates so far, then the edit", never an edit between two steps of one update. The phone will file
// updates itself and can't interleave, so the server must not either, or the two would not match.
//
// The wait is short: filing an update takes seconds. It has a limit, so that a slow or stuck update never keeps a
// person from their budget: past it the edit goes ahead, and a log line says so.
import type { Db } from '@ledgerline/db/sql';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.js';
import { updateInFlight } from '../sync/turn.js';

/** The longest an edit waits for bank updates to be filed. */
export const EDIT_WAIT_MS = 10_000;
const POLL_MS = 250;

/**
 * The requests that change what the budget counts: transactions, assignments, targets, categories, payees, matches,
 * transfers, owed items, accounts and setup. Not held: sign-in and devices, bank connections (they start updates),
 * preferences, usage and notes.
 */
export const HELD =
  /^\/api\/(transactions|budget|categories|match|same-purchase|transfers|owed|accounts|alerts|setup|settings\/(categories|groups|payees))(\/|$)/;

export interface WaitOptions {
  maxMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Waits until no bank update is waiting to be filed or being filed. False when the limit ran out first. */
export async function waitForUpdates(db: Db, o: WaitOptions = {}): Promise<boolean> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (o.maxMs ?? EDIT_WAIT_MS);
  while (await updateInFlight(db, null, now())) {
    if (now() >= until) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/** Mounted by the budget's store in front of its routes (not by the phone's engine, which files nothing). */
export const afterBankUpdate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || !HELD.test(new URL(c.req.url).pathname)) return next();
  const max = Number(c.env.EDIT_WAIT_MS ?? EDIT_WAIT_MS);
  if (!(await waitForUpdates(c.env.DB, { maxMs: Number.isFinite(max) ? max : EDIT_WAIT_MS })))
    console.log(JSON.stringify({ event: 'edit_during_update', route: new URL(c.req.url).pathname }));
  return next();
};
