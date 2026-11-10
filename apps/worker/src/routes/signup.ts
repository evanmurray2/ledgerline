// Open sign-up and recovery codes, built and switched off (D-75, docs/open-signup.md 2–4). The switch and Turnstile are
// checked in the Worker, so a closed or bad request costs no Durable Object request; the Directory then hands out the
// passkey options, and register/verify in routes/auth.ts makes the account (or adds the recovered passkey) in one
// batch with the statements built here.
import type { Stmt } from '@ledgerline/db/sql';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { Hono } from 'hono';
import { CSRF_HEADER } from '@ledgerline/contracts';
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import type { AppEnv } from '../http/context.js';
import { CHALLENGE_COOKIE, CHALLENGE_MS, cookie, randomToken, tokenHash as sha256Hex } from '../http/auth.js';
import { sealChallenge } from '../http/challenge.js';
import { clock } from '../http/clock.js';

export const SIGNUP_PATH = '/api/auth/signup/options';
export const RECOVER_PATH = '/api/auth/recover/options';

/** A recovery notice shows for this long after the code was used (docs/open-signup.md 4). */
export const NOTICE_MS = 14 * 86_400_000;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fail = (message: string) => ({ error: 'auth', message });

export { maxUsers, signupSwitchOn, signupsPerDay } from './signup-switch.js';
import { maxUsers, signupSwitchOn, signupsPerDay } from './signup-switch.js';

// ---- Turnstile

/**
 * Cloudflare's documented test secrets: one always passes, one always fails, with the dummy token their test site
 * keys produce. Accepted only off Plaid Production, without a network call, for local runs and e2e.
 */
const TEST_PASS = '1x0000000000000000000000000000000AA';
const TEST_FAIL = '2x0000000000000000000000000000000AA';
export const TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

export async function verifyTurnstile(
  env: Env,
  token: string,
  ip: string | null,
  action: 'signup' | 'recover',
  hostname: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET ?? '';
  if (!token || token.length > 2048) return false;
  if (env.PLAID_ENV !== 'production' && (secret === TEST_PASS || secret === TEST_FAIL))
    return secret === TEST_PASS && token === TEST_TOKEN;
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const v = (await r.json()) as { success?: boolean; hostname?: string; action?: string };
    return v.success === true && v.hostname === hostname && v.action === action;
  } catch {
    return false;
  }
}

// ---- Recovery codes

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 20 random bytes as 32 base32 characters in groups of 4, and the SHA-256 that is stored. */
export async function newRecoveryCode(): Promise<{ code: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return { code: out.match(/.{4}/g)!.join('-'), hash: await sha256Hex(out) };
}

/** What the user typed, as stored: capitals, no spaces or dashes; null if it can't be a code. */
export function normalizeCode(typed: string): string | null {
  const s = typed.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{32}$/.test(s) ? s : null;
}

// ---- The Worker's side

/** The CSRF rules of http/security.ts, for the two routes the Worker answers itself. */
function csrfOk(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return false;
  if (req.headers.get(CSRF_HEADER) !== '1') return false;
  const origin = req.headers.get('origin');
  return !origin || origin === new URL(req.url).origin;
}

/** The part of the Directory these routes call (store/directory.ts). */
export interface SignupDirectory {
  signupOptions(url: string): Promise<{ status: number; body: unknown; cookie?: string }>;
  recoverOptions(url: string, code: string): Promise<{ status: number; body: unknown; cookie?: string }>;
}

/** POST /api/auth/signup/options and /api/auth/recover/options: the switch, CSRF and Turnstile, then the Directory. */
export async function gatedOptions(req: Request, env: Env, dir: SignupDirectory): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method !== 'POST' || !signupSwitchOn(env))
    return json({ error: 'not_found', message: 'Not found.' }, 404);
  if (!csrfOk(req)) return json({ error: 'csrf', message: 'Something went wrong. Try again.' }, 403);
  const b = (await req.json().catch(() => null)) as {
    code?: unknown;
    turnstileToken?: unknown;
  } | null;
  if (!b || typeof b.turnstileToken !== 'string') return json(fail('Something went wrong. Try again.'), 400);
  const signup = path === SIGNUP_PATH;
  const host = env.RP_ID ?? new URL(req.url).hostname;
  const ok = await verifyTurnstile(
    env,
    b.turnstileToken,
    req.headers.get('cf-connecting-ip'),
    signup ? 'signup' : 'recover',
    host,
  );
  if (!ok) return json(fail('The check didn’t pass. Try again.'), 403);
  const r = signup
    ? await dir.signupOptions(req.url)
    : await dir.recoverOptions(req.url, typeof b.code === 'string' ? b.code : '');
  return json(r.body, r.status, r.cookie ? { 'set-cookie': r.cookie } : {});
}

// ---- The Directory's side

const RP_NAME = 'Ledgerline';
const today = (now: number) =>
  Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());

/** Room for one more account: under MAX_USERS and today's SIGNUPS_PER_DAY, and an admin exists. */
async function room(env: Env, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM user) AS users, (SELECT count(*) FROM user WHERE created_at >= ?1) AS today,
       (SELECT count(*) FROM user WHERE is_admin = 1) AS admins`,
  )
    .bind(today(now))
    .first<{ users: number; today: number; admins: number }>();
  return !!r && r.admins > 0 && r.users < maxUsers(env) && r.today < signupsPerDay(env);
}

const FULL = { error: 'full', message: 'Sign-up is full right now. Try again tomorrow.' };

function rpOf(url: string, env: Env): string {
  return env.RP_ID ?? new URL(url).hostname;
}

/**
 * The passkey options for a new account; nothing is written (the challenge is a signed cookie). Sign-up asks for a
 * passkey and nothing else (D-85): no name, no email. The passkey's own label is the app's name and the day it was
 * made, so two accounts on one device can be told apart.
 */
export async function signupOptions(
  env: Env,
  url: string,
  normal: boolean,
): Promise<{ status: number; body: unknown; cookie?: string }> {
  const now = clock(env);
  const name = `${RP_NAME}, ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  if (!normal || !(await room(env, now))) return { status: 403, body: FULL };
  const handle = randomToken(32);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpOf(url, env),
    userID: Uint8Array.from(new TextEncoder().encode(handle)),
    userName: name,
    userDisplayName: name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} } as never,
  });
  const id = await sealChallenge(env, now, options.challenge, 'register', {
    kind: 'signup',
    ref: JSON.stringify({ handle }),
  });
  return { status: 200, body: options, cookie: cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS) };
}

/** The passkey options for a recovery: the code's user, with their own handle; nothing is written. */
export async function recoverOptions(
  env: Env,
  url: string,
  typed: string,
  normal: boolean,
): Promise<{ status: number; body: unknown; cookie?: string }> {
  const now = clock(env);
  const bad = { status: 403, body: fail('That recovery code isn’t valid.') };
  const code = normalizeCode(typed);
  if (!code) return bad;
  if (!normal) return { status: 403, body: FULL };
  const hash = await sha256Hex(code);
  const u = await env.DB.prepare(
    `SELECT u.id, u.webauthn_handle, u.display_name FROM recovery_code r JOIN user u ON u.id = r.user_id
     WHERE r.code_hash = ?1 AND u.status = 'active' AND u.is_admin = 0 AND u.webauthn_handle IS NOT NULL`,
  )
    .bind(hash)
    .first<{ id: string; webauthn_handle: string; display_name: string | null }>();
  if (!u) return bad;
  const existing = await env.DB.prepare(`SELECT id, transports FROM passkey WHERE user_id = ?1`)
    .bind(u.id)
    .all<{ id: string; transports: string | null }>();
  const label = u.display_name ?? 'Ledgerline';
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpOf(url, env),
    userID: Uint8Array.from(new TextEncoder().encode(u.webauthn_handle)),
    userName: label,
    userDisplayName: label,
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) as never } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    extensions: { prf: {} } as never,
  });
  const id = await sealChallenge(env, now, options.challenge, 'register', { kind: 'recovery', ref: hash });
  return { status: 200, body: options, cookie: cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS) };
}

/** A fence statement (migration 0008): the whole batch rolls back unless `sqlScalar` is 1. */
function fence(env: Env, sqlScalar: string, ...params: unknown[]): Stmt {
  return env.DB.prepare(`INSERT OR REPLACE INTO fence (id, ok) VALUES (1, coalesce((${sqlScalar}), 0))`).bind(
    ...params,
  );
}

export const isFence = (e: unknown) =>
  /CHECK constraint failed/i.test(String(e)) && /fence|ok = 1/i.test(String(e));

/**
 * A new account in one batch, after the passkey checked out: the user (only while there is room), a fence that
 * throws when there wasn't, their budget, membership, passkey and recovery code. `passkey` is the passkey insert's
 * values for (id, public_key, counter, transports, name, created_at).
 */
export async function signupStmts(
  env: Env,
  grantRef: string,
  passkey: unknown[],
  now: number,
): Promise<{ stmts: Stmt[]; userId: string; budgetId: string; code: string } | null> {
  let g: { handle?: unknown };
  try {
    g = JSON.parse(grantRef) as typeof g;
  } catch {
    return null;
  }
  if (typeof g.handle !== 'string') return null;
  const userId = ulid(now);
  const budgetId = ulid(now);
  const { code, hash } = await newRecoveryCode();
  const db = env.DB;
  const stmts = [
    db
      .prepare(
        `INSERT INTO user (id, email, display_name, is_admin, status, webauthn_handle, created_at, updated_at)
         SELECT ?1, 'u:' || ?1, NULL, 0, 'active', ?2, ?3, ?3
         WHERE (SELECT count(*) FROM user) < ?4 AND (SELECT count(*) FROM user WHERE created_at >= ?5) < ?6
           AND EXISTS (SELECT 1 FROM user WHERE is_admin = 1)`,
      )
      .bind(userId, g.handle, now, maxUsers(env), today(now), signupsPerDay(env)),
    fence(env, `SELECT count(*) = 1 FROM user WHERE id = ?1`, userId),
    db
      .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?2)`)
      .bind(budgetId, now),
    db
      .prepare(
        `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'owner', ?3, ?3)`,
      )
      .bind(budgetId, userId, now),
    db
      .prepare(
        `INSERT INTO passkey (id, public_key, counter, transports, name, created_at, user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(...passkey, userId),
    db
      .prepare(`INSERT INTO recovery_code (user_id, code_hash, created_at) VALUES (?1, ?2, ?3)`)
      .bind(userId, hash, now),
  ];
  return { stmts, userId, budgetId, code };
}

/**
 * A recovery in one batch: the new passkey for the code's user (only while the code still matches an active user
 * who isn't an admin), a fence that throws when it didn't, the code swapped for a new one, and the notice. Nothing
 * is removed: a leaked code can't lock the real user out (docs/open-signup.md 4).
 */
export async function recoveryStmts(
  env: Env,
  codeHash: string,
  passkey: unknown[],
  now: number,
): Promise<{ stmts: Stmt[]; passkeyId: string; code: string }> {
  const { code, hash } = await newRecoveryCode();
  const db = env.DB;
  const passkeyId = String(passkey[0]);
  const stmts = [
    db
      .prepare(
        `INSERT INTO passkey (id, public_key, counter, transports, name, created_at, user_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, u.id FROM recovery_code r JOIN user u ON u.id = r.user_id
         WHERE r.code_hash = ?7 AND u.status = 'active' AND u.is_admin = 0`,
      )
      .bind(...passkey, codeHash),
    fence(env, `SELECT count(*) = 1 FROM passkey WHERE id = ?1`, passkeyId),
    db
      .prepare(
        `INSERT OR REPLACE INTO recovery_notice (user_id, used_at, dismissed_at) SELECT user_id, ?2, NULL FROM passkey WHERE id = ?1`,
      )
      .bind(passkeyId, now),
    db.prepare(`DELETE FROM recovery_code WHERE code_hash = ?1`).bind(codeHash),
    db
      .prepare(
        `INSERT INTO recovery_code (user_id, code_hash, created_at) SELECT user_id, ?2, ?3 FROM passkey WHERE id = ?1`,
      )
      .bind(passkeyId, hash, now),
  ];
  return { stmts, passkeyId, code };
}

/** When a recovery code was used for this user, if the notice still shows (14 days, not dismissed). */
export async function recoveryNotice(env: Env, userId: string, now: number): Promise<number | null> {
  const r = await env.DB.prepare(
    `SELECT used_at FROM recovery_notice WHERE user_id = ?1 AND dismissed_at IS NULL AND used_at > ?2`,
  )
    .bind(userId, now - NOTICE_MS)
    .first<number>('used_at');
  return r ?? null;
}

// ---- Settings → Sign-in (users who aren't admins)

export const recoveryRoutes = new Hono<AppEnv>();

/** A new recovery code, shown once; the old one stops working. Needs a recent passkey check (http/auth.ts). */
recoveryRoutes.post('/settings/security/recovery-code', async (c) => {
  const userId = c.get('userId');
  const admin = await c.env.DB.prepare(`SELECT is_admin FROM user WHERE id = ?1`)
    .bind(userId)
    .first<number>('is_admin');
  if (admin !== 0) return c.json({ error: 'not_found', message: 'Not found.' }, 404);
  const { code, hash } = await newRecoveryCode();
  await c.env.DB.prepare(
    `INSERT INTO recovery_code (user_id, code_hash, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at`,
  )
    .bind(userId, hash, clock(c.env))
    .run();
  return c.json({ code });
});

/** "This is it": the recovery notice stops showing. */
recoveryRoutes.post('/settings/security/recovery-notice/dismiss', async (c) => {
  await c.env.DB.prepare(
    `UPDATE recovery_notice SET dismissed_at = ?2 WHERE user_id = ?1 AND dismissed_at IS NULL`,
  )
    .bind(c.get('userId'), clock(c.env))
    .run();
  return c.json({ ok: true });
});
