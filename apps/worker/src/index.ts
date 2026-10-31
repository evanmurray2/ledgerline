import { Hono } from 'hono';
import type { Env } from './env.js';
import { measure } from './measure/routes.js';
export { SyncWorkflow } from './sync/workflow.js';
export { MaintenanceWorkflow } from './maintenance.js';

const app = new Hono<{ Bindings: Env }>();
app.use('/__measure/*', async (c, next) => {
  if (c.env.MEASURE !== '1' || c.env.PLAID_ENV === 'production') return c.notFound();
  await next();
});
app.route('/__measure', measure);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
