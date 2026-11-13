// Deleting your own account, and Settings → Users for admins (D-75, docs/open-signup.md 10, 12). Directory routes,
// under /api/settings/security/ so the Worker routes them to the Directory and every change needs a recent passkey
// check (http/auth.ts needsRecentPasskey).
import { Hono } from 'hono';
import type { AppEnv, Ctx } from '../http/context.js';
import { cookie, SESSION_COOKIE } from '../http/auth.js';
import { clock } from '../http/clock.js';
import { bodyObject } from '../http/security.js';
import { maxUsers, signupsPerDay, signupSwitchOn } from './signup-switch.js';
import { startDeletionSql } from '../store/idle-accounts.js';

export const peopleRoutes = new Hono<AppEnv>();

/** Marks a budget being deleted (app_state), so its store may wipe itself and nothing brings it back. */
export const deletingKey = (budgetId: string) => `deleting:${budgetId}`;

const PAGE = 50;

const notFound = { error: 'not_found', message: 'Not found.' };

/** The signed-in user's admin flag and budget. */
async function me(c: Ctx) {
  return c.env.DB.prepare(
    `SELECT u.id, u.is_admin, m.budget_id FROM user u LEFT JOIN budget_member m ON m.user_id = u.id WHERE u.id = ?1`,
  )
    .bind(c.get('userId'))
    .first<{ id: string; is_admin: number; budget_id: string | null }>();
}

const log = (action: string, target: string) =>
  console.log(JSON.stringify({ event: 'admin_action', action, target }));

// ---- Delete account (your own; never an admin's)

peopleRoutes.post('/settings/security/delete-account', async (c) => {
  const env = c.env;
  const now = clock(env);
  const b = (await bodyObject(c.req)) as { budgetName?: unknown };
  const u = await me(c);
  if (!u?.budget_id) return c.json(notFound, 404);
  if (u.is_admin === 1)
    return c.json({ error: 'admin', message: 'The admin’s account can’t be deleted.' }, 409);
  const store = env.BUDGET_INFO ? await env.BUDGET_INFO(u.budget_id) : null;
  // A sealed budget's name is on its devices only: the app checks what was typed (docs/privacy.md 5.8).
  if (
    !store ||
    typeof b.budgetName !== 'string' ||
    (!store.sealed && b.budgetName.trim() !== store.name.trim())
  )
    return c.json({ error: 'name', message: 'Type your budget’s name as it’s shown.' }, 400);
  // Its banks are removed at Plaid first (the delete job). On Plaid Trial only the admin links banks, and no job
  // removes a link there (store/account-life.ts removeBanks).
  if (store.banks > 0 && env.PLAID_ENV === 'production' && env.OTHER_USERS_BANKS !== 'on')
    return c.json({ error: 'banks', message: 'An account with linked banks can’t be deleted yet.' }, 409);
  const id = u.id;
  const budgetId = u.budget_id;
  await env.DB.batch(startDeletionSql(budgetId, [id], now).map(([q, p]) => env.DB.prepare(q).bind(...p)));
  await env.DELETE_ACCOUNT?.(id, budgetId);
  c.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
  return c.json({ ok: true });
});

// ---- Settings → Users (admins)

/** Admins only; others get 404, as if the route didn't exist. */
async function admin(c: Ctx): Promise<boolean> {
  return (await me(c))?.is_admin === 1;
}

peopleRoutes.get('/settings/security/users', async (c) => {
  if (!(await admin(c))) return c.json(notFound, 404);
  const env = c.env;
  const now = clock(env);
  const before = Number(c.req.query('before') ?? '') || Number.MAX_SAFE_INTEGER;
  const status = c.req.query('status');
  const day = new Date(now);
  const today = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const counts = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM user) AS users, (SELECT count(*) FROM user WHERE created_at >= ?1) AS today`,
  )
    .bind(today)
    .first<{ users: number; today: number }>();
  const rows = await env.DB.prepare(
    `SELECT u.id, u.display_name, u.is_admin, u.status, u.created_at, u.last_seen_at,
       EXISTS (SELECT 1 FROM job j WHERE j.id = 'delete_account:' || u.id AND j.failed_at IS NOT NULL) AS stuck
     FROM user u WHERE u.created_at < ?1 AND (?2 IS NULL OR u.status = ?2)
     ORDER BY u.created_at DESC LIMIT ?3`,
  )
    .bind(before, status ?? null, PAGE + 1)
    .all<{
      id: string;
      display_name: string | null;
      is_admin: number;
      status: string;
      created_at: number;
      last_seen_at: number | null;
      stuck: number;
    }>();
  const list = rows.results.slice(0, PAGE);
  return c.json({
    users: counts?.users ?? 0,
    maxUsers: maxUsers(env),
    signupsToday: counts?.today ?? 0,
    signupsPerDay: signupsPerDay(env),
    signupsOpen: signupSwitchOn(env),
    list: list.map((u) => ({
      id: u.id,
      // Sign-up asks for no name (D-85): an account is told apart by the day it joined, which the list shows.
      name: u.display_name ?? (u.is_admin ? 'Admin' : 'Account'),
      admin: u.is_admin === 1,
      status: u.status,
      joinedAt: new Date(u.created_at).toISOString(),
      lastSeenAt: u.last_seen_at ? new Date(u.last_seen_at).toISOString() : null,
      stuck: u.stuck === 1,
    })),
    next: rows.results.length > PAGE ? String(list[list.length - 1]!.created_at) : null,
  });
});

/** Turn an account off (signed out everywhere, its bank syncs stop) or on again. Never an admin. */
for (const [action, on] of [
  ['turn-off', false],
  ['turn-on', true],
] as const)
  peopleRoutes.post(`/settings/security/users/:id/${action}`, async (c) => {
    if (!(await admin(c))) return c.json(notFound, 404);
    const env = c.env;
    const id = c.req.param('id');
    const t = await env.DB.prepare(
      `SELECT u.is_admin, u.status, m.budget_id FROM user u LEFT JOIN budget_member m ON m.user_id = u.id WHERE u.id = ?1`,
    )
      .bind(id)
      .first<{ is_admin: number; status: string; budget_id: string | null }>();
    if (!t || t.is_admin === 1 || t.status === 'deleting') return c.json(notFound, 404);
    const now = clock(env);
    await env.DB.batch([
      env.DB.prepare(`UPDATE user SET status = ?2, updated_at = ?3 WHERE id = ?1`).bind(
        id,
        on ? 'active' : 'disabled',
        now,
      ),
      ...(on ? [] : [env.DB.prepare(`DELETE FROM auth_session WHERE user_id = ?1`).bind(id)]),
    ]);
    if (t.budget_id) await env.SET_DISABLED?.(t.budget_id, !on);
    log(action, id);
    return c.json({ ok: true });
  });

/** A deletion that stopped (its job failed 6 times): try it again. */
peopleRoutes.post('/settings/security/users/:id/retry-delete', async (c) => {
  if (!(await admin(c))) return c.json(notFound, 404);
  const id = c.req.param('id');
  const key = await c.env.DB.prepare(`SELECT key FROM app_state WHERE key LIKE 'deleting:%' AND value = ?1`)
    .bind(id)
    .first<string>('key');
  if (!key) return c.json(notFound, 404);
  await c.env.DELETE_ACCOUNT?.(id, key.slice('deleting:'.length));
  log('retry-delete', id);
  return c.json({ ok: true });
});
