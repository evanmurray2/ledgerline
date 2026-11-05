// One-time job, part 1 of docs/payee-names.md 8.1: fill bank_txn.plaid_name on rows imported before the column
// existed. Migration 0007 queues it once (job id FILL_PLAID_NAME_ID) where bank history exists.
//
// Each row takes Plaid's `name` from the page its last bank_event came from (raw_ref = raw page key + '#' + list/index,
// steps.ts planApply). One raw page is parsed per step, newest row first; the state is the last event id done, so a
// restarted step simply runs again. Rows removed by the bank are left alone: their last event is the removal, which
// carries no name, and a row that comes back gets its name from the sync.
//
// No processing fence is needed: processing doesn't read plaid_name, and every write is
// `... WHERE plaid_name IS NULL AND last_apply_seq = <the event read>`, so a row the sync has written since (with the
// newer event's name, or NULL when Plaid sent none) is never overwritten. Running a step twice writes nothing new.
import type { Db, Stmt } from '@ledgerline/db/sql';

export const FILL_PLAID_NAME_ID = 'once:fill_plaid_name';

/** Rows written per step at most, so a step stays well inside 10 ms of CPU whatever the page size was. */
export const FILL_PLAID_NAME_ROWS = 100;

export interface FillPlaidNameState {
  /** Rows whose last event id is below this are still to do. */
  before?: number;
}

export type FillPlaidNameStep =
  { done: true; filled: 0 } | { done: false; state: FillPlaidNameState; filled: number };

interface PageEvent {
  id: number;
  provider_txn_id: string;
  raw_ref: string;
}

/** Plaid's name at `added/12` or `modified/3` in a parsed /transactions/sync body, if it is there. */
function nameAt(page: Record<string, unknown>, path: string): string | null {
  const [list, index] = path.split('/');
  const rows = page[list ?? ''];
  if (!Array.isArray(rows)) return null;
  const t = rows[Number(index)] as { name?: unknown } | undefined;
  return typeof t?.name === 'string' ? t.name : null;
}

export async function fillPlaidNameStep(
  db: Db,
  budgetId: string,
  state: FillPlaidNameState,
): Promise<FillPlaidNameStep> {
  const before = state.before ?? Number.MAX_SAFE_INTEGER;
  // The newest row still without a name: its last event names the page to read.
  const next = await db
    .prepare(
      `SELECT e.id, e.sync_run_id, e.page, e.raw_ref FROM bank_txn b JOIN bank_event e ON e.id = b.last_apply_seq
       WHERE b.budget_id = ?1 AND b.plaid_name IS NULL AND b.removed_at IS NULL AND b.last_apply_seq < ?2
       ORDER BY b.last_apply_seq DESC LIMIT 1`,
    )
    .bind(budgetId, before)
    .first<{ id: number; sync_run_id: string; page: number; raw_ref: string }>();
  if (!next) return { done: true, filled: 0 };
  const key = next.raw_ref.slice(0, next.raw_ref.lastIndexOf('#'));
  const [raw, evs] = await db.batch([
    db.prepare(`SELECT body FROM raw_page WHERE key = ?1`).bind(key),
    // The page's other rows, newest first: one parse fills them all.
    db
      .prepare(
        `SELECT id, provider_txn_id, raw_ref FROM bank_event
         WHERE sync_run_id = ?1 AND page = ?2 AND kind != 'removed' AND id <= ?3 ORDER BY id DESC`,
      )
      .bind(next.sync_run_id, next.page, next.id),
  ]);
  const body = (raw?.results[0] as { body: string } | undefined)?.body;
  const mine = ((evs?.results ?? []) as PageEvent[])
    .filter((e) => e.raw_ref.startsWith(`${key}#`))
    .slice(0, FILL_PLAID_NAME_ROWS);
  // Done down to the last event read; a page cut short by the row limit is read again for the rest.
  const done = mine.length === FILL_PLAID_NAME_ROWS ? mine[mine.length - 1]!.id : next.id;
  if (!body) return { done: false, state: { before: done }, filled: 0 };
  let page: Record<string, unknown>;
  try {
    page = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { done: false, state: { before: done }, filled: 0 };
  }
  const stmts: Stmt[] = [];
  for (const e of mine) {
    const name = nameAt(page, e.raw_ref.slice(key.length + 1));
    if (name === null) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE bank_txn SET plaid_name = ?3
           WHERE budget_id = ?1 AND provider_txn_id = ?2 AND plaid_name IS NULL AND last_apply_seq = ?4`,
        )
        .bind(budgetId, e.provider_txn_id, name, e.id),
    );
  }
  const res = stmts.length ? await db.batch(stmts) : [];
  const filled = res.reduce((n, r) => n + r.changes, 0);
  return { done: false, state: { before: done }, filled };
}
