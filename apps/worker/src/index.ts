import { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppEnv } from './http/context.js';
import { apiHeaders } from './http/security.js';
import { api } from './routes/api.js';
import { measure } from './measure/routes.js';
import { dev } from './measure/dev.js';
import { CRON_MAINTENANCE, scheduled } from './cron.js';
import { DIRECTORY_NAME } from './store/directory.js';
import { objectsServe, resetRoutingCache, routeApi, servingPhase } from './store/router.js';
import { REAUTH_MS, identify } from './http/auth.js';
import { csrf } from './http/security.js';
import { MOVING, queueWebhook, readOnlyD1 } from './store/frozen.js';
import { makeProvider } from './sync/provider.js';
export { SyncWorkflow } from './sync/workflow.js';
export { MaintenanceWorkflow } from './maintenance.js';
export { RecomputeWorkflow } from './budget/workflow.js';
export { BudgetStore } from './store/budget-store.js';
export { Directory } from './store/directory.js';

const app = new Hono<AppEnv>();
app.use('/api/*', apiHeaders);
// Sign-in attempts per IP, on both paths (D1 now, the Directory after the move). Requests without a client IP only
// come from local runs and tests.
app.use('/api/auth/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip');
  if (ip && c.env.AUTH_LIMITER && !(await c.env.AUTH_LIMITER.limit({ key: `auth:${ip}` })).success)
    return c.json({ error: 'rate_limited', message: 'Too many tries. Wait a minute and try again.' }, 429);
  return next();
});
// After the move (docs/multi-user.md 8.5), the Directory and each budget's Durable Object serve the API.
// Starting the move and watching it (docs/multi-user.md 8.1): the owner (admin) only; starting needs a passkey
// check in the last 15 minutes, no move already under way, and no bank sync holding a lease.
const MOVE_LEASE_MS = 30 * 60_000;
app.on(['GET', 'POST'], '/api/move', csrf, async (c) => {
  const env = c.env;
  const now = Date.now();
  const phase = await servingPhase(env, now);
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
  if (phase === 'moved' || phase === 'restoring') {
    const a = await dir.authenticate(c.req.header('cookie') ?? null, 'GET', '/api/move');
    if (!a.ok) return c.json(a.body, a.status);
    if (!(await dir.isAdmin(a.caller.userId)))
      return c.json({ error: 'forbidden', message: 'Only the owner can move the data' }, 403);
    return c.json({ phase, status: await dir.moveStatus() });
  }
  const who = await identify(c.req.raw, env, now);
  if (!who || who.kind !== 'user')
    return c.json({ error: 'unauthenticated', message: 'Sign in with your passkey' }, 401);
  const admin = await env.DB.prepare(`SELECT is_admin FROM user WHERE id = ?1`)
    .bind(who.userId)
    .first<number>('is_admin');
  if (admin !== 1) return c.json({ error: 'forbidden', message: 'Only the owner can move the data' }, 403);
  // The last move's status stays readable after it ends, so a failure's reason is still on screen.
  if (c.req.method === 'GET') return c.json({ phase, status: await dir.moveStatus() });
  if (now - who.verifiedAt > REAUTH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
  if (phase !== 'none') return c.json({ error: 'busy', message: 'A move is already under way' }, 409);
  const syncing = await env.DB.prepare(
    `SELECT count(*) AS n FROM connection WHERE sync_lock IS NOT NULL AND lock_expires > ?1`,
  )
    .bind(now)
    .first<number>('n');
  if (syncing)
    return c.json({ error: 'busy', message: 'A bank sync is running. Try again in a few minutes.' }, 409);
  const r = await env.DB.prepare(
    `UPDATE move_state SET phase = 'frozen', started_at = ?1, lease_expires = ?2, updated_at = ?1 WHERE id = 1 AND phase = 'none'`,
  )
    .bind(now, now + MOVE_LEASE_MS)
    .run();
  if (r.meta.changes !== 1) return c.json({ error: 'busy', message: 'A move is already under way' }, 409);
  resetRoutingCache();
  const started = await dir.resetForMove().catch((e: unknown) => ({ ok: false as const, reason: String(e) }));
  if (!started.ok) {
    await env.DB.prepare(
      `UPDATE move_state SET phase = 'none', updated_at = ?1 WHERE id = 1 AND phase = 'frozen'`,
    )
      .bind(Date.now())
      .run();
    resetRoutingCache();
    return c.json({ error: 'move_failed', message: started.reason }, 500);
  }
  return c.json({ phase: 'frozen', status: await dir.moveStatus() }, 202);
});

// The way back (docs/multi-user.md 8.6): copies everything from the new databases, including every change made
// after the move, into D1, verifies it, and switches back. The owner only, with a fresh passkey check; one budget.
app.post('/api/move/back', csrf, async (c) => {
  const env = c.env;
  const now = Date.now();
  if ((await servingPhase(env, now)) !== 'moved')
    return c.json({ error: 'busy', message: 'The data isn’t on the new databases' }, 409);
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
  const a = await dir.authenticate(c.req.header('cookie') ?? null, 'POST', '/api/move/back');
  if (!a.ok) return c.json(a.body, a.status);
  if (!(await dir.isAdmin(a.caller.userId)))
    return c.json({ error: 'forbidden', message: 'Only the owner can move the data' }, 403);
  if (now - a.caller.verifiedAt > REAUTH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
  if ((await dir.budgetCount()) !== 1)
    return c.json({ error: 'not_supported', message: 'The way back to D1 works for one budget only' }, 409);
  const r = await env.DB.prepare(
    `UPDATE move_state SET phase = 'restoring', started_at = ?1, lease_expires = ?2, updated_at = ?1 WHERE id = 1 AND phase = 'moved'`,
  )
    .bind(now, now + MOVE_LEASE_MS)
    .run();
  if (r.meta.changes !== 1) return c.json({ error: 'busy', message: 'Something else is under way' }, 409);
  resetRoutingCache();
  const started = await dir.startMoveOut().catch((e: unknown) => ({ ok: false as const, reason: String(e) }));
  if (!started.ok) {
    await env.DB.prepare(
      `UPDATE move_state SET phase = 'moved', updated_at = ?1 WHERE id = 1 AND phase = 'restoring'`,
    )
      .bind(Date.now())
      .run();
    resetRoutingCache();
    return c.json({ error: 'move_failed', message: started.reason }, 500);
  }
  return c.json({ phase: 'restoring', status: await dir.moveStatus() }, 202);
});

// During the move (docs/multi-user.md 8.2): screens read-only, edits and sign-ins answer "moving", Plaid webhooks
// wait in move_queue. D1's triggers refuse writes anyway; this turns that into answers instead of errors.
const frozenApp = new Hono<AppEnv>();
frozenApp.route('/api', api);
app.use('/api/*', async (c, next) => {
  const phase = await servingPhase(c.env);
  if (phase !== 'frozen' && phase !== 'restoring') return next();
  const path = new URL(c.req.url).pathname;
  // The way back: the new databases hold the current data, so they serve, read-only, while D1 is refilled.
  if (phase === 'restoring' && path !== '/api/webhooks/plaid') {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json(MOVING, 503);
    const r = await routeApi(c.req.raw, c.env, { frozen: true });
    return new Response(r.body, r);
  }
  if (path === '/api/webhooks/plaid') {
    const ev = await makeProvider(c.env)
      .verifyWebhook(c.req.raw)
      .catch(() => null);
    if (!ev) return c.json({ error: 'unauthorized' }, 401);
    if (ev.providerItemId) await queueWebhook(c.env, ev.providerItemId, ev.type, ev.code ?? null, Date.now());
    return c.json({ ok: true });
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json(MOVING, 503);
  return frozenApp.fetch(c.req.raw, { ...c.env, DB: readOnlyD1(c.env.DB), MOVING: '1' }, c.executionCtx);
});
app.use('/api/*', async (c, next) => {
  if (await objectsServe(c.env)) {
    // Responses from another object have immutable headers; copy so apiHeaders can add its own.
    const r = await routeApi(c.req.raw, c.env);
    return new Response(r.body, r);
  }
  return next();
});
app.route('/api', api);
// Local measurement and seed routes: never in production, and only when explicitly enabled.
app.use('/__measure/*', async (c, next) => {
  if (c.env.MEASURE !== '1' || c.env.PLAID_ENV === 'production') return c.notFound();
  await next();
});
app.route('/__measure', measure as never);
app.use('/__dev/*', async (c, next) => {
  if (c.env.DEV_ROUTES !== '1' || c.env.PLAID_ENV === 'production' || c.env.SETUP_CODE) return c.notFound();
  await next();
});
app.route('/__dev', dev);
// Everything else is the SPA (static assets with SPA fallback).
app.all('*', (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

export default {
  fetch: app.fetch,
  scheduled: (controller, env, ctx) =>
    ctx.waitUntil(
      (async () => {
        // After the move each budget runs its own schedule on alarms; the daily trigger only wakes the Directory,
        // which refreshes usage and checks every budget's jobs (docs/multi-user.md 6.2).
        const phase = await servingPhase(env);
        if (phase === 'moved') {
          if (controller.cron === CRON_MAINTENANCE)
            await env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME)).daily();
          return;
        }
        // Nothing scheduled runs while the move is copying or the way back is restoring.
        if (phase !== 'none') return;
        await scheduled(controller, env);
      })(),
    ),
} satisfies ExportedHandler<Env>;
