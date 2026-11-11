// "Nothing changed since the phone worked this out." The server doesn't work out balances (D-45): for an edit that
// depends on one (archive a category, close an account) the phone sends what it showed and the change number its
// copy held (`through`). The edit goes ahead only when no change is newer than that.
import type { Context } from 'hono';
import type { AppEnv } from './context.js';

/**
 * True when something changed after `through`, or when the phone sent no number. The newest change is the end of
 * `change_log` on the server. The phone's copy keeps no change log (its table stays empty): there the newest change
 * is the change number of the copy itself, which the engine gives like the clock. A sync that arrived after the
 * screen was drawn is what can change it. The larger of the two is right on both sides.
 */
export async function changedSince(c: Context<AppEnv>, through: number | undefined): Promise<boolean> {
  if (through === undefined) return true;
  const latest = await c.env.DB.prepare(`SELECT coalesce(max(seq), 0) AS n FROM change_log`).first<{
    n: number;
  }>();
  return Math.max(latest?.n ?? 0, c.env.THROUGH ?? 0) > through;
}
