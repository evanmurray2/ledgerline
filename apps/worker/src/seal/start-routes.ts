// The routes of a new budget's start (seal/start.ts, D-102). The store mounts them only for a budget that is not
// sealed. They answer only to the budget's own signed-in person, minutes after a passkey check.
import { CSRF_HEADER } from '@ledgerline/contracts';
import { parseKeyring } from '@ledgerline/platform';
import { Hono } from 'hono';
import { z } from 'zod';
import { REAUTH_MS } from '../http/auth.js';
import { requestNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import type { Caller } from '../store/directory.js';
import { runDeps } from './runs.js';
import { OLD_START, startBegin, startChunk, startSeal, type StartDeps } from './start.js';

const TRY_AGAIN = 'Something went wrong. Try again.';
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const Begin = z.object({
  genesis: z.string().regex(B64).max(200_000),
  header: z.string().regex(B64).max(2_000),
  signature: z.string().regex(B64).max(200),
  manifest: z.string().regex(B64).max(600_000),
  chunks: z.number().int().min(1).max(256),
});

export const startApi = new Hono<AppEnv>();
// Every answer says the server's time: a device dates its entries by the server's clock as it last saw it.
startApi.use('*', async (c, next) => {
  await next();
  c.header('x-ledgerline-time', String(requestNow(c)));
});

startApi.use('*', async (c, next) => {
  // A person, signed in, who used their passkey minutes ago: not the ops token, not a job.
  const who = (c.env as typeof c.env & { CALLER?: Caller }).CALLER;
  if (!who || who.userId === 'system' || who.userId === 'service')
    return c.json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
  if (c.req.path.endsWith('/start/begin') && requestNow(c) - who.verifiedAt > REAUTH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey, then try again.' }, 401);
  // The same guard as every write; a chunk is sealed bytes (see seal/log-routes.ts).
  const chunk =
    c.req.method === 'PUT' &&
    (c.req.header('content-type') ?? '').toLowerCase().startsWith('application/octet-stream');
  if (!chunk) return csrf(c, next);
  const origin = c.req.header('origin');
  if (c.req.header(CSRF_HEADER) !== '1' || (origin && origin !== new URL(c.req.url).origin))
    return c.json({ error: 'csrf', message: TRY_AGAIN }, 403);
  return next();
});

const deps = (c: { env: AppEnv['Bindings']; get(k: 'budgetId'): string }, now: number): StartDeps => ({
  db: c.env.DB,
  budgetId: c.get('budgetId'),
  now,
  runs: runDeps(c.env.DB, c.get('budgetId'), parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT)),
});

startApi.post('/start/begin', async (c) => {
  const parsed = Begin.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const r = await startBegin(deps(c, requestNow(c)), {
    genesis: unb64(parsed.data.genesis),
    header: unb64(parsed.data.header),
    signature: unb64(parsed.data.signature),
    manifest: unb64(parsed.data.manifest),
    chunks: parsed.data.chunks,
  });
  return c.json(r, r.ok ? 200 : 409);
});

// The start id `begin` answered with: a chunk names it in its query (`?start=`), the seal in its body.
const Seal = z.object({ startId: z.string().regex(/^[0-9]{1,16}$/) });

startApi.put('/start/chunks/:id/:k', async (c) => {
  const length = Number(c.req.header('content-length') ?? '0');
  if (!(length > 0) || length > 1_100_000) return c.json({ ok: false, why: 'The chunk is too large.' }, 409);
  const r = await startChunk(
    deps(c, requestNow(c)),
    c.req.query('start') ?? '',
    c.req.param('id'),
    Number(c.req.param('k')),
    new Uint8Array(await c.req.arrayBuffer()),
  );
  return c.json(r, r.ok ? 200 : 409);
});

startApi.post('/start/seal', async (c) => {
  const parsed = Seal.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, why: OLD_START }, 409);
  const r = await startSeal(deps(c, requestNow(c)), parsed.data.startId, Date.now());
  return c.json(r, r.ok ? 200 : 409);
});

// A fault is an answer too: the device's side reads JSON.
startApi.onError((_e, c) => c.json({ error: 'server', message: TRY_AGAIN }, 500));
