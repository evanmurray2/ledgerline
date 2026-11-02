// Request routing after the move (docs/multi-user.md 5.1, 8.5). Until move_state says 'moved', the Worker serves
// everything from D1 as before. After it, every API request goes to the Directory (sign-in, Settings → Sign-in,
// who is asking) and then to the asking user's own BudgetStore. The store is chosen only from the session's
// membership, never from anything in the request.
import type { Env } from '../env.js';
import { DIRECTORY_NAME } from './directory.js';
import { OPS_PATHS, secretMatches } from '../http/auth.js';
import { makeProvider } from '../sync/provider.js';

const CACHE_MS = 10_000;
let cached: { phase: string; at: number } | null = null;

/** Whether the Durable Objects serve requests: move_state.phase = 'moved' (cached for 10 seconds per isolate). */
export async function objectsServe(env: Env, now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.phase === 'moved';
  const r = await env.DB.prepare(`SELECT phase FROM move_state WHERE id = 1`)
    .first<{ phase: string }>()
    .catch(() => null);
  cached = { phase: r?.phase ?? 'none', at: now };
  return cached.phase === 'moved';
}

/** Tests only: forget the cached phase. */
export function resetRoutingCache(): void {
  cached = null;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function routeApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(DIRECTORY_NAME));
  const store = (budgetId: string) => env.BUDGET.get(env.BUDGET.idFromName(budgetId));

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
      return json({ error: 'unauthenticated', message: 'Sign in with your passkey' }, 401);
    if (!OPS_PATHS.has(`${req.method} ${path}`))
      return json({ error: 'forbidden', message: 'ops token' }, 403);
    const budgetId = await dir.firstBudget();
    if (!budgetId) return json({ error: 'not_found', message: 'no budget' }, 404);
    return store(budgetId).api(req, { userId: 'service', budgetId, email: '', sessionId: '', verifiedAt: 0 });
  }

  // Everything else: who is asking, then their own budget.
  const a = await dir.authenticate(req.headers.get('cookie'), req.method, path);
  if (!a.ok) return json(a.body, a.status);
  return store(a.caller.budgetId).api(req, a.caller);
}
