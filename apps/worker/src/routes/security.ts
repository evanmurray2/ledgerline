// Settings → Sign-in: your passkeys, links for adding a device, and signing out (decisions.md D-27). Changes here
// need a passkey check within the last 15 minutes (http/auth.ts needsRecentPasskey).
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../http/context.js';
import { toBase64url } from '@ledgerline/platform';
import { requestNow } from '../http/clock.js';
import {
  DEVICE_LINK_MS,
  OPS_PATHS,
  REAUTH_MS,
  SESSION_COOKIE,
  cookie,
  identify,
  needsRecentPasskey,
  randomToken,
  tokenHash,
} from '../http/auth.js';
import { membership } from '../db/scoped.js';
import { describeAgent } from '../http/agent.js';
import { bodyObject } from '../http/security.js';
import { signupSwitchOn } from './signup-switch.js';

export const securityRoutes = new Hono<AppEnv>();

/** Settings → Sign-in in the Directory: a signed-in session (or the ops token), then membership in a budget. */
export const identity: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  const path = new URL(c.req.url).pathname;
  if (path === '/api/webhooks/plaid' || path.startsWith('/api/auth/')) return next();
  // The server's clock, never an edit's own time: a session's age is not for the phone to say.
  const now = requestNow(c);
  const who = await identify(c.req.raw, c.env, now);
  if (!who) return c.json({ error: 'unauthenticated', message: 'Sign in again with your passkey.' }, 401);
  if (who.kind === 'ops') {
    // The ops token reaches only the health endpoint.
    if (!OPS_PATHS.has(`${c.req.method} ${path}`))
      return c.json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
    c.set('userId', 'service');
    c.set('email', '');
    c.set('sessionId', '');
    const b = await c.env.DB.prepare(`SELECT id FROM budget ORDER BY created_at LIMIT 1`).first<{
      id: string;
    }>();
    c.set('budgetId', b?.id ?? '');
    return next();
  }
  if (needsRecentPasskey(c.req.method, path) && now - who.verifiedAt > REAUTH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey, then try again.' }, 401);
  const m = await membership(c.env.DB, who.userId);
  if (!m) return c.json({ error: 'forbidden', message: 'You don’t have access to this budget.' }, 403);
  c.set('sessionId', who.sessionId ?? '');
  c.set('userId', m.userId);
  c.set('email', m.email);
  c.set('budgetId', m.budgetId);
  c.set('isAdmin', m.isAdmin);
  return next();
};

/** The id Settings shows for a sign-in: a hash of the stored hash, so the stored id (the cookie's hash) never leaves. */
const signInId = async (sessionId: string) => (await tokenHash(`sign-in:${sessionId}`)).slice(0, 24);
/** The id of a signed-out device that still has a saved copy (it has no sign-in right now). */
const copyId = async (deviceId: string) => (await tokenHash(`copy:${deviceId}`)).slice(0, 24);

type DB = AppEnv['Bindings']['DB'];

/** This user's unexpired sign-ins, newest first. */
async function signIns(db: DB, userId: string, now: number) {
  return (
    await db
      .prepare(
        `SELECT id, created_at, user_agent FROM auth_session WHERE expires_at > ?1 AND user_id = ?2 ORDER BY created_at DESC`,
      )
      .bind(now, userId)
      .all<{ id: string; created_at: number; user_agent: string | null }>()
  ).results;
}

interface Entry {
  id: string;
  name: string;
  signedInAt: number;
  current: boolean;
  /** Its server session, when it has one (a signed-out device with a saved copy doesn't). */
  sessionId: string | null;
  /** The saved copies on it (decisions.md D-45): signing it out turns them off, so the phone deletes them. */
  deviceIds: string[];
}

/**
 * Every sign-in, and every signed-out device that still has a saved copy (it counts for "Sign out other devices").
 * A device that's open now is one entry (its copy last opened with that sign-in, `device.session_id`).
 */
async function entries(db: DB, userId: string, sessionId: string, now: number): Promise<Entry[]> {
  const sessions = await signIns(db, userId, now);
  const devices = (
    await db
      .prepare(
        `SELECT id, name, session_id, created_at, last_seen_at FROM device WHERE user_id = ?1 AND revoked_at IS NULL`,
      )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        session_id: string | null;
        created_at: number;
        last_seen_at: number | null;
      }>()
  ).results;
  const live = new Set(sessions.map((s) => s.id));
  const out: Entry[] = [
    ...(await Promise.all(
      sessions.map(async (s) => ({
        id: await signInId(s.id),
        name: describeAgent(s.user_agent),
        signedInAt: s.created_at,
        current: s.id === sessionId,
        sessionId: s.id,
        deviceIds: devices.filter((d) => d.session_id === s.id).map((d) => d.id),
      })),
    )),
    ...(await Promise.all(
      devices
        .filter((d) => !d.session_id || !live.has(d.session_id))
        .map(async (d) => ({
          id: await copyId(d.id),
          name: d.name,
          signedInAt: d.last_seen_at ?? d.created_at,
          current: false,
          sessionId: null,
          deviceIds: [d.id],
        })),
    )),
  ];
  return out.sort((a, b) => b.signedInAt - a.signedInAt);
}

/** Turns saved copies off: the server forgets their share, so each phone deletes its copy when it next connects. */
const turnOff = (db: DB, userId: string, ids: string[], now: number) =>
  ids.map((id) =>
    db
      .prepare(
        `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL WHERE id = ?1 AND user_id = ?2`,
      )
      .bind(id, userId, now),
  );

securityRoutes.get('/settings/security', async (c) => {
  const now = requestNow(c);
  // A passkey made on a new device also signs that device in (add a device, sign-up, recovery) with no separate
  // sign-in, so its last use is the later of its own sign-ins and the sessions it started.
  const pk = await c.env.DB.prepare(
    `SELECT p.id, p.name, p.created_at,
            max(coalesce(p.last_used_at, 0),
                coalesce((SELECT max(s.created_at) FROM auth_session s WHERE s.passkey_id = p.id), 0)) AS last_used_at
     FROM passkey p WHERE p.user_id = ?1 ORDER BY p.created_at`,
  )
    .bind(c.get('userId'))
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  const list = await entries(c.env.DB, c.get('userId'), c.get('sessionId'), now);
  const admin = await c.env.DB.prepare(`SELECT is_admin FROM user WHERE id = ?1`)
    .bind(c.get('userId'))
    .first<number>('is_admin');
  return c.json({
    // Users who aren't admins can delete their own account (D-75).
    ownAccount: admin === 0,
    // Settings → Users, for admins once there is anyone else or sign-up is on (routes/people.ts).
    usersScreen:
      admin === 1 &&
      (signupSwitchOn(c.env) ||
        ((await c.env.DB.prepare(`SELECT count(*) AS n FROM user`).first<number>('n')) ?? 0) > 1),
    passkeys: pk.results.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).toISOString(),
      lastUsedAt: p.last_used_at ? new Date(p.last_used_at).toISOString() : null,
    })),
    sessions: list.filter((x) => x.sessionId).length,
    otherSessions: list.filter((x) => !x.current).length,
    // Only live sign-ins are listed; a signed-out device's saved copy goes with "Sign out other devices".
    signIns: list
      .filter((x) => x.sessionId)
      .map((x) => ({
        id: x.id,
        name: x.name,
        signedInAt: new Date(x.signedInAt).toISOString(),
        current: x.current,
        saved: x.deviceIds.length > 0,
      })),
  });
});

// ---- A phone's saved copy (docs/phone-budget.md 13.2, decisions.md D-45). Its key needs the user's passkey and
// this server-held share, so signing the phone out (which forgets the share) stops it opening its copy: it deletes
// the copy the next time it connects. These routes need a passkey check within 15 minutes (opening the copy online
// is always a fresh sign-in).

securityRoutes.post('/settings/security/devices', async (c) => {
  const body = (await bodyObject(c.req)) as { name?: unknown };
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Phone';
  const now = requestNow(c);
  const m = await c.env.DB.prepare(`SELECT budget_id FROM budget_member WHERE user_id = ?1 LIMIT 1`)
    .bind(c.get('userId'))
    .first<{ budget_id: string }>();
  if (!m) return c.json({ error: 'not_member', message: 'You don’t have access to this budget.' }, 403);
  const id = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const share = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
  await c.env.DB.batch([
    // A copy this sign-in opened before (one the phone couldn't read) is replaced by this one.
    c.env.DB.prepare(
      `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL WHERE session_id = ?1 AND user_id = ?2`,
    ).bind(c.get('sessionId'), c.get('userId'), now),
    c.env.DB.prepare(
      `INSERT INTO device (id, user_id, budget_id, name, share, created_at, last_seen_at, session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)`,
    ).bind(id, c.get('userId'), m.budget_id, name, share, now, c.get('sessionId')),
  ]);
  return c.json({ id, share });
});

securityRoutes.post('/settings/security/devices/:id/share', async (c) => {
  const d = await c.env.DB.prepare(`SELECT share, revoked_at FROM device WHERE id = ?1 AND user_id = ?2`)
    .bind(c.req.param('id'), c.get('userId'))
    .first<{ share: string | null; revoked_at: number | null }>();
  if (!d || d.revoked_at !== null || !d.share)
    return c.json(
      { error: 'revoked', message: 'This device was signed out, so its saved budget was deleted.' },
      410,
    );
  await c.env.DB.prepare(`UPDATE device SET last_seen_at = ?2, session_id = ?3 WHERE id = ?1`)
    .bind(c.req.param('id'), requestNow(c), c.get('sessionId'))
    .run();
  return c.json({ id: c.req.param('id'), share: d.share });
});

/** A single-use link, valid for 10 minutes, that lets another phone or computer add its own passkey. */
securityRoutes.post('/settings/security/device-link', async (c) => {
  const now = requestNow(c);
  const token = randomToken();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM device_link WHERE expires_at <= ?1`).bind(now),
    c.env.DB.prepare(
      `INSERT INTO device_link (token_hash, created_at, expires_at, user_id) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(await tokenHash(token), now, now + DEVICE_LINK_MS, c.get('userId')),
  ]);
  const origin = new URL(c.req.url).origin;
  return c.json({
    url: `${origin}/add-device#${token}`,
    expiresAt: new Date(now + DEVICE_LINK_MS).toISOString(),
  });
});

/** Renames a passkey, so you can tell where it is saved ("Apple Passwords"). 1 to 60 characters. */
securityRoutes.post('/settings/security/passkeys/:id/rename', async (c) => {
  const body = (await bodyObject(c.req)) as { name?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60)
    return c.json({ error: 'invalid', message: 'Give the passkey a name of up to 60 characters.' }, 400);
  const r = await c.env.DB.prepare(`UPDATE passkey SET name = ?3 WHERE id = ?1 AND user_id = ?2`)
    .bind(c.req.param('id'), c.get('userId'), name)
    .run();
  if (r.changes !== 1) return c.json({ error: 'not_found', message: 'That passkey was removed.' }, 404);
  return c.json({ ok: true });
});

securityRoutes.post('/settings/security/passkeys/:id/remove', async (c) => {
  const id = c.req.param('id');
  // Never the last one: you'd be locked out.
  const r = await c.env.DB.prepare(
    `DELETE FROM passkey WHERE id = ?1 AND user_id = ?2 AND (SELECT count(*) FROM passkey WHERE user_id = ?2) > 1`,
  )
    .bind(id, c.get('userId'))
    .run();
  if (r.changes !== 1)
    return c.json({ error: 'last_passkey', message: 'You can’t remove your only passkey.' }, 409);
  return c.json({ ok: true });
});

/** Signs out everywhere else: other sign-ins end, and other phones' saved copies are turned off. */
securityRoutes.post('/settings/security/sign-out-others', async (c) => {
  const db = c.env.DB;
  const userId = c.get('userId');
  const r = await db
    .prepare(`DELETE FROM auth_session WHERE id != ?1 AND user_id = ?2`)
    .bind(c.get('sessionId'), userId)
    .run();
  await db
    .prepare(
      `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL
       WHERE user_id = ?1 AND revoked_at IS NULL AND (session_id IS NULL OR session_id != ?2)`,
    )
    .bind(userId, c.get('sessionId'), requestNow(c))
    .run();
  return c.json({ ok: true, ended: r.changes });
});

/** Signs out one other device, by the id Settings shows: its sign-in ends and its saved copy is turned off. */
securityRoutes.post('/settings/security/sign-out-session', async (c) => {
  const body = (await bodyObject(c.req)) as { id?: unknown };
  const db = c.env.DB;
  const userId = c.get('userId');
  const now = requestNow(c);
  const target = (await entries(db, userId, c.get('sessionId'), now)).find(
    (x) => x.id === body.id && !x.current,
  );
  if (!target) return c.json({ error: 'not_found', message: 'That device is already signed out.' }, 404);
  // The copy goes first: the session ending alone would let the phone open its copy with Face ID again.
  await db.batch([
    ...turnOff(db, userId, target.deviceIds, now),
    ...(target.sessionId
      ? [db.prepare(`DELETE FROM auth_session WHERE id = ?1 AND user_id = ?2`).bind(target.sessionId, userId)]
      : []),
  ]);
  return c.json({ ok: true });
});

/**
 * Ends this sign-in. 10 idle minutes end it too and keep the device's saved copy. Sign out of this device sends
 * `forget` (and the phone's copies, `devices`) after the phone has deleted them, so the server forgets their shares
 * as well.
 */
securityRoutes.post('/settings/security/sign-out', async (c) => {
  const body = (await bodyObject(c.req)) as { forget?: unknown; devices?: unknown };
  const db = c.env.DB;
  const userId = c.get('userId');
  const now = requestNow(c);
  const devices = Array.isArray(body.devices)
    ? body.devices.filter((d): d is string => typeof d === 'string').slice(0, 10)
    : [];
  await db.batch([
    ...(body.forget === true
      ? [
          db
            .prepare(
              `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL WHERE session_id = ?1 AND user_id = ?2`,
            )
            .bind(c.get('sessionId'), userId, now),
          ...turnOff(db, userId, devices, now),
        ]
      : []),
    db.prepare(`DELETE FROM auth_session WHERE id = ?1`).bind(c.get('sessionId')),
  ]);
  c.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return c.json({ ok: true });
});
