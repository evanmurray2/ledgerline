// Requests signed with the budget's key (docs/privacy-keys.md section 11). Some requests must come from a holder of
// the budget key and not only from a session: a stolen session then can't store a key, ask for a link token, remove a
// bank or delete the account.
import { type Bytes, concat, isUlid, label, randomBytes, str, u32, utf8 } from './bytes.js';
import type { BudgetKeys } from './budget-key.js';
import { sign, verify } from './curve.js';
import { sha256 } from './hash.js';

/** The fixed names of the requests. A name is never reused for another request. */
export const ACTION = {
  storeSignKey: 'store-sign-key',
  storeInboxKey: 'store-inbox-key',
  linkToken: 'link-token',
  removeBank: 'remove-bank',
  deleteAccount: 'delete-account',
} as const;
export type Action = (typeof ACTION)[keyof typeof ACTION];
const ACTIONS: readonly string[] = Object.values(ACTION);

export const CHALLENGE_LEN = 32;
/** A challenge is good for this long, and for one request. The server keeps that rule. */
export const CHALLENGE_MS = 5 * 60 * 1000;

/** The server's side: a challenge for one request. */
export const newChallenge = (): Bytes => randomBytes(CHALLENGE_LEN);

async function requestMessage(
  budgetId: string,
  version: number,
  action: string,
  challenge: Uint8Array,
  payload: Uint8Array,
): Promise<Bytes> {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (!Number.isInteger(version) || version < 1 || version > 0xffffffff) throw new RangeError('key version');
  if (!ACTIONS.includes(action)) throw new RangeError('action');
  if (challenge.length !== CHALLENGE_LEN) throw new RangeError('challenge');
  return concat(
    label('ledgerline/v1/request'),
    str(budgetId),
    u32(version),
    str(utf8(action)),
    challenge,
    await sha256(payload),
  );
}

/** A device's side: signs one request. `payload` is the request's body, exactly as sent. */
export async function signRequest(
  keys: BudgetKeys,
  budgetId: string,
  action: Action,
  challenge: Uint8Array,
  payload: Uint8Array,
): Promise<Bytes> {
  return sign(keys.sign.privateKey, await requestMessage(budgetId, keys.version, action, challenge, payload));
}

/**
 * The server's side: whether a request was signed by the budget's signing key. `signPub` and `version` are the ones
 * in force in the log, read by the server, never taken from the request. The server has already checked that the
 * challenge is one it gave for this session, unused and not older than 5 minutes, and marks it used whatever this
 * answers. Values that could never have been signed are "no", never a crash.
 */
export async function verifyRequest(
  signPub: Uint8Array,
  version: number,
  budgetId: string,
  action: string,
  challenge: Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signPub.length !== 32 || signature.length !== 64) return false;
  let message: Bytes;
  try {
    message = await requestMessage(budgetId, version, action, challenge, payload);
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
  return verify(signPub, message, signature);
}
