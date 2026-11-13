// Passkey sign-in (decisions.md D-27). Public routes: they run before the API's session check, behind the same
// CSRF rules (JSON, the custom header, same-origin Origin). Each ceremony's challenge travels in a signed, HttpOnly,
// five-minute cookie (http/challenge.ts): starting a ceremony writes nothing, and a finish is single use.
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AppEnv } from '../http/context.js';
import type { Env } from '../env.js';
import { ulid } from '@ledgerline/platform';
import { resolveMembership } from '../db/scoped.js';
import { isFence, signupStmts, signupSwitchOn } from './signup.js';
import { RECOVERY_KEY_GRANT, recoveryKeyStmts } from './recovery-key.js';
import { clock, requestNow } from '../http/clock.js';
import { openChallenge, sealChallenge } from '../http/challenge.js';
import { bodyObject, csrf } from '../http/security.js';
import {
  CHALLENGE_COOKIE,
  CHALLENGE_MS,
  REAUTH_MS,
  SESSION_COOKIE,
  SESSION_MS,
  cookie,
  identify,
  ownerEmail,
  randomToken,
  readCookie,
  secretMatches,
  tokenHash,
} from '../http/auth.js';

export const authRoutes = new Hono<AppEnv>();
authRoutes.use('*', csrf);

const RP_NAME = 'Ledgerline';
/**
 * Each user has their own WebAuthn user handle (docs/multi-user.md 7.2), so two accounts' passkeys on one device
 * never replace each other. The first user keeps the handle every passkey used before multi-user.
 */
const OWNER_HANDLE = 'ledgerline-owner';
const handleBytes = (h: string) => Uint8Array.from(new TextEncoder().encode(h));

function rp(req: Request, env: Env): { rpID: string; origin: string } {
  const u = new URL(req.url);
  return { rpID: env.RP_ID ?? u.hostname, origin: u.origin };
}

const fail = (message: string) => ({ error: 'auth', message });

async function passkeyCount(env: Env): Promise<number> {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM passkey`).first<{ n: number }>())?.n ?? 0;
}

/**
 * Setup is open while no admin has a passkey (docs/open-signup.md 3.4): with one user, the same as no passkey at all;
 * with other users, the owner can still set up again after the runbook removes only the admin's passkeys.
 */
const NO_ADMIN_PASSKEY = `NOT EXISTS (SELECT 1 FROM passkey p JOIN user u ON u.id = p.user_id WHERE u.is_admin = 1)`;

async function setupOpen(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT ${NO_ADMIN_PASSKEY} AS open`).first<number>('open'));
}

/** The first admin, if one exists (setup adds the passkey to them). */
async function firstAdmin(env: Env): Promise<string | null> {
  return (
    (await env.DB.prepare(
      `SELECT id FROM user WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1`,
    ).first<string>('id')) ?? null
  );
}

/** Marks a ceremony's challenge used, in the same batch as what it allows (docs/open-signup.md 3.3). */
function useChallenge(env: Env, id: string, now: number): Stmt {
  return env.DB.prepare(`INSERT INTO used_challenge (id, used_at) VALUES (?1, ?2)`).bind(id, now);
}

const isReplay = (e: unknown) => /UNIQUE|PRIMARY KEY/i.test(String(e)) && /used_challenge/i.test(String(e));

/** A new session; null if this challenge already made one (a replay). */
async function newSession(
  env: Env,
  now: number,
  userId: string,
  passkeyId: string,
  ua: string | null,
  challengeId: string,
  replaces: string | null,
): Promise<string | null> {
  const token = randomToken();
  try {
    await env.DB.prepare(
      `INSERT INTO auth_session (id, created_at, expires_at, verified_at, passkey_id, user_agent, user_id, challenge_id)
       VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        await tokenHash(token),
        now,
        now + SESSION_MS,
        passkeyId,
        ua?.slice(0, 200) ?? null,
        userId,
        challengeId,
      )
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return null;
    throw e;
  }
  // Signing in again on this browser ends its earlier session (unlocking the phone's copy signs in each time), so
  // the leftovers never count as other devices in Settings → Sign-in.
  if (replaces)
    await env.DB.prepare(`DELETE FROM auth_session WHERE id = ?1 AND user_id = ?2`)
      .bind(await tokenHash(replaces), userId)
      .run();
  return token;
}

/** The user a new passkey will belong to, from what allowed the ceremony; null for setup before the first user exists. */
async function grantUser(env: Env, grant: { kind: string; ref: string | null }): Promise<string | null> {
  if (grant.kind === 'setup') return firstAdmin(env);
  if (grant.kind === 'device')
    return (
      (await env.DB.prepare(`SELECT user_id FROM device_link WHERE token_hash = ?1`)
        .bind(grant.ref)
        .first<string>('user_id')) ?? null
    );
  if (grant.kind === 'session')
    return (
      (await env.DB.prepare(`SELECT user_id FROM auth_session WHERE id = ?1`)
        .bind(grant.ref)
        .first<string>('user_id')) ?? null
    );
  return null;
}

async function takeChallenge(
  req: Request,
  env: Env,
  purpose: 'register' | 'login',
  now: number,
): Promise<{ id: string; challenge: string; grant_kind: string | null; grant_ref: string | null } | null> {
  const c = await openChallenge(env, readCookie(req, CHALLENGE_COOKIE), purpose, now);
  if (!c) return null;
  // Single use: a finished ceremony records its challenge id in used_challenge, in the same batch as what it allowed.
  // (A session's challenge_id changes on every fresh passkey check, so it can't be the test.)
  const used = await env.DB.prepare(`SELECT 1 AS u FROM used_challenge WHERE id = ?1`).bind(c.id).first();
  return used ? null : c;
}

async function putChallenge(
  env: Env,
  now: number,
  challenge: string,
  purpose: 'register' | 'login',
  grant: { kind: string; ref: string | null } | null,
): Promise<string> {
  return sealChallenge(env, now, challenge, purpose, grant);
}

/** What the sign-in screen should show. */
authRoutes.get('/status', async (c) => {
  const now = requestNow(c);
  const who = await identify(c.req.raw, c.env, now);
  const n = await passkeyCount(c.env);
  return c.json({
    signedIn: who?.kind === 'user',
    hasPasskey: n > 0,
    setupOpen: (c.env.SETUP_CODE?.length ?? 0) >= 32 && (await setupOpen(c.env)),
    // Open sign-up (D-75): only once the switch is on and the instance has its admin.
    ...(signupSwitchOn(c.env) && (await firstAdmin(c.env))
      ? { signupOpen: true, turnstileSiteKey: c.env.TURNSTILE_SITE_KEY }
      : { signupOpen: false }),
  });
});

/**
 * Starts adding a passkey. Allowed by one of: the setup code while no passkey exists yet; a single-use device
 * link made on a signed-in device; or a signed-in session whose passkey check is recent.
 */
authRoutes.post('/register/options', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = (await bodyObject(c.req)) as { setupCode?: unknown; deviceToken?: unknown };
  let grant: { kind: string; ref: string | null } | null = null;
  if (typeof b.setupCode === 'string') {
    if ((await setupOpen(env)) && (await secretMatches(b.setupCode, env.SETUP_CODE)))
      grant = { kind: 'setup', ref: null };
  } else if (typeof b.deviceToken === 'string') {
    const h = await tokenHash(b.deviceToken);
    const ok = await env.DB.prepare(
      `SELECT 1 AS ok FROM device_link WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
    )
      .bind(h, now)
      .first();
    if (ok) grant = { kind: 'device', ref: h };
  } else {
    const who = await identify(c.req.raw, env, now);
    if (who?.kind === 'user' && who.sessionId && now - who.verifiedAt <= REAUTH_MS)
      grant = { kind: 'session', ref: who.sessionId };
  }
  if (!grant) return c.json(fail('That code or link isn’t valid or has expired.'), 403);
  // Only this user's passkeys are excluded, and only their handle is used (never another account's).
  const userId = await grantUser(env, grant);
  if (grant.kind !== 'setup' && !userId)
    return c.json(fail('That code or link isn’t valid or has expired.'), 403);
  const user = userId
    ? await env.DB.prepare(`SELECT webauthn_handle, display_name FROM user WHERE id = ?1`)
        .bind(userId)
        .first<{ webauthn_handle: string | null; display_name: string | null }>()
    : null;
  let handle = user?.webauthn_handle ?? null;
  if (userId && !handle) {
    handle = randomToken(32);
    await env.DB.prepare(`UPDATE user SET webauthn_handle = ?2 WHERE id = ?1 AND webauthn_handle IS NULL`)
      .bind(userId, handle)
      .run();
  }
  const existing = userId
    ? await env.DB.prepare(`SELECT id, transports FROM passkey WHERE user_id = ?1`)
        .bind(userId)
        .all<{ id: string; transports: string | null }>()
    : { results: [] as { id: string; transports: string | null }[] };
  const { rpID } = rp(c.req.raw, env);
  const label = user?.display_name ?? 'Ledgerline';
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: handleBytes(handle ?? OWNER_HANDLE),
    userName: label,
    userDisplayName: label,
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) as never } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // PRF unlocks the encrypted copy on the phone (D-45). iCloud Keychain passkeys support it anyway; security keys
    // only when asked for it at creation.
    extensions: { prf: {} } as never,
  });
  const id = await putChallenge(env, now, options.challenge, 'register', grant);
  c.header('set-cookie', cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS));
  return c.json(options);
});

authRoutes.post('/register/verify', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = await c.req.json<{ response: RegistrationResponseJSON; name?: string }>().catch(() => null);
  if (!b || typeof b !== 'object') return c.json(fail('Something went wrong. Try again.'), 400);
  const ch = await takeChallenge(c.req.raw, env, 'register', now);
  if (!ch) return c.json(fail('That took too long. Try again.'), 400);
  const { rpID, origin } = rp(c.req.raw, env);
  let info;
  try {
    const v = await verifyRegistrationResponse({
      response: b.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) return c.json(fail('The passkey couldn’t be verified.'), 400);
    info = v.registrationInfo;
  } catch {
    return c.json(fail('The passkey couldn’t be verified.'), 400);
  }
  const cred = info.credential;
  const name = (typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Passkey').slice(0, 60);
  const insert = `INSERT INTO passkey (id, public_key, counter, transports, name, created_at, user_id)`;
  const vals = [
    cred.id,
    isoBase64URL.fromBuffer(cred.publicKey),
    cred.counter,
    cred.transports ? JSON.stringify(cred.transports) : null,
    name,
    now,
  ];
  // Re-check what allowed the ceremony, in the same statement as the insert, so a used link or a second setup
  // can't add a passkey.
  let stmts: Stmt[];
  let owner: string | null = null;
  /** Sign-up's new budget (routes/signup.ts). */
  let newBudget: string | null = null;
  if (ch.grant_kind === 'signup') {
    if (!signupSwitchOn(env) || !ch.grant_ref) return c.json(fail('That took too long. Try again.'), 400);
    if (env.BREAKER_NORMAL && !(await env.BREAKER_NORMAL()))
      return c.json({ error: 'full', message: 'Sign-up is full right now. Try again tomorrow.' }, 403);
    const r = await signupStmts(env, ch.grant_ref, vals, now);
    if (!r) return c.json(fail('That took too long. Try again.'), 400);
    ({ stmts, budgetId: newBudget } = r);
    owner = r.userId;
  } else if (ch.grant_kind === 'setup') {
    // The first passkey creates the first user (and their budget), who runs the instance. Later, while no admin has
    // a passkey (after the runbook's recovery), it goes to the first admin.
    if (!(await setupOpen(env))) return c.json(fail('That code or link isn’t valid or has expired.'), 403);
    owner = await firstAdmin(env);
    if (!owner) {
      const email = ownerEmail(env);
      const m = await resolveMembership(env.DB, email, email, now, () => ulid(now));
      if (!m) return c.json(fail('That code or link isn’t valid or has expired.'), 403);
      owner = m.userId;
    }
    stmts = [
      env.DB.prepare(`${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${NO_ADMIN_PASSKEY}`).bind(
        ...vals,
        owner,
      ),
    ];
  } else if (ch.grant_kind === 'device') {
    stmts = [
      env.DB.prepare(
        `UPDATE device_link SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
      ).bind(ch.grant_ref, now),
      env.DB.prepare(
        `${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6, user_id FROM device_link
         WHERE token_hash = ?7 AND used_at = ?6 AND user_id IS NOT NULL`,
      ).bind(...vals, ch.grant_ref),
    ];
  } else if (ch.grant_kind === RECOVERY_KEY_GRANT && ch.grant_ref) {
    // A recovery-key sign-in (routes/recovery-key.ts): the key's user gets this passkey, and is signed in.
    stmts = recoveryKeyStmts(env, ch.grant_ref, vals);
  } else if (ch.grant_kind === 'session') {
    stmts = [
      env.DB.prepare(
        `${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6, user_id FROM auth_session
         WHERE id = ?7 AND expires_at > ?6 AND user_id IS NOT NULL`,
      ).bind(...vals, ch.grant_ref),
    ];
  } else {
    return c.json(fail('That took too long. Try again.'), 400);
  }
  let replay = false;
  let fenced = false;
  const res = await env.DB.batch([useChallenge(env, ch.id, now), ...stmts]).catch((e: unknown) => {
    if (isReplay(e)) {
      replay = true;
      return null;
    }
    // Sign-up was full by the time the passkey came back.
    if (isFence(e)) {
      fenced = true;
      return null;
    }
    if (/UNIQUE|PRIMARY KEY/i.test(String(e))) return null; // the same passkey again
    throw e;
  });
  if (replay) return c.json(fail('That took too long. Try again.'), 400);
  if (fenced)
    return c.json({ error: 'full', message: 'Sign-up is full right now. Try again tomorrow.' }, 403);
  if (!res) return c.json(fail('This passkey is already set up. Sign in with it.'), 400);
  if ((res.at(-1)?.changes ?? 0) !== 1)
    return c.json(fail('That code or link isn’t valid or has expired.'), 403);
  if (ch.grant_kind !== 'session') {
    const userId =
      owner ??
      (await env.DB.prepare(`SELECT user_id FROM passkey WHERE id = ?1`)
        .bind(cred.id)
        .first<string>('user_id'));
    if (!userId) return c.json(fail('The passkey couldn’t be verified.'), 400);
    const token = await newSession(
      env,
      now,
      userId,
      cred.id,
      c.req.header('user-agent') ?? null,
      ch.id,
      readCookie(c.req.raw, SESSION_COOKIE),
    );
    if (!token) return c.json(fail('That took too long. Try again.'), 400);
    c.header('set-cookie', cookie(SESSION_COOKIE, token, SESSION_MS));
  }
  // A new account's store is made now, so its migrations run before the first screen (docs/open-signup.md 3.2).
  // If this fails, the store makes itself on the first request instead.
  if (newBudget) await env.NEW_STORE?.(newBudget).catch(() => undefined);
  return c.json({ ok: true });
});

/** Starts a sign-in, or a fresh passkey check for an existing session. Discoverable credentials: no user name. */
authRoutes.post('/login/options', async (c) => {
  const env = c.env;
  const now = clock(env);
  const { rpID } = rp(c.req.raw, env);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const id = await putChallenge(env, now, options.challenge, 'login', null);
  c.header('set-cookie', cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS));
  return c.json(options);
});

authRoutes.post('/login/verify', async (c) => {
  const env = c.env;
  /** False when the challenge was used meanwhile (a replay racing the first use). */
  const finish = (stmts: Stmt[]) =>
    env.DB.batch(stmts).then(
      () => true,
      (e: unknown) => {
        if (isReplay(e)) return false;
        throw e;
      },
    );
  const now = clock(env);
  const b = await c.req.json<{ response: AuthenticationResponseJSON }>().catch(() => null);
  if (!b || typeof b !== 'object') return c.json(fail('Something went wrong. Try again.'), 400);
  const ch = await takeChallenge(c.req.raw, env, 'login', now);
  if (!ch) return c.json(fail('That took too long. Try again.'), 400);
  const pk = await env.DB.prepare(
    `SELECT p.id, p.public_key, p.counter, p.transports, p.user_id, u.webauthn_handle, u.status
     FROM passkey p LEFT JOIN user u ON u.id = p.user_id WHERE p.id = ?1`,
  )
    .bind(String(b.response?.id ?? ''))
    .first<{
      id: string;
      public_key: string;
      counter: number;
      transports: string | null;
      user_id: string | null;
      webauthn_handle: string | null;
      status: string | null;
    }>();
  if (!pk || !pk.user_id) return c.json(fail('This passkey isn’t registered with Ledgerline.'), 403);
  if (pk.status !== 'active') return c.json(fail('This account is turned off.'), 403);
  // The passkey must answer for its own user (docs/multi-user.md 7.2). Every Ledgerline passkey is discoverable, so
  // its answer always carries the user handle; one without it is refused (docs/open-signup.md 6).
  const sent = b.response?.response?.userHandle;
  if (pk.webauthn_handle && sent !== isoBase64URL.fromBuffer(handleBytes(pk.webauthn_handle)))
    return c.json(fail('The passkey couldn’t be verified.'), 403);
  const { rpID, origin } = rp(c.req.raw, env);
  let newCounter: number;
  try {
    const v = await verifyAuthenticationResponse({
      response: b.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: pk.id,
        publicKey: isoBase64URL.toBuffer(pk.public_key),
        counter: pk.counter,
        ...(pk.transports ? { transports: JSON.parse(pk.transports) as never } : {}),
      },
    });
    if (!v.verified) return c.json(fail('The passkey couldn’t be verified.'), 403);
    newCounter = v.authenticationInfo.newCounter;
  } catch {
    return c.json(fail('The passkey couldn’t be verified.'), 403);
  }
  const stmts = [
    useChallenge(env, ch.id, now),
    env.DB.prepare(`UPDATE passkey SET counter = ?2, last_used_at = ?3 WHERE id = ?1`).bind(
      pk.id,
      newCounter,
      now,
    ),
  ];
  // Already signed in: this was a fresh passkey check (for linking a bank or exporting), so keep the session.
  const who = await identify(c.req.raw, env, now);
  if (who?.kind === 'user' && who.sessionId && who.userId === pk.user_id) {
    stmts.push(
      env.DB.prepare(`UPDATE auth_session SET verified_at = ?2, challenge_id = ?3 WHERE id = ?1`).bind(
        who.sessionId,
        now,
        ch.id,
      ),
    );
    if (!(await finish(stmts))) return c.json(fail('That took too long. Try again.'), 400);
    return c.json({ ok: true });
  }
  if (!(await finish(stmts))) return c.json(fail('That took too long. Try again.'), 400);
  const token = await newSession(
    env,
    now,
    pk.user_id,
    pk.id,
    c.req.header('user-agent') ?? null,
    ch.id,
    readCookie(c.req.raw, SESSION_COOKIE),
  );
  if (!token) return c.json(fail('That took too long. Try again.'), 400);
  c.header('set-cookie', cookie(SESSION_COOKIE, token, SESSION_MS));
  return c.json({ ok: true });
});

/**
 * Whether a phone's saved copy was signed out from another device (Settings → Sign-in). Asked without a sign-in, when
 * the app opens and when its sign-in ends, so the phone deletes the copy before it shows anything. Device ids are
 * 128 random bits and the answer says nothing else.
 */
authRoutes.post('/copy-status', async (c) => {
  const body = (await bodyObject(c.req)) as { device?: unknown };
  if (typeof body.device !== 'string' || body.device.length > 64) return c.json({ off: true });
  const d = await c.env.DB.prepare(`SELECT revoked_at, share FROM device WHERE id = ?1`)
    .bind(body.device)
    .first<{ revoked_at: number | null; share: string | null }>();
  return c.json({ off: !d || d.revoked_at !== null || !d.share });
});

authRoutes.post('/logout', async (c) => {
  const token = readCookie(c.req.raw, SESSION_COOKIE);
  if (token)
    await c.env.DB.prepare(`DELETE FROM auth_session WHERE id = ?1`)
      .bind(await tokenHash(token))
      .run();
  c.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return c.json({ ok: true });
});
