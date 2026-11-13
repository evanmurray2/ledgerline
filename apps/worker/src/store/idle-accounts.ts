// Accounts nobody opens for 24 months are deleted (D-85; docs/privacy.md 5.8), with their banks at Plaid. The
// Directory's daily job works in two stages: it marks an account idle at 24 months (`expire:<budget>`; `idle:`
// already means the 30-day rest of a budget with no banks), and 30 days later starts the same deletion that Delete
// account starts (routes/people.ts), so there is one way to delete. A request by any member in between clears the
// mark. It never touches an admin's account or one an admin turned off, and starts at most a few deletions a day.
// A deletion that can't finish (Plaid is down) is queued again every day.
import { deletingKey } from '../routes/people.js';

/** How long nobody may open a budget before it is marked: 24 months (730 days). */
export const EXPIRE_MS = 730 * 86_400_000;
/** How long a mark stands before the deletion starts. */
export const EXPIRE_GRACE_MS = 30 * 86_400_000;
/** Deletions started per daily run, at most: a bug shows before it deletes much. */
export const EXPIRE_PER_RUN = 3;

export const expireKey = (budgetId: string) => `expire:${budgetId}`;

export interface ExpireOutcome {
  marked: number;
  cleared: number;
  /** The deletions to start now: each budget with its members. */
  start: { budgetId: string; userIds: string[] }[];
  /** Deletions already started whose job must run again (it stopped, or never ran). */
  again: { budgetId: string; userId: string }[];
}

/** One daily look at every budget: what to mark, clear and delete. Writes the marks; the caller starts the rest. */
export function expireIdle(sql: SqlStorage, now: number): ExpireOutcome {
  const rows = sql
    .exec(
      `SELECT m.budget_id AS id,
         max(max(u.created_at, coalesce(u.last_seen_at, 0))) AS last,
         max(u.is_admin) AS admin,
         sum(u.status != 'active') AS other,
         group_concat(u.id) AS users,
         (SELECT value FROM app_state WHERE key = 'expire:' || m.budget_id) AS marked
       FROM budget_member m JOIN user u ON u.id = m.user_id
       WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE key = 'deleting:' || m.budget_id)
       GROUP BY m.budget_id ORDER BY m.budget_id`,
    )
    .toArray();
  const out: ExpireOutcome = { marked: 0, cleared: 0, start: [], again: [] };
  for (const r of rows) {
    const id = String(r.id);
    const idle = now - Number(r.last) > EXPIRE_MS && Number(r.admin) === 0 && Number(r.other) === 0;
    const marked = r.marked === null ? null : Number(r.marked);
    if (!idle) {
      if (marked !== null) {
        sql.exec(`DELETE FROM app_state WHERE key = ?`, expireKey(id));
        out.cleared++;
      }
      continue;
    }
    if (marked === null) {
      sql.exec(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)`,
        expireKey(id),
        String(now),
        now,
      );
      out.marked++;
      continue;
    }
    if (now - marked > EXPIRE_GRACE_MS && out.start.length < EXPIRE_PER_RUN)
      out.start.push({ budgetId: id, userIds: String(r.users).split(',').sort() });
  }
  // Deletions under way: the job is queued again (a pending one is left as it is; one that stopped starts over).
  for (const d of sql.exec(`SELECT key, value FROM app_state WHERE key LIKE 'deleting:%'`).toArray())
    out.again.push({ budgetId: String(d.key).slice('deleting:'.length), userId: String(d.value) });
  return out;
}

/**
 * The first step of deleting an account, shared by Delete account and the idle deletion: its members are marked
 * deleting, their sessions and devices go, the budget's routes and members go, and the budget is marked deleting,
 * so its store may wipe itself and nothing brings it back. The delete job does the rest.
 */
export function startDeletionSql(budgetId: string, userIds: string[], now: number): [string, unknown[]][] {
  const each = (q: string): [string, unknown[]][] => userIds.map((u) => [q, [u]]);
  return [
    ...userIds.map((u): [string, unknown[]] => [
      `UPDATE user SET status = 'deleting', updated_at = ? WHERE id = ?`,
      [now, u],
    ]),
    ...each(`DELETE FROM auth_session WHERE user_id = ?`),
    ...each(`DELETE FROM device WHERE user_id = ?`),
    ...each(`DELETE FROM device_link WHERE user_id = ?`),
    ...each(`DELETE FROM device_add WHERE user_id = ?`),
    [`DELETE FROM connection_route WHERE budget_id = ?`, [budgetId]],
    [`DELETE FROM budget_member WHERE budget_id = ?`, [budgetId]],
    [
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [deletingKey(budgetId), userIds[0] ?? '', now],
    ],
    [`DELETE FROM app_state WHERE key = ?`, [expireKey(budgetId)]],
  ];
}
