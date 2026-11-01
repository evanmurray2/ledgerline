import { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppEnv } from './http/context.js';
import { apiHeaders } from './http/security.js';
import { api } from './routes/api.js';
import { measure } from './measure/routes.js';
import { dev } from './measure/dev.js';
import { scheduled } from './cron.js';
export { SyncWorkflow } from './sync/workflow.js';
export { MaintenanceWorkflow } from './maintenance.js';
export { RecomputeWorkflow } from './budget/workflow.js';

const app = new Hono<AppEnv>();
app.use('/api/*', apiHeaders);
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
  scheduled: (controller, env, ctx) => ctx.waitUntil(scheduled(controller, env)),
} satisfies ExportedHandler<Env>;
