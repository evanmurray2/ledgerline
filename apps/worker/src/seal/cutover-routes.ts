// The routes of the cutover (seal/cutover.ts; docs/privacy.md section 8, steps 6 and 7). The store mounts them
// in front of everything else, because a frozen budget refuses every other write. They answer only while the
// Worker's `CUTOVER` variable is `on`, only to the budget's own signed-in person, and only minutes after a
// passkey check.
import { CSRF_HEADER } from '@ledgerline/contracts';
import { parseKeyring } from '@ledgerline/platform';
import { Hono } from 'hono';
import { z } from 'zod';
import { REAUTH_MS } from '../http/auth.js';
import { requestNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import type { Caller } from '../store/directory.js';
import {
  cutoverBack,
  cutoverBegin,
  cutoverBlocks,
  cutoverState,
  cutoverChunk,
  cutoverFreeze,
  cutoverSeal,
  type CutoverDeps,
} from './cutover.js';
import { runDeps } from './runs.js';

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
  tables: z.array(z.object({ name: z.string().max(64), hash: z.string().regex(/^[0-9a-f]{64}$/) })).max(200),
});

export const cutoverApi = new Hono<AppEnv>();

/**
 * Whether the cutover is open for this budget: the Worker's `CUTOVER` variable names the one budget that may be
 * moved (`any` is for tests). The way back needs no variable: a sealed budget can always take it inside its 7
 * days, whatever was deployed since.
 */
const open = (c: { env: AppEnv['Bindings']; req: { path: string } }, budgetId: string): boolean =>
  c.req.path.endsWith('/cutover/back') || c.env.CUTOVER === budgetId || c.env.CUTOVER === 'any';

// Where the budget stands: asked by the Privacy screen each time it opens, so it needs no passkey check and
// answers whether or not the move is open. It is in front of the guard below for that reason; it changes nothing.
cutoverApi.get('/cutover/state', async (c) => {
  const who = (c.env as typeof c.env & { CALLER?: Caller }).CALLER;
  if (!who || who.userId === 'system' || who.userId === 'service')
    return c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
  const now = requestNow(c);
  const s = await cutoverState({ db: c.env.DB, now, markNow: Date.now() });
  return c.json({
    // The move is offered to the budget's admin only, and only while the Worker names this budget.
    open: !s.sealed && who.isAdmin !== false && open(c, who.budgetId),
    sealed: s.sealed,
    backUntil: s.backUntil !== null && who.isAdmin !== false ? new Date(s.backUntil).toISOString() : null,
  });
});

cutoverApi.use('*', async (c, next) => {
  // A person, signed in, who used their passkey minutes ago: not the ops token, not a job. And the budget's
  // admin (its first user), when the Directory says who that is.
  const who = (c.env as typeof c.env & { CALLER?: Caller }).CALLER;
  if (!who || !open(c, who.budgetId)) return c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
  if (who.userId === 'system' || who.userId === 'service' || who.isAdmin === false)
    return c.json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
  if (requestNow(c) - who.verifiedAt > REAUTH_MS)
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

const deps = (
  c: { env: AppEnv['Bindings']; get(k: 'budgetId'): string; req: unknown },
  now: number,
): CutoverDeps => ({
  db: c.env.DB,
  budgetId: c.get('budgetId'),
  now,
  markNow: Date.now(),
  runs: runDeps(c.env.DB, c.get('budgetId'), parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT)),
});

cutoverApi.post('/cutover/freeze', async (c) => {
  const r = await cutoverFreeze(deps(c, requestNow(c)));
  return c.json(r, r.ok ? 200 : 409);
});

cutoverApi.post('/cutover/begin', async (c) => {
  const parsed = Begin.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', message: TRY_AGAIN }, 400);
  const r = await cutoverBegin(deps(c, requestNow(c)), {
    genesis: unb64(parsed.data.genesis),
    header: unb64(parsed.data.header),
    signature: unb64(parsed.data.signature),
    manifest: unb64(parsed.data.manifest),
    chunks: parsed.data.chunks,
    tables: parsed.data.tables,
  });
  return c.json(r, r.ok ? 200 : 409);
});

cutoverApi.put('/cutover/chunks/:id/:k', async (c) => {
  const length = Number(c.req.header('content-length') ?? '0');
  if (!(length > 0) || length > 1_100_000) return c.json({ ok: false, why: 'The chunk is too large.' }, 409);
  const r = await cutoverChunk(
    deps(c, requestNow(c)),
    c.req.param('id'),
    Number(c.req.param('k')),
    new Uint8Array(await c.req.arrayBuffer()),
  );
  return c.json(r, r.ok ? 200 : 409);
});

// What stands in the way, in words for the person, before any key is made. The freeze checks the same again.
cutoverApi.post('/cutover/ready', async (c) =>
  c.json({ ok: true, blocks: await cutoverBlocks(c.env.DB, c.get('budgetId'), requestNow(c)) }),
);

cutoverApi.post('/cutover/seal', async (c) => {
  const r = await cutoverSeal(deps(c, requestNow(c)));
  return c.json(r, r.ok ? 200 : 409);
});

cutoverApi.post('/cutover/back', async (c) => {
  const r = await cutoverBack({ db: c.env.DB, now: requestNow(c), markNow: Date.now() });
  return c.json(r, r.ok ? 200 : 409);
});

// A fault is an answer too: the phone's side reads JSON.
cutoverApi.onError((_e, c) => c.json({ error: 'server', message: TRY_AGAIN }, 500));
