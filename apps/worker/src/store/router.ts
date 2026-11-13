// Request routing (docs/multi-user.md 5.1). Every API request goes to the Directory (sign-in, Settings → Sign-in,
// who is asking) and then to the asking user's own BudgetStore. The store is chosen only from the session's
// membership, never from anything in the request.
import type { Env } from '../env.js';
import { DIRECTORY_NAME } from './directory.js';
import { OPS_PATHS, SESSION_COOKIE, devSignIn, readCookie, secretMatches } from '../http/auth.js';
import { makeProvider } from '../sync/provider.js';
import { RESTING, restsDuring } from '../sync/breaker.js';
import { SIGNUP_PATH, gatedOptions } from '../routes/signup.js';
import { signedHeaders } from '../http/signed-request.js';

/**
 * After the Directory says the app is resting (95% of a daily limit), this isolate refuses the same requests itself
 * for a few minutes, so they don't cost Durable Object requests either.
 */
const REST_MS = 5 * 60_000;
let restingUntil = 0;

/** Tests only: forget the resting state. */
export function resetRoutingCache(): void {
  restingUntil = 0;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function routeApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
  const store = (budgetId: string) => env.BUDGET.get(env.BUDGET.idFromName(budgetId));

  // Sign-up: the switch and Turnstile are checked here, before any Durable Object request (D-75).
  if (path === SIGNUP_PATH) return gatedOptions(req, env, dir);

  // Sign-in and Settings → Sign-in live in the Directory.
  if (
    path.startsWith('/api/auth/') ||
    path === '/api/settings/security' ||
    path.startsWith('/api/settings/security/')
  )
    return dir.fetch(req);

  // Plaid webhooks: verified here, then routed to the budget that owns the Item, which verifies again and acts.
  if (path === '/api/webhooks/plaid') {
    const body = await req.text();
    const mk = () => new Request(req.url, { method: req.method, headers: req.headers, body });
    const ev = await makeProvider(env)
      .verifyWebhook(mk())
      .catch(() => null);
    if (!ev) return json({ error: 'unauthorized' }, 401);
    if (!ev.providerItemId) return json({ ok: true }, 200);
    const budgetId = await dir.routeFor(ev.providerItemId);
    if (!budgetId) return json({ ok: true }, 200); // unknown Item: ensureJobs reconciles routes daily
    return store(budgetId).api(mk(), { userId: 'system', budgetId, email: '', sessionId: '', verifiedAt: 0 });
  }

  // The ops token reads health only, for the owner's budget.
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    if (!(await secretMatches(auth.slice(7), env.OPS_TOKEN)))
      return json({ error: 'unauthenticated', message: 'Sign in again with your passkey.' }, 401);
    if (!OPS_PATHS.has(`${req.method} ${path}`))
      return json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
    const { budgetId, idle } = await dir.opsHealth();
    if (!budgetId) return json({ error: 'not_found', message: 'No budget was found. Sign in again.' }, 404);
    const res = await store(budgetId).api(req, {
      userId: 'service',
      budgetId,
      email: '',
      sessionId: '',
      verifiedAt: 0,
    });
    if (!res.ok) return res;
    // The idle accounts are the Directory's: added to the store's answer (HealthView.idleAccounts).
    return json({ ...((await res.json()) as object), idleAccounts: idle }, res.status);
  }

  // Everything else: who is asking, then their own budget. A request with no session cookie can't be anyone,
  // so it is refused here without a Durable Object request: a loop of them can't use up the daily allowance.
  if (!readCookie(req, SESSION_COOKIE) && !devSignIn(env))
    return json({ error: 'unauthenticated', message: 'Sign in again with your passkey.' }, 401);
  const now = Date.now();
  if (now < restingUntil && restsDuring(req.method, path)) return json(RESTING, 503);
  const a = await dir.authenticate(req.headers.get('cookie'), req.method, path, signedHeaders(req.headers));
  if (!a.ok) {
    if (a.body.error === RESTING.error) {
      const midnight = new Date(now).setUTCHours(24, 0, 0, 0);
      restingUntil = Math.min(now + REST_MS, midnight);
    }
    return json(a.body, a.status);
  }
  return store(a.caller.budgetId).api(req, a.caller);
}
