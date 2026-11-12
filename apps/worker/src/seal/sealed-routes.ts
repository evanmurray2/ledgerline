// What the old routes still answer for a sealed budget (docs/privacy.md 6.2): facts about the account, never
// about the budget. The store mounts this only for a budget marked sealed, and only for an app that says it can
// open one (the `x-ledgerline-sealed` header): an older app is told to update, as before.
import {
  type ConnectionsView,
  LinkFinish,
  type LinkFinishResult,
  LinkTokenRequest,
  type SealedSession,
} from '@ledgerline/contracts';
import { decryptToken, parseKeyring } from '@ledgerline/platform';
import { Hono } from 'hono';
import { requestNow } from '../http/clock.js';
import { canLinkBanks, type AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { ITEM_LIMIT } from '../routes/settings/connections.js';
import { classifyUsage, dailyLimits, usageToday } from '../sync/breaker.js';
import { makeProvider } from '../sync/provider.js';

export const sealedApi = new Hono<AppEnv>();

/** Who is signed in, and what the account may do now. The budget's own facts are in the device's copy. */
sealedApi.get('/session', async (c) => {
  const now = requestNow(c);
  const u = await usageToday(c.env, now);
  const ws = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const notice = c.get('recoveryNoticeAt');
  const body: SealedSession = {
    sealed: true,
    user: { email: c.get('email') },
    budgetId: c.get('budgetId'),
    appVersion: c.env.APP_VERSION ?? '0.1.0',
    writeState: ws === 'normal' ? 'ok' : ws === 'pause' ? 'paused' : 'readonly',
    readOnlyUntil: ws === 'readonly' || ws === 'rest' ? tomorrow.toISOString() : null,
    readsPaused: ws === 'rest',
    canLinkBanks: canLinkBanks(c),
    recoveryNoticeAt: notice ? new Date(notice).toISOString() : null,
  };
  return c.json(body);
});

// ---------------------------------------------------------------- the banks of a sealed budget
//
// The server keeps each link's token and fetches with it (seal/fetch-job.ts); it knows a link by its id and its
// state, never by its bank's name or its accounts, which are in the device's copy. The app asks the same paths
// as before the budget was sealed, and puts the names beside the answer itself.

const TRY_AGAIN = 'Something went wrong. Try again.';
const no = (status: 400 | 404 | 409, error: string, message: string) =>
  Response.json({ error, message }, { status });

sealedApi.use('*', async (c, next) => (c.req.method === 'GET' ? next() : csrf(c, next)));

interface LinkRow {
  id: string;
  connection_id: string;
  status: string;
  error_code: string | null;
  last_fetched_at: number | null;
  linked_at: number;
  mac: string | null;
}

sealedApi.get('/settings/connections', async (c) => {
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, connection_id, status, error_code, last_fetched_at, linked_at, mac FROM bank_link
       WHERE budget_id = ?1 AND provider = 'plaid' ORDER BY linked_at`,
    )
      .bind(c.get('budgetId'))
      .all<LinkRow>()
  ).results;
  const view: ConnectionsView = {
    used: rows.length,
    limit: ITEM_LIMIT,
    environment: c.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    items: rows.map((r) => ({
      id: r.connection_id,
      // Not known here: the app reads them from its copy.
      institution: '',
      accounts: '',
      status: r.status === 'needs_repair' ? 'login_required' : r.error_code ? 'error' : 'ok',
      lastSynced: r.last_fetched_at,
      linkedAt: r.linked_at,
      setupDone: true,
    })),
  };
  return c.json(view);
});

/**
 * Asks for a fetch: the link notes it, and the store runs the backstop at once (store/budget-store.ts). Gives the
 * number of links asked.
 */
async function ask(
  db: AppEnv['Bindings']['DB'],
  budgetId: string,
  connectionId: string | null,
): Promise<number> {
  // A link the person asks for by name is tried again even when it stood at "needs repair": they may have
  // repaired it a moment ago. The fetch says so again if it is still broken.
  const which = `budget_id = ?1 AND provider = 'plaid' AND mac IS NOT NULL
    AND (?2 IS NULL OR connection_id = ?2) AND (?2 IS NOT NULL OR status = 'ok')`;
  const n =
    (
      await db
        .prepare(`SELECT count(*) AS n FROM bank_link WHERE ${which}`)
        .bind(budgetId, connectionId)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (n)
    await db
      .prepare(
        `UPDATE bank_link SET fetch_requested = 1, status = iif(?2 IS NULL, status, 'ok') WHERE ${which}`,
      )
      .bind(budgetId, connectionId)
      .run();
  return n;
}

sealedApi.post('/settings/connections/refresh', async (c) =>
  c.json({ ok: true, started: await ask(c.env.DB, c.get('budgetId'), null) }),
);

sealedApi.post('/settings/connections/:id/refresh', async (c) => {
  if (!(await ask(c.env.DB, c.get('budgetId'), c.req.param('id'))))
    return no(404, 'not_found', 'This is gone. Go back and try again.');
  return c.json({ ok: true });
});

sealedApi.post('/settings/connections/link-token', async (c) => {
  const r = LinkTokenRequest.safeParse(await c.req.json().catch(() => null));
  if (!r.success) return no(400, 'invalid', TRY_AGAIN);
  if (r.data.mode !== 'repair' || !r.data.connectionId)
    return no(409, 'sealed', 'A new bank can’t be linked to a locked budget yet.');
  const row = await c.env.DB.prepare(
    `SELECT access_token_enc, key_version FROM bank_link WHERE budget_id = ?1 AND connection_id = ?2 AND mac IS NOT NULL`,
  )
    .bind(c.get('budgetId'), r.data.connectionId)
    .first<{ access_token_enc: string | null; key_version: number | null }>();
  if (!row?.access_token_enc || row.key_version === null)
    return no(404, 'not_found', 'This is gone. Go back and try again.');
  const token = await decryptToken(
    parseKeyring(c.env.TOKEN_KEYS, c.env.TOKEN_KEY_CURRENT),
    row.access_token_enc,
    row.key_version,
    r.data.connectionId,
  );
  // Update mode reuses the link: no new link is used. The person signs in on the bank's own page.
  const lt = await makeProvider(c.env).createLinkSession({
    mode: 'repair',
    accessToken: token,
    userId: c.get('userId'),
    hosted: r.data.hosted ? { completionUrl: `${new URL(c.req.url).origin}/link-done` } : undefined,
  });
  return c.json({ linkToken: lt.linkToken, hostedUrl: lt.hostedUrl });
});

sealedApi.post('/settings/connections/link-finish', async (c) => {
  const r = LinkFinish.safeParse(await c.req.json().catch(() => null));
  if (!r.success) return no(400, 'invalid', TRY_AGAIN);
  if (r.data.mode !== 'repair')
    return no(409, 'sealed', 'A new bank can’t be linked to a locked budget yet.');
  const result = await makeProvider(c.env).linkResult(r.data.linkToken);
  // A repair keeps its link, so there is nothing to exchange. The app then asks for a fetch of that link.
  const out: LinkFinishResult =
    result.state !== 'finished' ? { status: result.state } : { status: 'repaired' };
  return c.json(out);
});

// What the server kept about the app's use and the phone's checks while it could read the budget. For a sealed
// budget it keeps none of it: the app's calls are answered and dropped.
sealedApi.post('/usage', (c) => c.body(null, 204));
sealedApi.delete('/usage', (c) => c.json({ ok: true }));
sealedApi.post('/identity-alert', (c) => c.json({ ok: true }));
sealedApi.post('/sync/shadow', (c) => c.json({ ok: true }));

sealedApi.onError((_e, c) => c.json({ error: 'internal', message: TRY_AGAIN }, 500));

/** The paths this answers for a sealed budget (store/budget-store.ts routes them here). */
export function sealedPath(method: string, path: string): boolean {
  if (path === '/api/session') return method === 'GET';
  if (path === '/api/settings/connections') return method === 'GET';
  if (/^\/api\/settings\/connections\/(refresh|link-token|link-finish|[^/]+\/refresh)$/.test(path))
    return method === 'POST';
  if (path === '/api/usage') return method === 'POST' || method === 'DELETE';
  return method === 'POST' && (path === '/api/identity-alert' || path === '/api/sync/shadow');
}
