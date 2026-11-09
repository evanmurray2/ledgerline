// Transport and browser controls for API responses. The web app's own headers (CSP etc.) come from
// apps/web/public/_headers, which Cloudflare applies to static files before the Worker runs.
import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER } from '@ledgerline/contracts';

export const apiHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  // Nothing the API answers is stored by the browser.
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  h.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  h.set('x-frame-options', 'DENY');
};

/** The Plaid webhook: a server-to-server call, proven by Plaid's signature instead (routes/ops.ts). */
export const WEBHOOK_PATH = '/api/webhooks/plaid';

/** CSRF: mutations need a JSON content type, the custom header and a same-origin Origin. */
export const csrf: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  // Plaid never sends the app's header; its signed JWT is checked before anything runs.
  if (m === 'POST' && new URL(c.req.url).pathname === WEBHOOK_PATH) return next();
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json'))
    return c.json({ error: 'csrf', message: 'Something went wrong. Try again.' }, 415);
  if (c.req.header(CSRF_HEADER) !== '1')
    return c.json({ error: 'csrf', message: 'Something went wrong. Try again.' }, 403);
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin)
    return c.json({ error: 'csrf', message: 'Something went wrong. Try again.' }, 403);
  return next();
};

/** A request's JSON body as an object: {} when it is missing, broken or not an object (`null`, a number, a list). */
export async function bodyObject(req: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  const b: unknown = await req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}
