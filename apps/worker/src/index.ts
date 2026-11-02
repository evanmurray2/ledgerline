import { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppEnv } from './http/context.js';
import { apiHeaders } from './http/security.js';
import { api } from './routes/api.js';
import { measure } from './measure/routes.js';
import { dev } from './measure/dev.js';
import { CRON_MAINTENANCE, scheduled } from './cron.js';
import { DIRECTORY_NAME } from './store/directory.js';
import { objectsServe, routeApi } from './store/router.js';
export { SyncWorkflow } from './sync/workflow.js';
export { MaintenanceWorkflow } from './maintenance.js';
export { RecomputeWorkflow } from './budget/workflow.js';
export { BudgetStore } from './store/budget-store.js';
export { Directory } from './store/directory.js';

/** The answer when the Durable Objects can't be reached (docs/multi-user.md 9.2, decisions.md D-37). */
export function storeUnavailable(error: string): { error: string; message: string } {
  return /exceed|limit|quota|free tier/i.test(error)
    ? {
        error: 'daily_limit',
        message:
          'Cloudflare’s free daily limit is used up. Your data is safe. Ledgerline is back after midnight UTC.',
      }
    : {
        error: 'unavailable',
        message: 'Ledgerline can’t reach your data right now. Your data is safe. Try again soon.',
      };
}

const app = new Hono<AppEnv>();
app.use('/api/*', apiHeaders);
// Sign-in attempts per IP. Requests without a client IP only come from local runs and tests.
app.use('/api/auth/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip');
  if (ip && c.env.AUTH_LIMITER && !(await c.env.AUTH_LIMITER.limit({ key: `auth:${ip}` })).success)
    return c.json({ error: 'rate_limited', message: 'Too many tries. Wait a minute and try again.' }, 429);
  return next();
});
// The Directory and each budget's Durable Object serve the API (docs/multi-user.md 5.1). Production has no D1;
// the D1 path below is only for local dev and tests (wrangler.local.jsonc).
app.use('/api/*', async (c, next) => {
  if (await objectsServe(c.env)) {
    let r: Response;
    try {
      r = await routeApi(c.req.raw, c.env);
    } catch (e) {
      // The Directory or the budget's store couldn't be reached. On Free that is almost always the daily Durable
      // Object allowance running out (Nov 2, 2026): say so plainly instead of a bare 500. Nothing is lost.
      const text = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ event: 'store_unreachable', error: text }));
      return c.json(storeUnavailable(text), 503);
    }
    // Responses from another object have immutable headers; copy so apiHeaders can add its own.
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
        // Each budget runs its own schedule on alarms; the daily trigger only wakes the Directory, which refreshes
        // usage and checks every budget's jobs (docs/multi-user.md 6.2). The D1 crons are for local runs only.
        if (await objectsServe(env)) {
          if (controller.cron === CRON_MAINTENANCE)
            await env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME)).daily();
          return;
        }
        await scheduled(controller, env);
      })(),
    ),
} satisfies ExportedHandler<Env>;
