// Settings → Sign-in: your passkeys, links for adding a device, and signing out (decisions.md D-27). Changes here
// need a passkey check within the last 15 minutes (http/auth.ts needsRecentPasskey).
import { Hono } from 'hono';
import type { AppEnv } from '../http/context.js';
import { clock } from '../http/clock.js';
import { DEVICE_LINK_MS, SESSION_COOKIE, cookie, randomToken, tokenHash } from '../http/auth.js';

export const securityRoutes = new Hono<AppEnv>();

securityRoutes.get('/settings/security', async (c) => {
  const now = clock(c.env);
  const [pk, ss] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, name, created_at, last_used_at FROM passkey WHERE user_id = ?1 ORDER BY created_at`,
    ).bind(c.get('userId')),
    c.env.DB.prepare(`SELECT count(*) AS n FROM auth_session WHERE expires_at > ?1 AND user_id = ?2`).bind(
      now,
      c.get('userId'),
    ),
  ]);
  return c.json({
    passkeys: (
      pk!.results as { id: string; name: string; created_at: number; last_used_at: number | null }[]
    ).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: new Date(p.created_at).toISOString(),
      lastUsedAt: p.last_used_at ? new Date(p.last_used_at).toISOString() : null,
    })),
    sessions: (ss!.results[0] as { n: number } | undefined)?.n ?? 0,
  });
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
  return c.json({ ok: true, ended: r.meta.changes });
});

securityRoutes.post('/settings/security/sign-out', async (c) => {
  await c.env.DB.prepare(`DELETE FROM auth_session WHERE id = ?1`).bind(c.get('sessionId')).run();
  c.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return c.json({ ok: true });
});
