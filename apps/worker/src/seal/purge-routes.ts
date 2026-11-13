// The routes of emptying a sealed budget's old tables (seal/purge.ts; docs/privacy.md section 8, steps 8 and 9).
// They keep the paths the move to the sealed log had (`/api/cutover/...`), which the app on the owner's phone asks.
// Only the budget's own signed-in person; the start also wants a passkey check moments ago and a request signed
// with the budget's key.
import { ACTION } from '@ledgerline/seal';
import { Hono } from 'hono';
import { requestNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { storeSigned } from '../http/signed-request.js';
import type { Caller } from '../store/directory.js';
import { purgeStatus } from './purge.js';
import { isSealedStore } from './start.js';

const TRY_AGAIN = 'Something went wrong. Try again.';
/** How recent the passkey check is when the purge starts. */
const FRESH_MS = 2 * 60_000;

export const purgeApi = new Hono<AppEnv>();

const callerOf = (c: { env: AppEnv['Bindings'] }) =>
  (c.env as AppEnv['Bindings'] & { CALLER?: Caller }).CALLER;

purgeApi.use('*', async (c, next) => {
  const who = callerOf(c);
  if (!who || who.userId === 'system' || who.userId === 'service')
    return c.json({ error: 'not_found', message: TRY_AGAIN }, 404);
  return c.req.method === 'GET' ? next() : csrf(c, next);
});

// Where the budget stands, asked by the Privacy screen each time it opens: sealed or not, and, for the budget's
// admin, where emptying the old tables stands. It changes nothing. `open` and `backUntil` are what the move and its
// way back said; both are gone (D-102), so they are always false and null.
purgeApi.get('/cutover/state', async (c) => {
  const now = requestNow(c);
  const sealed = await isSealedStore(c.env.DB);
  const p = sealed && callerOf(c)?.isAdmin !== false ? await purgeStatus(c.env.DB, now) : null;
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  return c.json({
    open: false,
    sealed,
    backUntil: null,
    ...(p && {
      purge: {
        stage: p.stage,
        tables: p.tables,
        done: p.done,
        rows: p.rows,
        startedAt: iso(p.startedAt),
        doneAt: iso(p.doneAt),
        checkAt: iso(p.checkAt),
        clean: p.clean,
      },
    }),
  });
});

// Empties the old tables (seal/purge.ts). It can't be undone, so the passkey check must be moments old, and the
// job starts only from here. Only a device that holds the budget's key starts it (docs/privacy-keys.md 11).
purgeApi.post('/cutover/purge', async (c) => {
  const now = requestNow(c);
  const who = callerOf(c)!;
  if (who.isAdmin === false) return c.json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
  if (now - who.verifiedAt > FRESH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey, then try again.' }, 401);
  // A budget that is not sealed has no readable copy to empty: the purge refuses it.
  if (await isSealedStore(c.env.DB)) {
    const refused = await storeSigned(c, ACTION.purgeOldCopy, new Uint8Array(await c.req.arrayBuffer()));
    if (refused) return refused;
  }
  const r = (await c.env.PURGE_START?.(now)) ?? { ok: false as const, why: TRY_AGAIN };
  return r.ok ? c.json({ ok: true }) : c.json({ error: 'refused', message: r.why }, 409);
});

// A fault is an answer too: the app reads JSON.
purgeApi.onError((_e, c) => c.json({ error: 'server', message: TRY_AGAIN }, 500));
