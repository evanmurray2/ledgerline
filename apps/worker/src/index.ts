import { parseKeyring, tokenKeyBytes } from '@ledgerline/platform';
import { serverKeys, toHex } from '@ledgerline/seal';
import { Hono } from 'hono';
import type { Env } from './env.js';
import type { AppEnv } from './http/context.js';
import { apiHeaders } from './http/security.js';
import { DIRECTORY_NAME } from './store/directory.js';
import { routeApi, routeDev } from './store/router.js';
export { BudgetStore } from './store/budget-store.js';
export { Directory } from './store/directory.js';

/** The answer when the Durable Objects can't be reached (docs/multi-user.md 9.2, decisions.md D-37). */
export function storeUnavailable(error: string): { error: string; message: string } {
  return /exceed|limit|quota|free tier/i.test(error)
    ? {
        error: 'daily_limit',
        message: 'Paused until the daily limit resets. Nothing is lost.',
      }
    : {
        error: 'unavailable',
        message: 'Ledgerline can’t reach your budget right now. Try again soon.',
      };
}

const app = new Hono<AppEnv>();
app.use('/api/*', apiHeaders);
// Sign-in attempts per IP. Requests without a client IP only come from local runs and tests.
// Checks that try nothing (what the sign-in screen shows, whether a phone was signed out) count separately, so
// opening the app never uses up sign-in attempts.
const AUTH_CHECKS = new Set(['/api/auth/status', '/api/auth/copy-status']);
app.use('/api/auth/*', async (c, next) => {
  const ip = c.req.header('cf-connecting-ip');
  const key = `${AUTH_CHECKS.has(c.req.path) ? 'check' : 'auth'}:${ip}`;
  if (ip && c.env.AUTH_LIMITER && !(await c.env.AUTH_LIMITER.limit({ key })).success)
    return c.json({ error: 'rate_limited', message: 'Too many tries. Wait a minute and try again.' }, 429);
  return next();
});
// The Worker's public run-signing keys (docs/privacy-keys.md 9.1), by key number: what a device checks a bank
// run's signature with. They are public by design: the app is built with the ones it accepts, and this is where a
// release reads them from. No secret is in the answer, and none can be worked out from it.
app.get('/api/run-keys', async (c) => {
  const ring = parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT);
  const keys: { n: number; pub: string }[] = [];
  for (const [n, secret] of Object.entries(ring.keys)) {
    const raw = await tokenKeyBytes(secret);
    try {
      const k = await serverKeys(raw, Number(n));
      keys.push({ n: Number(n), pub: toHex((k.runSign as { pub: Uint8Array }).pub) });
    } finally {
      raw.fill(0);
    }
  }
  return c.json({ current: ring.current, keys }, 200, { 'cache-control': 'public, max-age=3600' });
});
// The Directory and each budget's Durable Object serve the API (docs/multi-user.md 5.1).
app.all('/api/*', async (c) => {
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
});
// Local seed routes, served in the dev user's store: never in production, and only when enabled.
app.all('/__dev/*', async (c) => {
  if (c.env.DEV_ROUTES !== '1' || c.env.PLAID_ENV === 'production' || c.env.SETUP_CODE) return c.notFound();
  return routeDev(c.req.raw, c.env);
});
// Everything else is the SPA (static assets with SPA fallback).
app.all('*', async (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)));

// Only plain functions, classes and the default handler may be exported here: workerd refuses any other export.
export default {
  fetch: app.fetch,
  // Each budget runs its own schedule on alarms; the one cron trigger (wrangler.jsonc, 10:20 UTC) only wakes the
  // Directory, which refreshes usage and checks every budget's jobs (docs/multi-user.md 6.2).
  scheduled: (_controller, env, ctx) =>
    ctx.waitUntil(
      env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME))
        .daily()
        .then(() => undefined),
    ),
} satisfies ExportedHandler<Env>;
