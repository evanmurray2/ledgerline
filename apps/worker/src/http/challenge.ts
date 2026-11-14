// WebAuthn challenges without a database write (docs/multi-user.md 7.2). Starting a sign-in used to write an
// auth_challenge row for anyone who asked, so anyone could spend the account's daily writes. Now the challenge,
// its purpose and what allowed it travel in a 5-minute cookie signed with HMAC-SHA-256 under a key derived from
// TOKEN_KEYS (HKDF, label 'ledgerline-challenge', used for nothing else). Single use comes from the session row:
// a successful finish records the challenge id under a unique index (routes/auth.ts).
import { fromBase64url, parseKeyring, toBase64url } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { CHALLENGE_MS, randomToken } from './auth.js';

export interface Challenge {
  id: string;
  challenge: string;
  /**
   * `recovery`: a recovery key's sign-in, before its passkey ceremony (routes/recovery-key.ts). `request`: a
   * request signed with the budget's key (http/signed-request.ts); its grant names the request and the session.
   */
  purpose: 'register' | 'login' | 'recovery' | 'request';
  grant_kind: string | null;
  grant_ref: string | null;
  exp: number;
}

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function key(env: Env): Promise<CryptoKey> {
  const ring = parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT);
  const secret = ring.keys[ring.current];
  if (!secret) throw new Error('TOKEN_KEYS is not configured');
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('ledgerline-challenge') },
        ikm,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
    })();
    keys.set(secret, k);
  }
  return k;
}

/** The cookie value for a new challenge. */
export async function sealChallenge(
  env: Env,
  now: number,
  challenge: string,
  purpose: Challenge['purpose'],
  grant: { kind: string; ref: string | null } | null,
): Promise<string> {
  const c: Challenge = {
    id: randomToken(16),
    challenge,
    purpose,
    grant_kind: grant?.kind ?? null,
    grant_ref: grant?.ref ?? null,
    exp: now + CHALLENGE_MS,
  };
  const body = toBase64url(enc.encode(JSON.stringify(c)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), enc.encode(body)));
  return `${body}.${toBase64url(sig)}`;
}

/** The challenge in a cookie value, if its signature is ours, it's for this purpose and it hasn't expired. */
export async function openChallenge(
  env: Env,
  value: string | null,
  purpose: Challenge['purpose'],
  now: number,
): Promise<Challenge | null> {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(env), fromBase64url(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  const c = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Challenge;
  if (c.purpose !== purpose || c.exp <= now) return null;
  return c;
}
