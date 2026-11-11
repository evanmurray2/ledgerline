// One bank update at a time (D-86 A2, docs/privacy.md 14.2). Fetching runs side by side for every bank, but the
// updates are applied and filed one at a time, in the order their fetches finished (sync_run.fetch_seq), for the
// whole budget. So what a row meets when it is filed does not depend on how the steps of two banks' jobs happened to
// alternate.
import type { Db } from '@ledgerline/db/sql';

/** How long a run waits before it asks again whether it is its turn. */
export const TURN_WAIT_MS = 3000;

/**
 * Whether this run may apply and file now: it is the budget's oldest fetched update that is neither done nor failed.
 *
 * - A run with no place (it was started before fetch_seq existed, or by a test that stages pages by hand) does not
 *   wait, and nothing waits for it.
 * - An update whose job is gone is skipped: its bank's lease is no longer its own, or has run out. Its bank's next
 *   sync adopts or abandons it (steps.ts beginRun); if adopted it keeps its place and goes first then.
 */
export async function isMyTurn(db: Db, budgetId: string, runId: string, now: number): Promise<boolean> {
  const head = await db
    .prepare(
      `SELECT r.id, (SELECT fetch_seq FROM sync_run WHERE id = ?2) AS mine
       FROM sync_run r JOIN connection c ON c.id = r.connection_id
       WHERE r.budget_id = ?1 AND r.fetch_seq > 0 AND r.phase NOT IN ('done', 'failed')
         AND c.sync_lock = r.id AND c.lock_expires > ?3 AND c.removed_at IS NULL
       ORDER BY r.fetch_seq LIMIT 1`,
    )
    .bind(budgetId, runId, now)
    .first<{ id: string; mine: number | null }>();
  return !head || head.id === runId || head.mine === null || head.mine <= 0;
}

/**
 * Whether a bank update is waiting to be filed, or is being filed: it is fetched, neither done nor failed, and its job
 * is alive. While one is, only that update's own job files rows, so each update is filed whole and in its turn; the
 * daily catch-up leaves it alone (it is for rows whose job is gone).
 */
export async function updateInFlight(db: Db, budgetId: string, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 AS x FROM sync_run r JOIN connection c ON c.id = r.connection_id
       WHERE r.budget_id = ?1 AND r.fetch_seq > 0 AND r.phase NOT IN ('done', 'failed')
         AND c.sync_lock = r.id AND c.lock_expires > ?2 AND c.removed_at IS NULL LIMIT 1`,
    )
    .bind(budgetId, now)
    .first<{ x: number }>();
  return r !== null;
}
