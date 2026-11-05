// One-time job (docs/payee-names.md 11, PR 4): delete the old rules' cleaned-text aliases, which nothing reads any
// more. They are the payee_alias rows with a pattern but no `n:` prefix and no merchant id (the old rules wrote a
// merchant id or a cleaned-text pattern, never both).
//
// Queued once, without a migration, and only after the re-file job is done (its `payee.refile` audit row, written by
// its last step): by the re-file job when it finishes, and by the store at start, for a store whose re-file had
// already finished before this release. Until then the re-file job still needs them: QUEUE_REFILE queues it only where
// such an alias exists. Neither path queues it for a new budget (no old aliases) or for the phone (no jobs).
//
// No processing fence: no sync, route or job reads these rows. Each step deletes up to DROP_TEXT_ALIASES_ROWS (each
// delete is logged for the phone); a step that runs twice deletes nothing new.
import type { Db } from '@ledgerline/db/sql';

export const DROP_TEXT_ALIASES_ID = 'once:drop_text_aliases';

/** Rows deleted per step: well inside 10 ms of CPU (docs/measurements.md). */
export const DROP_TEXT_ALIASES_ROWS = 100;

const OLD = `pattern IS NOT NULL AND pattern NOT LIKE 'n:%' AND merchant_entity_id IS NULL`;

/** Queues the job once (see the top of this file). Plain SQL, so the store can run it at start. */
export const QUEUE_DROP_TEXT_ALIASES = `INSERT INTO job (id, kind, state, run_at, created_at, updated_at)
  SELECT '${DROP_TEXT_ALIASES_ID}', 'drop_text_aliases', '{}', ?1, ?1, ?1
  WHERE NOT EXISTS (SELECT 1 FROM job WHERE id = '${DROP_TEXT_ALIASES_ID}')
    AND EXISTS (SELECT 1 FROM payee_alias WHERE ${OLD})
    AND EXISTS (SELECT 1 FROM audit_log WHERE action = 'payee.refile')`;

/** One step: deletes the next rows; done when fewer than a full step were left. */
export async function dropTextAliasesStep(db: Db): Promise<{ done: boolean; deleted: number }> {
  const r = await db
    .prepare(
      `DELETE FROM payee_alias WHERE id IN (SELECT id FROM payee_alias WHERE ${OLD} LIMIT ${DROP_TEXT_ALIASES_ROWS})`,
    )
    .run();
  return { done: r.changes < DROP_TEXT_ALIASES_ROWS, deleted: r.changes };
}
