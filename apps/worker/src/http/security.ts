// Transport and browser controls for API responses. The SPA's own headers (CSP etc.) come from apps/web/public/_headers.
import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER } from '@ledgerline/contracts';

export const apiHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'no-referrer');
  h.set('cache-control', 'no-store');
  h.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  h.set('x-frame-options', 'DENY');
};

/** CSRF: mutations need a JSON content type, the custom header and a same-origin Origin. */
export const csrf: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  const ct = c.req.header('content-type') ?? '';
  if (!ct.toLowerCase().startsWith('application/json'))
    return c.json({ error: 'csrf', message: 'JSON required' }, 415);
  if (c.req.header(CSRF_HEADER) !== '1') return c.json({ error: 'csrf', message: 'missing header' }, 403);
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin)
    return c.json({ error: 'csrf', message: 'cross-origin' }, 403);
  return next();
};
