// How a session came in (D-89; docs/privacy-keys.md 6.3, "When an intent is needed"): the Directory says which way
// in a session signed in with and since when, and the store judges with its own clock whether that is a fresh way
// in, from which every key change of a locked budget waits for an intent.
import { FRESH_WAY_MS } from '@ledgerline/seal';
import { RECOVERY_USED_PREFIX } from '../routes/recovery-key.js';

/**
 * The way in of a session: its passkey and when that passkey was added, or the recovery key and when it signed
 * in (a recovery-key sign-in adds a passkey at that moment, which the session then uses).
 */
export interface WayIn {
  by: 'passkey' | 'recovery_key';
  /** Unix milliseconds: when the passkey was added, or when the recovery key signed in. */
  at: number;
}

/**
 * The way in of a session, as the Directory's tables hold it; null when they don't say (no session, or its
 * passkey is gone). A session counts as a recovery-key sign-in when its passkey was added by the recovery key's
 * last sign-in: both are written with the same time in one batch (routes/recovery-key.ts recoveryKeyStmts).
 */
export function wayInOf(sql: SqlStorage, sessionId: string | null): WayIn | null {
  if (!sessionId) return null;
  const r = sql
    .exec(
      `SELECT p.created_at AS added, (SELECT value FROM app_state WHERE key = ?2 || s.user_id) AS recovered
       FROM auth_session s JOIN passkey p ON p.id = s.passkey_id WHERE s.id = ?1`,
      sessionId,
      RECOVERY_USED_PREFIX,
    )
    .toArray()[0];
  if (!r) return null;
  const added = Number(r.added);
  if (!Number.isFinite(added)) return null;
  return r.recovered != null && Number(r.recovered) === added
    ? { by: 'recovery_key', at: added }
    : { by: 'passkey', at: added };
}

/**
 * Whether a session came in by a fresh way (D-89): with the recovery key, for the whole of that session, or with a
 * passkey added less than 7 days ago. A session the Directory said nothing about counts as fresh.
 */
export function isFreshWay(way: WayIn | null | undefined, now: number): boolean {
  if (!way) return true;
  if (way.by === 'recovery_key') return true;
  return now - way.at < FRESH_WAY_MS;
}
