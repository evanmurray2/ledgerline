// Moving a budget that exists to its sealed log, on the device (docs/privacy.md section 8 step 6): the one time a
// device makes a key for a budget that already exists. Before the server is asked for anything, the device shows
// that both ways in open the new key: the passkey, with a fresh prompt, and the recovery key, typed back by the
// person from what they wrote down. Only then are the keys and the first entry handed on to the engine
// (`EngineHost.cutover`).
import { type BudgetKeys, type Bytes, encodeEntry, type Entry, equal, zeroize } from '@ledgerline/seal';
import { createBudget, openWithPasskey, openWithRecoveryKey, type PasskeySecret, WayInError } from './budget';

/** A budget's new keys and first entry, made and not yet proved. */
export interface PreparedMove {
  budgetId: string;
  deviceId: string;
  genesis: Entry;
  /** The recovery key as the person writes it down. Shown once. */
  recoveryText: string;
  /** Held until the move is proved or given up; `dropMove` zeroes it. */
  secret: { bk: Bytes; keys: BudgetKeys; recoveryKey: Bytes };
}

/** Makes the keys, the recovery key and the first entry, from the passkey the person just used. */
export async function prepareMove(o: {
  budgetId: string;
  deviceId: string;
  passkey: PasskeySecret;
  now: number;
}): Promise<PreparedMove> {
  const made = await createBudget(o);
  return {
    budgetId: o.budgetId,
    deviceId: o.deviceId,
    genesis: made.genesis,
    recoveryText: made.recoveryText,
    secret: { bk: made.budget.bk, keys: made.budget.keys, recoveryKey: made.recoveryKey },
  };
}

/** Forgets a prepared move: the key bytes are zeroed. */
export function dropMove(p: PreparedMove): void {
  zeroize(p.secret.bk, p.secret.recoveryKey);
}

/**
 * Proves both ways in before the budget is moved: the recovery key as the person typed it back, and the passkey
 * asked once more. Each must open the very key the first entry holds. Gives what the engine needs for the move;
 * the key bytes are zeroed here, whatever happens.
 */
export async function proveMove(
  p: PreparedMove,
  typedRecoveryKey: string,
  passkeyAgain: PasskeySecret,
): Promise<{ keys: BudgetKeys; genesis: Uint8Array; deviceId: string }> {
  try {
    const byRecovery = await openWithRecoveryKey([p.genesis], p.budgetId, typedRecoveryKey).catch(
      (x: unknown) => {
        if (x instanceof WayInError) throw x;
        throw new WayInError('That is not the recovery key shown. Check it and try again.');
      },
    );
    const sameKey = equal(byRecovery.budget.bk, p.secret.bk);
    zeroize(byRecovery.budget.bk);
    if (!sameKey) throw new WayInError('That is not the recovery key shown. Check it and try again.');
    const byPasskey = await openWithPasskey([p.genesis], p.budgetId, passkeyAgain).catch(() => {
      throw new WayInError('Your passkey did not open the budget’s new key. Nothing was changed.');
    });
    const samePasskey = equal(byPasskey.budget.bk, p.secret.bk);
    zeroize(byPasskey.budget.bk);
    if (!samePasskey)
      throw new WayInError('Your passkey did not open the budget’s new key. Nothing was changed.');
    return { keys: p.secret.keys, genesis: encodeEntry(p.genesis), deviceId: p.deviceId };
  } finally {
    zeroize(p.secret.bk);
  }
}
