// A budget's store at the end of its account's life (D-75, docs/open-signup.md 10, 12): its name and banks for the
// delete check, an admin turning the account off or on, removing its banks at Plaid, and the wipe for the user's
// own explicit delete (or an account that expired, docs/privacy.md 5.8).
import { ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import { decryptToken, type TokenKeyring } from '@ledgerline/platform';
import { BUDGET_STORE_MIGRATIONS } from './migrations.gen.js';
import { migrate } from './migrate.js';
import { ensureRecurring } from './budget-jobs.js';
import type { Enqueue } from './budget-jobs.js';

/** Set while an admin has turned the account off: no daily jobs or bank syncs until it is turned on. */
export const DISABLED_KEY = 'disabled';

export function budgetInfo(storage: DurableObjectStorage): { name: string; banks: number; sealed: boolean } {
  const b = storage.sql.exec(`SELECT name FROM budget LIMIT 1`).toArray()[0];
  const sealed = storage.sql.exec(`SELECT 1 FROM store_mark WHERE key = 'sealed'`).toArray().length > 0;
  const n = storage.sql
    // From bank_link (docs/privacy.md 5.5): a sealed budget's `connection` is empty, and a budget with live Items
    // must never look as if it had none (it could be wiped).
    .exec(`SELECT count(*) AS n FROM bank_link WHERE provider = 'plaid' AND status != 'removed'`)
    .one() as { n: number };
  // A sealed budget's name is in its devices' copies only: what the old tables still hold is not asked for.
  return { name: !sealed && typeof b?.name === 'string' ? b.name : '', banks: Number(n.n), sealed };
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

/** Plaid's answers that say the Item is gone already: nothing is left to remove there. */
const GONE = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN']);

/**
 * Removes each of the budget's bank links at Plaid with its stored token, then forgets the link here. Only the
 * Directory's delete job calls this, after it has checked that the account is being deleted and is not an admin's
 * (docs/privacy.md 5.5). A Plaid failure stops it: the job tries again, and the links already removed stay
 * removed. Refused on Plaid Trial (Production with no `OTHER_USERS_BANKS`), where only the admin, whose account
 * is never deleted, links banks: no job may remove the admin's links.
 */
export async function removeBanks(
  storage: DurableObjectStorage,
  o: {
    plaidEnv: string;
    otherUsersBanks?: string;
    keyring: () => TokenKeyring;
    provider: () => BankDataProvider;
  },
): Promise<{ removed: number; left: number }> {
  const links = storage.sql
    .exec(
      `SELECT id, connection_id, access_token_enc, key_version FROM bank_link WHERE provider = 'plaid' ORDER BY id`,
    )
    .toArray() as {
    id: string;
    connection_id: string;
    access_token_enc: string | null;
    key_version: number | null;
  }[];
  if (!links.length) return { removed: 0, left: 0 };
  if (o.plaidEnv === 'production' && o.otherUsersBanks !== 'on') throw new Error('remove_refused_trial');
  let removed = 0;
  for (const l of links) {
    if (l.access_token_enc && l.key_version !== null) {
      const token = await decryptToken(o.keyring(), l.access_token_enc, l.key_version, l.connection_id);
      try {
        await o.provider().removeItem(token);
      } catch (e) {
        if (!(e instanceof ProviderError && GONE.has(e.code))) throw e;
      }
    }
    storage.sql.exec(`DELETE FROM bank_link WHERE id = ?`, l.id);
    // The id only: never the Item or the token.
    console.log(JSON.stringify({ event: 'bank_removed', link: l.id }));
    removed++;
  }
  return { removed, left: 0 };
}

/**
 * Deletes everything in the store, for its user's own explicit delete. Refused unless the Directory holds the
 * deletion record for this budget, and while it still has linked banks (removeBanks goes first).
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
