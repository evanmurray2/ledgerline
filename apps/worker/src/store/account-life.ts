// A budget's store at the end of its account's life (D-75, docs/open-signup.md 10, 12): its name and banks for the
// delete check, an admin turning the account off or on, and the wipe for the user's own explicit delete.
import { BUDGET_STORE_MIGRATIONS } from './migrations.gen.js';
import { migrate } from './migrate.js';
import { ensureRecurring } from './budget-jobs.js';
import type { Enqueue } from './budget-jobs.js';

/** Set while an admin has turned the account off: no daily jobs or bank syncs until it is turned on. */
export const DISABLED_KEY = 'disabled';

export function budgetInfo(storage: DurableObjectStorage): { name: string; banks: number } {
  const b = storage.sql.exec(`SELECT name FROM budget LIMIT 1`).toArray()[0];
  const n = storage.sql
    // From bank_link (docs/privacy.md 5.5): a sealed budget's `connection` is empty, and a budget with live Items
    // must never look as if it had none (it could be wiped).
    .exec(`SELECT count(*) AS n FROM bank_link WHERE provider = 'plaid'`)
    .one() as { n: number };
  return { name: typeof b?.name === 'string' ? b.name : '', banks: Number(n.n) };
}

/**
 * Off: the daily jobs and bank syncs stop (the account's sessions are already gone, so nothing else reaches the
 * store). On: the daily jobs come back.
 */
export async function setDisabled(
  storage: DurableObjectStorage,
  disabled: boolean,
  enqueue: Enqueue,
  timeZone: () => string,
): Promise<void> {
  if (disabled) {
    storage.sql.exec(`DELETE FROM job WHERE recurring = 1 OR kind = 'sync'`);
    await storage.put(DISABLED_KEY, true);
    return;
  }
  await storage.delete(DISABLED_KEY);
  if (storage.sql.exec(`SELECT 1 FROM budget`).toArray().length)
    await ensureRecurring(enqueue, Date.now(), timeZone());
}

/**
 * Deletes everything in the store, for its user's own explicit delete. Refused unless the Directory holds the
 * deletion record for this budget, and while it still has linked banks (removing them at Plaid isn't built yet).
 * Leaves an empty database with the schema and no budget row, which nothing can make again (ensureBudget).
 */
export async function wipeStore(
  storage: DurableObjectStorage,
  deleting: () => Promise<boolean>,
): Promise<{ ok: boolean; why?: 'refused' | 'banks' }> {
  if (!(await deleting())) return { ok: false, why: 'refused' };
  const has = storage.sql.exec(`SELECT 1 FROM budget`).toArray().length > 0;
  if (has && budgetInfo(storage).banks > 0) return { ok: false, why: 'banks' };
  await storage.deleteAlarm();
  await storage.deleteAll();
  migrate(storage, BUDGET_STORE_MIGRATIONS, Date.now());
  return { ok: true };
}
