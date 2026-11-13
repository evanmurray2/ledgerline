// Authentication without Cloudflare Access (decisions.md D-27: Zero Trust needs a payment card on file). The Worker
// verifies passkeys itself (routes/auth.ts) and keeps sessions server-side: the browser holds a random token in an
// HttpOnly cookie and the database stores only its SHA-256. The deploy smoke test uses a bearer
// token that can reach two endpoints. Local development may trust a fixed email instead, never in production.
import { sha256Hex } from '@ledgerline/bank-provider';
import { toBase64url, ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { resolveMembership } from '../db/scoped.js';

export const SESSION_COOKIE = '__Host-ledgerline';
export const CHALLENGE_COOKIE = '__Host-ledgerline-challenge';
/** Absolute session length: sign in again with your passkey once a day (design: Security and authentication). */
export const SESSION_MS = 24 * 60 * 60 * 1000;
/** Linking banks and exporting data need a passkey check this recent. */
export const REAUTH_MS = 15 * 60 * 1000;
export const CHALLENGE_MS = 5 * 60 * 1000;
export const DEVICE_LINK_MS = 10 * 60 * 1000;
/** Secrets shorter than this are refused, so they can't be guessed. */
export const MIN_SECRET_LENGTH = 32;

export type Identity =
  { kind: 'user'; userId: string; sessionId: string | null; verifiedAt: number } | { kind: 'ops' };

/**
 * Local development and tests sign in as DEV_AUTH_EMAIL without a passkey. Never where a setup code exists (every
 * real deploy has one), and never on Plaid Production, so one wrong setting can't open the app to anyone.
 */
export function devSignIn(env: Env): boolean {
  return !!env.DEV_AUTH_EMAIL && env.PLAID_ENV !== 'production' && !env.SETUP_CODE;
}

/** The first user's email in the membership tables (setup and local development only; never identity). */
export function ownerEmail(env: Env): string {
  const dev = devSignIn(env) ? env.DEV_AUTH_EMAIL : undefined;
  return (env.OWNER_EMAIL || dev || 'owner').toLowerCase();
}

export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get('cookie');
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;
}

export function randomToken(bytes = 32): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const tokenHash = (token: string): Promise<string> => sha256Hex(token);

/** Constant-time comparison of a presented secret with a configured one. */
export async function secretMatches(presented: string, configured: string | undefined): Promise<boolean> {
  if (!configured || configured.length < MIN_SECRET_LENGTH) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(configured)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The only path the ops token may reach: the monitor and the deploy smoke test read health. */
export const OPS_PATHS = new Set(['GET /api/health']);

export async function identify(req: Request, env: Env, now: number): Promise<Identity | null> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer '))
    return (await secretMatches(auth.slice(7), env.OPS_TOKEN)) ? { kind: 'ops' } : null;
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    // The session names its user (docs/multi-user.md 7.1); a disabled or deleting user's sessions stop working.
    const row = await env.DB.prepare(
      `SELECT s.id, s.expires_at, s.verified_at, s.user_id, u.status FROM auth_session s
       LEFT JOIN user u ON u.id = s.user_id WHERE s.id = ?1`,
    )
      .bind(await tokenHash(token))
      .first<{
        id: string;
        expires_at: number;
        verified_at: number;
        user_id: string | null;
        status: string | null;
      }>();
    if (row && row.expires_at > now && row.user_id && row.status === 'active')
      return { kind: 'user', userId: row.user_id, sessionId: row.id, verifiedAt: row.verified_at };
    return null;
  }
  // Local development and tests only: no passkey, a fixed first user.
  if (devSignIn(env)) {
    const email = ownerEmail(env);
    const m = await resolveMembership(env.DB, email, email, now, () => ulid(now));
    return m ? { kind: 'user', userId: m.userId, sessionId: null, verifiedAt: now } : null;
  }
  return null;
}

/** Syncing banks now (pull to sync, Try again, Finish setup): fetches what Plaid already has, so no passkey check. */
const SYNC_NOW = /^\/api\/settings\/connections\/(?:[^/]+\/)?refresh$/;

/** Linking or repairing a bank, removing a connection, and managing passkeys need a recent passkey check. */
export function needsRecentPasskey(method: string, path: string): boolean {
  if (method === 'GET' || path === '/api/settings/security/sign-out') return false;
  // The challenge for a signed request writes nothing; the request it is for asks for the check.
  if (path === '/api/settings/security/request-challenge') return false;
  if (SYNC_NOW.test(path)) return false;
  return path.startsWith('/api/settings/connections') || path.startsWith('/api/settings/security/');
}
