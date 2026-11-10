// The recovery key (docs/privacy-keys.md 4.2): 32 random bytes, shown once as Crockford base32 with two check bytes,
// and proved to the server by a signature, so nothing reusable passes through the server.
import { type Bytes, bytes, concat, equal, isUlid, label, randomBytes, str } from './bytes.js';
import { sign, verify } from './curve.js';
import { sha256 } from './hash.js';

export const RECOVERY_KEY_LEN = 32;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 34 bytes (the key and 2 check bytes) are 272 bits: 55 characters of 5 bits, the last with 3 bits of padding. */
const CHARS = 55;

export function newRecoveryKey(): Bytes {
  return randomBytes(RECOVERY_KEY_LEN);
}

async function check(r: Uint8Array): Promise<Bytes> {
  return (await sha256(concat(label('ledgerline/v1/recovery/check'), r))).slice(0, 2) as Bytes;
}

/** How the recovery key is shown: 11 groups of 5 characters. */
export async function showRecoveryKey(r: Uint8Array): Promise<string> {
  if (r.length !== RECOVERY_KEY_LEN) throw new RangeError('recovery key');
  const data = concat(r, await check(r));
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out.match(/.{5}/g)!.join('-');
}

/**
 * The recovery key from what a person typed, or null when it isn't one: spaces, dashes and case don't matter, O is
 * read as 0 and I or L as 1 (Crockford), and the check bytes must match, so a slip is caught before anything is sent.
 */
export async function readRecoveryKey(typed: string): Promise<Bytes | null> {
  const s = typed.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CHARS) return null;
  const data = bytes(RECOVERY_KEY_LEN + 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      data[o++] = (acc >>> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  // The 3 bits of padding in the last character must be zero: one key has one spelling.
  if (o !== data.length || acc !== 0) return null;
  const r = data.slice(0, RECOVERY_KEY_LEN) as Bytes;
  return equal(await check(r), data.subarray(RECOVERY_KEY_LEN)) ? r : null;
}

function loginMessage(budgetId: string, challenge: Uint8Array): Bytes {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (challenge.length !== 32) throw new RangeError('challenge');
  return concat(label('ledgerline/v1/recovery/login'), str(budgetId), challenge);
}

/** The device's proof that it holds the recovery key, for the challenge the server gave. */
export async function signRecoveryLogin(
  authPriv: CryptoKey,
  budgetId: string,
  challenge: Uint8Array,
): Promise<Bytes> {
  return sign(authPriv, loginMessage(budgetId, challenge));
}

/** The server's check of that proof against the public key it stores. */
export async function verifyRecoveryLogin(
  authPub: Uint8Array,
  budgetId: string,
  challenge: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return verify(authPub, loginMessage(budgetId, challenge), signature);
}
