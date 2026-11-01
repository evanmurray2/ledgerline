// Passkey sign-in (decisions.md D-27). Public routes: they run before the API's session check, behind the same
// CSRF rules (JSON, the custom header, same-origin Origin). Every ceremony's challenge is stored server-side for
// five minutes and tied to the browser by an HttpOnly cookie.
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
import { clock } from '../http/clock.js';
import { csrf } from '../http/security.js';
import {
  CHALLENGE_COOKIE,
  CHALLENGE_MS,
  REAUTH_MS,
  SESSION_COOKIE,
  SESSION_MS,
  cookie,
  identify,
  randomToken,
  readCookie,
  secretMatches,
  tokenHash,
} from '../http/auth.js';

export const authRoutes = new Hono<AppEnv>();
authRoutes.use('*', csrf);

const RP_NAME = 'Ledgerline';
/** One user: every passkey belongs to the same WebAuthn user handle. */
const USER_ID = Uint8Array.from(new TextEncoder().encode('ledgerline-owner'));

function rp(req: Request, env: Env): { rpID: string; origin: string } {
  const u = new URL(req.url);
  return { rpID: env.RP_ID ?? u.hostname, origin: u.origin };
}

const fail = (message: string) => ({ error: 'auth', message });

async function passkeyCount(env: Env): Promise<number> {
  return (await env.DB.prepare(`SELECT count(*) AS n FROM passkey`).first<{ n: number }>())?.n ?? 0;
}

async function newSession(env: Env, now: number, passkeyId: string, ua: string | null): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO auth_session (id, created_at, expires_at, verified_at, passkey_id, user_agent) VALUES (?1, ?2, ?3, ?2, ?4, ?5)`,
  )
    .bind(await tokenHash(token), now, now + SESSION_MS, passkeyId, ua?.slice(0, 200) ?? null)
    .run();
  return token;
}

async function takeChallenge(
  req: Request,
  env: Env,
  purpose: 'register' | 'login',
  now: number,
): Promise<{ challenge: string; grant_kind: string | null; grant_ref: string | null } | null> {
  const id = readCookie(req, CHALLENGE_COOKIE);
  if (!id) return null;
  // Single use: deleted as it is read.
  const row = await env.DB.prepare(
    `DELETE FROM auth_challenge WHERE id = ?1 AND purpose = ?2 RETURNING challenge, grant_kind, grant_ref, expires_at`,
  )
    .bind(id, purpose)
    .first<{ challenge: string; grant_kind: string | null; grant_ref: string | null; expires_at: number }>();
  if (!row || row.expires_at <= now) return null;
  return row;
}

async function putChallenge(
  env: Env,
  now: number,
  challenge: string,
  purpose: 'register' | 'login',
  grant: { kind: string; ref: string | null } | null,
): Promise<string> {
  const id = randomToken(16);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_challenge WHERE expires_at <= ?1`).bind(now),
    env.DB.prepare(
      `INSERT INTO auth_challenge (id, challenge, purpose, grant_kind, grant_ref, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, challenge, purpose, grant?.kind ?? null, grant?.ref ?? null, now + CHALLENGE_MS),
  ]);
  return id;
}

/** What the sign-in screen should show. */
authRoutes.get('/status', async (c) => {
  const now = clock(c.env);
  const who = await identify(c.req.raw, c.env, now);
  const n = await passkeyCount(c.env);
  return c.json({
    signedIn: who?.kind === 'owner',
    hasPasskey: n > 0,
    setupOpen: n === 0 && (c.env.SETUP_CODE?.length ?? 0) >= 32,
  });
});

/**
 * Starts adding a passkey. Allowed by one of: the setup code while no passkey exists yet; a single-use device
 * link made on a signed-in device; or a signed-in session whose passkey check is recent.
 */
authRoutes.post('/register/options', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = await c.req.json<{ setupCode?: string; deviceToken?: string }>().catch(() => ({}) as never);
  let grant: { kind: string; ref: string | null } | null = null;
  if (typeof b.setupCode === 'string') {
    if ((await passkeyCount(env)) === 0 && (await secretMatches(b.setupCode, env.SETUP_CODE)))
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
    if (who?.kind === 'owner' && who.sessionId && now - who.verifiedAt <= REAUTH_MS)
      grant = { kind: 'session', ref: who.sessionId };
  }
  if (!grant) return c.json(fail('That code or link isn’t valid, or it has expired.'), 403);
  const existing = await env.DB.prepare(`SELECT id, transports FROM passkey`).all<{
    id: string;
    transports: string | null;
  }>();
  const { rpID } = rp(c.req.raw, env);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: USER_ID,
    userName: 'Ledgerline',
    userDisplayName: 'Ledgerline',
    attestationType: 'none',
    excludeCredentials: existing.results.map((p) => ({
      id: p.id,
      ...(p.transports ? { transports: JSON.parse(p.transports) as never } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const id = await putChallenge(env, now, options.challenge, 'register', grant);
  c.header('set-cookie', cookie(CHALLENGE_COOKIE, id, CHALLENGE_MS));
  return c.json(options);
});

authRoutes.post('/register/verify', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = await c.req.json<{ response: RegistrationResponseJSON; name?: string }>();
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
  const insert = `INSERT INTO passkey (id, public_key, counter, transports, name, created_at)`;
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
  let stmts: D1PreparedStatement[];
  if (ch.grant_kind === 'setup') {
    stmts = [
      env.DB.prepare(`${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM passkey)`).bind(
        ...vals,
      ),
    ];
  } else if (ch.grant_kind === 'device') {
    stmts = [
      env.DB.prepare(
        `UPDATE device_link SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2`,
      ).bind(ch.grant_ref, now),
      env.DB.prepare(
        `${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM device_link WHERE token_hash = ?7 AND used_at = ?6)`,
      ).bind(...vals, ch.grant_ref),
    ];
  } else if (ch.grant_kind === 'session') {
    stmts = [
      env.DB.prepare(
        `${insert} SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM auth_session WHERE id = ?7 AND expires_at > ?6)`,
      ).bind(...vals, ch.grant_ref),
    ];
  } else {
    return c.json(fail('That took too long. Try again.'), 400);
  }
  const res = await env.DB.batch(stmts);
  if ((res.at(-1)?.meta.changes ?? 0) !== 1)
    return c.json(fail('That code or link isn’t valid, or it has expired.'), 403);
  if (ch.grant_kind !== 'session') {
    const token = await newSession(env, now, cred.id, c.req.header('user-agent') ?? null);
    c.header('set-cookie', cookie(SESSION_COOKIE, token, SESSION_MS));
  }
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
  const now = clock(env);
  const b = await c.req.json<{ response: AuthenticationResponseJSON }>();
  const ch = await takeChallenge(c.req.raw, env, 'login', now);
  if (!ch) return c.json(fail('That took too long. Try again.'), 400);
  const pk = await env.DB.prepare(`SELECT id, public_key, counter, transports FROM passkey WHERE id = ?1`)
    .bind(String(b.response?.id ?? ''))
    .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
  if (!pk) return c.json(fail('This passkey isn’t registered with Ledgerline.'), 403);
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
    env.DB.prepare(`UPDATE passkey SET counter = ?2, last_used_at = ?3 WHERE id = ?1`).bind(
      pk.id,
      newCounter,
      now,
    ),
  ];
  // Already signed in: this was a fresh passkey check (for linking a bank or exporting), so keep the session.
  const who = await identify(c.req.raw, env, now);
  if (who?.kind === 'owner' && who.sessionId) {
    stmts.push(
      env.DB.prepare(`UPDATE auth_session SET verified_at = ?2 WHERE id = ?1`).bind(who.sessionId, now),
    );
    await env.DB.batch(stmts);
    return c.json({ ok: true });
  }
  await env.DB.batch(stmts);
  const token = await newSession(env, now, pk.id, c.req.header('user-agent') ?? null);
  c.header('set-cookie', cookie(SESSION_COOKIE, token, SESSION_MS));
  return c.json({ ok: true });
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
