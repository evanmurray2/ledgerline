// "Nothing changed since the phone worked this out." The server doesn't work out balances (D-45): for an edit that
// depends on one (archive a category, close an account) the phone sends what it showed and the change number its
// copy held (`through`). The edit goes ahead only when no change is newer than that.
import type { Context } from 'hono';
import type { AppEnv } from './context.js';

/**
 * True when something changed after `through`, or when the phone sent no number. These routes run only on the
 * device (D-102): the newest change is the change number of the copy itself, which the engine gives like the clock.
 * Log entries read after the screen was drawn are what can change it.
 */
export async function changedSince(c: Context<AppEnv>, through: number | undefined): Promise<boolean> {
  if (through === undefined) return true;
  return (c.env.THROUGH ?? 0) > through;
}
