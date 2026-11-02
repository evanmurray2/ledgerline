import { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppEnv } from './http/context.js';
import { apiHeaders } from './http/security.js';
import { api } from './routes/api.js';
import { measure } from './measure/routes.js';
import { dev } from './measure/dev.js';
import { CRON_MAINTENANCE, scheduled } from './cron.js';
import { DIRECTORY_NAME } from './store/directory.js';
import { objectsServe, routeApi, servingPhase } from './store/router.js';
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
// During the move (docs/multi-user.md 8.2): screens read-only, edits and sign-ins answer "moving", Plaid webhooks
// wait in move_queue. D1's triggers refuse writes anyway; this turns that into answers instead of errors.
const frozenApp = new Hono<AppEnv>();
frozenApp.route('/api', api);
app.use('/api/*', async (c, next) => {
  const phase = await servingPhase(c.env);
  if (phase !== 'frozen' && phase !== 'restoring') return next();
  const path = new URL(c.req.url).pathname;
  if (path === '/api/webhooks/plaid') {
    const ev = await makeProvider(c.env)
      .verifyWebhook(c.req.raw)
      .catch(() => null);
    if (!ev) return c.json({ error: 'unauthorized' }, 401);
    if (ev.providerItemId) await queueWebhook(c.env, ev.providerItemId, ev.type, Date.now());
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
