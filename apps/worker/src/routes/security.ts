// Settings → Sign-in: your passkeys, links for adding a device, and signing out (decisions.md D-27). Changes here
// need a passkey check within the last 15 minutes (http/auth.ts needsRecentPasskey).
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import { clock } from '../http/clock.js';
import { DEVICE_LINK_MS, SESSION_COOKIE, cookie, randomToken, tokenHash } from '../http/auth.js';
import { describeAgent } from '../http/agent.js';

export const securityRoutes = new Hono<AppEnv>();

/** The id Settings shows for a sign-in: a hash of the stored hash, so the stored id (the cookie's hash) never leaves. */
const signInId = async (sessionId: string) => (await tokenHash(`sign-in:${sessionId}`)).slice(0, 24);

/** This user's unexpired sign-ins, newest first. */
async function signIns(db: AppEnv['Bindings']['DB'], userId: string, now: number) {
  return (
    await db
      .prepare(
        `SELECT id, created_at, user_agent FROM auth_session WHERE expires_at > ?1 AND user_id = ?2 ORDER BY created_at DESC`,
      )
      .bind(now, userId)
      .all<{ id: string; created_at: number; user_agent: string | null }>()
  ).results;
}

securityRoutes.get('/settings/security', async (c) => {
  const now = clock(c.env);
  const pk = await c.env.DB.prepare(
    `SELECT id, name, created_at, last_used_at FROM passkey WHERE user_id = ?1 ORDER BY created_at`,
  )
    .bind(c.get('userId'))
    .all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  const sessions = await signIns(c.env.DB, c.get('userId'), now);
  return c.json({
    passkeys: pk.results.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).toISOString(),
      lastUsedAt: p.last_used_at ? new Date(p.last_used_at).toISOString() : null,
    })),
    sessions: sessions.length,
    otherSessions: sessions.filter((x) => x.id !== c.get('sessionId')).length,
    signIns: await Promise.all(
      sessions.map(async (x) => ({
        id: await signInId(x.id),
        name: describeAgent(x.user_agent),
        signedInAt: new Date(x.created_at).toISOString(),
        current: x.id === c.get('sessionId'),
      })),
    ),
    devices: (
      await c.env.DB.prepare(
        `SELECT id, name, created_at, last_seen_at, revoked_at FROM device WHERE user_id = ?1 ORDER BY created_at`,
      )
        .bind(c.get('userId'))
        .all<{
          id: string;
          name: string;
          created_at: number;
          last_seen_at: number | null;
          revoked_at: number | null;
        }>()
    ).results.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: new Date(d.created_at).toISOString(),
      lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
      revoked: d.revoked_at !== null,
    })),
  });
});

// ---- Phones with an encrypted copy (docs/phone-budget.md 13.2, decisions.md D-45). Each copy's key needs the
// user's passkey and this server-held share, so revoking a device stops it unlocking its copy again once it
// connects. These routes need a passkey check within 15 minutes (every unlock is a fresh sign-in).

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

securityRoutes.post('/settings/security/devices', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Phone';
  const now = clock(c.env);
  const m = await c.env.DB.prepare(`SELECT budget_id FROM budget_member WHERE user_id = ?1 LIMIT 1`)
    .bind(c.get('userId'))
    .first<{ budget_id: string }>();
  if (!m) return c.json({ error: 'not_member', message: 'Not a member of this budget' }, 403);
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const share = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await c.env.DB.prepare(
    `INSERT INTO device (id, user_id, budget_id, name, share, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(id, c.get('userId'), m.budget_id, name, share, now)
    .run();
  return c.json({ id, share });
});

securityRoutes.post('/settings/security/devices/:id/share', async (c) => {
  const d = await c.env.DB.prepare(`SELECT share, revoked_at FROM device WHERE id = ?1 AND user_id = ?2`)
    .bind(c.req.param('id'), c.get('userId'))
    .first<{ share: string | null; revoked_at: number | null }>();
  if (!d || d.revoked_at !== null || !d.share)
    return c.json(
      { error: 'revoked', message: 'This phone’s copy was turned off. It will download again.' },
      410,
    );
  await c.env.DB.prepare(`UPDATE device SET last_seen_at = ?2 WHERE id = ?1`)
    .bind(c.req.param('id'), clock(c.env))
    .run();
  return c.json({ id: c.req.param('id'), share: d.share });
});

securityRoutes.post('/settings/security/devices/:id/revoke', async (c) => {
  await c.env.DB.prepare(
    `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(c.req.param('id'), c.get('userId'), clock(c.env))
    .run();
  return c.json({ ok: true });
});

/** A single-use link, valid for 10 minutes, that lets another phone or computer add its own passkey. */
securityRoutes.post('/settings/security/device-link', async (c) => {
  const now = clock(c.env);
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

securityRoutes.post('/settings/security/passkeys/:id/remove', async (c) => {
  const id = c.req.param('id');
  // Never the last one: you'd be locked out.
  const r = await c.env.DB.prepare(
    `DELETE FROM passkey WHERE id = ?1 AND user_id = ?2 AND (SELECT count(*) FROM passkey WHERE user_id = ?2) > 1`,
  )
    .bind(id, c.get('userId'))
    .run();
  if (r.meta.changes !== 1)
    return c.json({ error: 'last_passkey', message: 'You can’t remove your only passkey.' }, 409);
  return c.json({ ok: true });
});

/** Ends every other session (other phones and computers sign in again with their passkey). */
securityRoutes.post('/settings/security/sign-out-others', async (c) => {
  const r = await c.env.DB.prepare(`DELETE FROM auth_session WHERE id != ?1 AND user_id = ?2`)
    .bind(c.get('sessionId'), c.get('userId'))
    .run();
  // Every other phone's copy too (D-45): their shares go, so they wipe their copies the next time they connect.
  await c.env.DB.prepare(
    `UPDATE device SET revoked_at = coalesce(revoked_at, ?3), share = NULL WHERE user_id = ?1 AND id IS NOT ?2`,
  )
    .bind(c.get('userId'), c.req.header('x-device-id') ?? null, clock(c.env))
    .run();
  return c.json({ ok: true, ended: r.meta.changes });
});

/** Ends one other sign-in, by the id Settings shows. This one ends with Sign out instead. */
securityRoutes.post('/settings/security/sign-out-session', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const sessions = await signIns(c.env.DB, c.get('userId'), clock(c.env));
  let target: string | undefined;
  for (const x of sessions) if ((await signInId(x.id)) === body.id) target = x.id;
  if (!target || target === c.get('sessionId'))
    return c.json({ error: 'not_found', message: 'That sign-in has already ended.' }, 404);
  await c.env.DB.prepare(`DELETE FROM auth_session WHERE id = ?1 AND user_id = ?2`)
    .bind(target, c.get('userId'))
    .run();
  return c.json({ ok: true });
});

securityRoutes.post('/settings/security/sign-out', async (c) => {
  await c.env.DB.prepare(`DELETE FROM auth_session WHERE id = ?1`).bind(c.get('sessionId')).run();
  c.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return c.json({ ok: true });
});
