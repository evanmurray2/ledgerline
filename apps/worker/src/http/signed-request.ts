// Requests signed with the budget's key (docs/privacy-keys.md 11; docs/privacy.md 5.2, 5.5). For a sealed budget,
// the serious requests need more than a session with a fresh passkey check: a signature by the budget's signing
// key, which only a device that opened the budget holds. A stolen session alone can't link or remove a bank,
// delete the account, empty the readable copy or set the recovery key's sign-in half.
//
// The steps: the device asks the Directory for a challenge for one named request
// (POST /api/settings/security/request-challenge). The challenge travels in a token signed with HMAC under a key
// from TOKEN_KEYS (http/challenge.ts), bound to the session and the request's name, good for 5 minutes. The
// device signs (budget id, key version, name, challenge, hash of the body) in its engine and sends the token and
// the signature in two headers with the request. The Directory marks the token used (used_challenge) before
// anything checks the signature, so a token is good for one try, right or wrong. The server takes the signing
// key and its version from the log's public state, never from the request, and hashes the body it received.
import { SIGNED_CHALLENGE_HEADER, SIGNED_SIGNATURE_HEADER } from '@ledgerline/contracts';
import type { Db } from '@ledgerline/db/sql';
import { ACTION, type Action, fromHex, toHex, verifyRequest } from '@ledgerline/seal';
import type { Env } from '../env.js';
import { stateFromJson } from '../seal/log-store.js';
import { openChallenge, sealChallenge } from './challenge.js';

/** What the Directory hands a budget's store: a challenge it gave this session, now used, and the signature. */
export interface SignedPart {
  action: Action;
  challenge: string;
  signature: string;
}

/** The answer when a sealed budget's request has no good signature. */
export const UNSIGNED = {
  error: 'unsigned',
  message: 'Open your budget on this device, then try again.',
} as const;

const HEX64 = /^[0-9a-f]{128}$/;

/** The request a path stands for, when it is one that a sealed budget wants signed. The server decides, never the token. */
export function signedActionOf(method: string, path: string): Action | null {
  if (method !== 'POST') return null;
  if (path === '/api/settings/connections/link-token') return ACTION.linkToken;
  if (path === '/api/settings/connections/link-finish') return ACTION.linkFinish;
  if (/^\/api\/settings\/connections\/[^/]+\/remove$/.test(path)) return ACTION.removeBank;
  if (path === '/api/settings/security/delete-account') return ACTION.deleteAccount;
  if (path === '/api/settings/security/recovery-key') return ACTION.setRecoverySignIn;
  return null;
}

/** The requests a device may ask a challenge for. The keys for the log are stored by other means (7.2). */
const ASKABLE: readonly string[] = [
  ACTION.linkToken,
  ACTION.linkFinish,
  ACTION.removeBank,
  ACTION.deleteAccount,
  ACTION.setRecoverySignIn,
];
export const isAskable = (a: unknown): a is Action => typeof a === 'string' && ASKABLE.includes(a);

/** A new challenge for one request of this session: the 32 bytes (hex) and the token that carries them. Writes nothing. */
export async function issueChallenge(
  env: Env,
  now: number,
  sessionId: string,
  action: Action,
): Promise<{ challenge: string; token: string }> {
  const challenge = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const token = await sealChallenge(env, now, challenge, 'request', { kind: action, ref: sessionId });
  return { challenge, token };
}

/**
 * The challenge of a token, if the Directory gave it to this session for this request, it hasn't run out, and it
 * wasn't used: it is marked used now, whatever the signature turns out to be. Null otherwise.
 */
export async function takeChallenge(
  env: Env,
  db: Db,
  token: string | null | undefined,
  sessionId: string,
  action: Action,
  now: number,
): Promise<string | null> {
  if (!token || token.length > 2000) return null;
  const ch = await openChallenge(env, token, 'request', now);
  if (!ch || ch.grant_kind !== action || ch.grant_ref !== sessionId) return null;
  try {
    await db.prepare(`INSERT INTO used_challenge (id, used_at) VALUES (?1, ?2)`).bind(ch.id, now).run();
  } catch {
    return null; // used already
  }
  return ch.challenge;
}

/** The two headers of a signed request, read as they came; null when either is missing or malformed. */
export function signedHeaders(h: Headers): { token: string; signature: string } | null {
  const token = h.get(SIGNED_CHALLENGE_HEADER);
  const signature = h.get(SIGNED_SIGNATURE_HEADER);
  if (!token || !signature || !HEX64.test(signature)) return null;
  return { token, signature };
}

/** The signing key in force in a sealed budget's log: its version and public half (hex). Null with no log. */
export function signKeyOf(stateJson: string | null | undefined): { version: number; pub: string } | null {
  if (!stateJson) return null;
  const p = (
    stateFromJson(stateJson) as unknown as { public?: { keyVersion?: number; signPub?: Uint8Array } }
  ).public;
  if (!p || typeof p.keyVersion !== 'number' || !(p.signPub instanceof Uint8Array)) return null;
  return { version: p.keyVersion, pub: toHex(p.signPub) };
}

/** The signing key in force, read from the store's own log state (seal/log-store.ts). */
export async function logSignKey(db: Db): Promise<{ version: number; pub: string } | null> {
  const r = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
  return signKeyOf(r?.state);
}

/**
 * Whether `signed` is a good signature of request `action` over `payload` (the body's bytes as received) by the
 * signing key in force. Every way it could be wrong is "no".
 */
export async function signatureGood(o: {
  signed: SignedPart | null | undefined;
  action: Action;
  budgetId: string;
  payload: Uint8Array;
  key: { version: number; pub: string } | null;
}): Promise<boolean> {
  const { signed, key } = o;
  if (!signed || !key || signed.action !== o.action || !HEX64.test(signed.signature)) return false;
  try {
    return await verifyRequest(
      fromHex(key.pub),
      key.version,
      o.budgetId,
      o.action,
      fromHex(signed.challenge),
      o.payload,
      fromHex(signed.signature),
    );
  } catch {
    return false;
  }
}

/**
 * For a route the Directory serves itself (Delete account, the recovery key's sign-in half): null when the
 * request may go on, else the refusal. A budget that is not sealed needs no signature. `key` is the store's
 * answer (BUDGET_INFO). Reads the body's bytes first; the route can read the body again after.
 */
export async function directorySigned(
  c: {
    env: Env;
    req: { raw: Request; arrayBuffer(): Promise<ArrayBuffer> };
    get(k: 'sessionId' | 'budgetId'): string;
  },
  action: Action,
  now: number,
  store: { sealed?: boolean; signKey?: { version: number; pub: string } | null } | null,
): Promise<Response | null> {
  if (!store?.sealed) return null;
  const payload = new Uint8Array(await c.req.arrayBuffer());
  const h = signedHeaders(c.req.raw.headers);
  const challenge = h
    ? await takeChallenge(c.env, c.env.DB, h.token, c.get('sessionId') ?? '', action, now)
    : null;
  const good =
    challenge !== null &&
    (await signatureGood({
      signed: { action, challenge, signature: h!.signature },
      action,
      budgetId: c.get('budgetId'),
      payload,
      key: store.signKey ?? null,
    }));
  return good ? null : Response.json(UNSIGNED, { status: 403 });
}

/**
 * For a sealed budget's route in its store: null when `payload` (the body's bytes as received) carries a good
 * signature of `action`, with the challenge the Directory took for this request; else the refusal.
 */
export async function storeSigned(
  c: { env: Env; get(k: 'signed'): SignedPart | null | undefined; get(k: 'budgetId'): string },
  action: Action,
  payload: Uint8Array,
): Promise<Response | null> {
  const good = await signatureGood({
    signed: c.get('signed'),
    action,
    budgetId: c.get('budgetId'),
    payload,
    key: await logSignKey(c.env.DB),
  });
  return good ? null : Response.json(UNSIGNED, { status: 403 });
}

/** A body's bytes as JSON, or null. */
export function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}
