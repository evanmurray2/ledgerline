// Open sign-up, built and switched off (D-75, docs/open-signup.md 2–3). The switch and Turnstile are checked in the
// Worker, so a closed or bad request costs no Durable Object request; the Directory then hands out the passkey
// options, and register/verify in routes/auth.ts makes the account in one batch with the statements built here. The
// account's budget is made on its device, locked, with its recovery key (D-102): there is no recovery code.
import type { Stmt } from '@ledgerline/db/sql';
import { CSRF_HEADER } from '@ledgerline/contracts';
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { CHALLENGE_COOKIE, CHALLENGE_MS, cookie, randomToken } from '../http/auth.js';
import { sealChallenge } from '../http/challenge.js';
import { clock } from '../http/clock.js';
import { RP_NAME, registrationOptions } from './passkey-options.js';

export const SIGNUP_PATH = '/api/auth/signup/options';

/** A recovery notice shows for this long after the recovery key signed in (routes/recovery-key.ts). */
export const NOTICE_MS = 14 * 86_400_000;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fail = (message: string) => ({ error: 'auth', message });

export { maxUsers, signupSwitchOn, signupsPerDay } from './signup-switch.js';
import { checkHost, maxUsers, signupSwitchOn, signupsPerDay } from './signup-switch.js';

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
  action: 'signup',
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
}

/** POST /api/auth/signup/options: the switch, CSRF and Turnstile, then the Directory. */
export async function gatedOptions(req: Request, env: Env, dir: SignupDirectory): Promise<Response> {
  if (req.method !== 'POST' || !signupSwitchOn(env))
    return json({ error: 'not_found', message: 'Not found.' }, 404);
  if (!csrfOk(req)) return json({ error: 'csrf', message: 'Something went wrong. Try again.' }, 403);
  const b = (await req.json().catch(() => null)) as { turnstileToken?: unknown } | null;
  if (!b || typeof b.turnstileToken !== 'string') return json(fail('Something went wrong. Try again.'), 400);
  // The check ran on its own address (docs/privacy.md 5.6), so the token names that host, not the app's.
  const host = checkHost(env) ?? '';
  const ok = await verifyTurnstile(
    env,
    b.turnstileToken,
    req.headers.get('cf-connecting-ip'),
    'signup',
    host,
  );
  if (!ok) return json(fail('The check didn’t pass. Try again.'), 403);
  const r = await dir.signupOptions(req.url);
  return json(r.body, r.status, r.cookie ? { 'set-cookie': r.cookie } : {});
}

// ---- The Directory's side

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
  const options = await registrationOptions({ url, env, handle, label: name });
  const id = await sealChallenge(env, now, options.challenge, 'register', {
    kind: 'signup',
    ref: JSON.stringify({ handle }),
  });
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
 * throws when there wasn't, their budget, membership and passkey. `passkey` is the passkey insert's
 * values for (id, public_key, counter, transports, name, created_at).
 */
export async function signupStmts(
  env: Env,
  grantRef: string,
  passkey: unknown[],
  now: number,
): Promise<{ stmts: Stmt[]; userId: string; budgetId: string } | null> {
  let g: { handle?: unknown };
  try {
    g = JSON.parse(grantRef) as typeof g;
  } catch {
    return null;
  }
  if (typeof g.handle !== 'string') return null;
  const userId = ulid(now);
  const budgetId = ulid(now);
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
  ];
  return { stmts, userId, budgetId };
}
