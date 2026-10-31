// Post-apply work driven by the watermark (Sync spec F3). Filled in by the bank-layer phase; the go/no-go
// harness only needs the watermark loop and its fence.
import type { Env } from '../env.js';
import { conditionFence, isFenceAbort, releaseSuccess } from './lease.js';
import type { StepContext } from './steps.js';

export const PROCESS_BATCH = 200;
const MAX_WATERMARK_RETRIES = 3;

export interface ProcessResult {
  caughtUp: boolean;
  processed: number;
}

export async function processPending(env: Env, budgetId: string): Promise<ProcessResult> {
  for (let attempt = 0; attempt < MAX_WATERMARK_RETRIES; attempt++) {
    const b = await env.DB.prepare(`SELECT processed_through FROM budget WHERE id = ?1`)
      .bind(budgetId)
      .first<{ processed_through: number }>();
    if (!b) return { caughtUp: true, processed: 0 };
    const expected = b.processed_through;
    const rows = await env.DB.prepare(
      `SELECT id FROM bank_event WHERE id > ?1 AND budget_id = ?2 ORDER BY id LIMIT ?3`,
    )
      .bind(expected, budgetId, PROCESS_BATCH)
      .all<{ id: number }>();
    const evs = rows.results;
    if (evs.length === 0) return { caughtUp: true, processed: 0 };
    const through = evs[evs.length - 1]!.id;
    try {
      await env.DB.batch([
        conditionFence(env.DB, `SELECT processed_through = ?1 FROM budget WHERE id = ?2`, expected, budgetId),
        env.DB.prepare(`UPDATE budget SET processed_through = ?1, updated_at = ?3 WHERE id = ?2`).bind(
          through,
          budgetId,
          Date.now(),
        ),
      ]);
      return { caughtUp: evs.length < PROCESS_BATCH, processed: evs.length };
    } catch (e) {
      if (!isFenceAbort(e)) throw e;
      // Another processor moved the watermark first; re-read and continue.
    }
  }
  return { caughtUp: false, processed: 0 };
}

export async function finalizeConnection(env: Env, c: StepContext, runId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sync_run SET phase = 'done', finished_at = ?2, updated_at = ?2 WHERE id = ?1`,
    ).bind(runId, now),
    env.DB.prepare(`DELETE FROM sync_page WHERE sync_run_id = ?1`).bind(runId),
    env.DB.prepare(
      `UPDATE connection SET last_synced_at = ?2, last_attempt_at = ?2, error_code = NULL, status = 'ok' WHERE id = ?1`,
    ).bind(c.connectionId, now),
  ]);
}

export { releaseSuccess };
