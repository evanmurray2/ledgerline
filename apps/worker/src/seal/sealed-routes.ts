// What the old routes still answer for a sealed budget (docs/privacy.md 6.2): facts about the account, never
// about the budget. The store mounts this only for a budget marked sealed, and only for an app that says it can
// open one (the `x-ledgerline-sealed` header): an older app is told to update, as before.
import {
  type ConnectionsView,
  type HealthView,
  LinkFinish,
  type LinkFinishResult,
  LinkTokenRequest,
  type SealedSession,
} from '@ledgerline/contracts';
import { decryptToken, encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import { linkMac } from '@ledgerline/seal';
import { ProviderError } from '@ledgerline/bank-provider';
import { type Context, Hono } from 'hono';
import { requestNow } from '../http/clock.js';
import { canLinkBanks, type AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { ITEM_LIMIT } from '../routes/settings/connections.js';
import { classifyUsage, dailyLimits, usageToday, utcDay } from '../sync/breaker.js';
import { makeProvider } from '../sync/provider.js';
import { sealedFetchId } from './fetch-job.js';
import { abandonSealedRun, workerKeys } from './runs.js';

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

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
      status:
        r.status === 'removed'
          ? 'removed'
          : r.status === 'needs_repair'
            ? 'login_required'
            : r.error_code
              ? 'error'
              : 'ok',
      lastSynced: r.last_fetched_at,
      linkedAt: r.linked_at,
      setupDone: true,
    })),
  };
  return c.json(view);
});

/**
 * Server health for the ops token (routes/ops.ts has the same answer for a budget that is not sealed): each
 * link's last complete fetch, from `bank_link`, and today's usage. The old tables are not read: phase 6 empties
 * them (seal/purge.ts). A sealed budget's bank rows are filed on its devices, so the server has no lag of its own.
 */
sealedApi.get('/health', async (c) => {
  const now = requestNow(c);
  const rows = (
    await c.env.DB.prepare(
      `SELECT connection_id, last_fetched_at FROM bank_link
       WHERE budget_id = ?1 AND provider = 'plaid' AND status != 'removed' ORDER BY linked_at`,
    )
      .bind(c.get('budgetId'))
      .all<{ connection_id: string; last_fetched_at: number | null }>()
  ).results;
  const u = await usageToday(c.env, now);
  const limits = dailyLimits(c.env);
  const connections = rows.map((x) => ({
    id: x.connection_id,
    lastSyncedAt: x.last_fetched_at,
    stale: !x.last_fetched_at || now - x.last_fetched_at > 24 * 3_600_000,
  }));
  const view: HealthView = {
    ok:
      connections.every((x) => !x.stale) &&
      classifyUsage(u.written, u.read, u.do, u.workers, limits) === 'normal',
    connections,
    watermarkLag: 0,
    usage: {
      day: utcDay(now),
      rowsRead: u.read,
      rowsWritten: u.written,
      readPct: Math.round((u.read * 1000) / limits.rowsRead) / 10,
      writePct: Math.round((u.written * 1000) / limits.rowsWritten) / 10,
    },
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

/** Plaid Trial counts every link ever made, removed ones too: so does this (a removed link keeps its row). */
async function linksMade(db: AppEnv['Bindings']['DB'], budgetId: string): Promise<number> {
  return (
    (
      await db
        .prepare(`SELECT count(*) AS n FROM bank_link WHERE budget_id = ?1 AND provider = 'plaid'`)
        .bind(budgetId)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

const keyring = (env: AppEnv['Bindings']) => parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT);

sealedApi.post('/settings/connections/link-token', async (c) => {
  const r = LinkTokenRequest.safeParse(await c.req.json().catch(() => null));
  if (!r.success) return no(400, 'invalid', TRY_AGAIN);
  const hosted = r.data.hosted ? { completionUrl: `${new URL(c.req.url).origin}/link-done` } : undefined;
  if (r.data.mode === 'new') {
    // The same checks as before the budget was sealed (routes/settings/connections.ts). The Directory has already
    // asked for a recent passkey check on this path (http/auth.ts needsRecentPasskey).
    if (!canLinkBanks(c))
      return Response.json(
        { error: 'banks_off', message: 'Linking banks isn’t available on your account yet.' },
        { status: 403 },
      );
    if ((await linksMade(c.env.DB, c.get('budgetId'))) >= ITEM_LIMIT)
      return no(409, 'item_limit', `All ${ITEM_LIMIT} bank links are used.`);
    if (c.env.PLAID_ENV === 'production' && !r.data.confirmSlot)
      return no(409, 'confirm_slot', 'Confirm that you want to use one of your bank links.');
    const lt = await makeProvider(c.env).createLinkSession({ mode: 'new', userId: c.get('userId'), hosted });
    return c.json({ linkToken: lt.linkToken, hostedUrl: lt.hostedUrl });
  }
  if (!r.data.connectionId) return no(400, 'invalid', TRY_AGAIN);
  const row = await c.env.DB.prepare(
    `SELECT access_token_enc, key_version FROM bank_link WHERE budget_id = ?1 AND connection_id = ?2 AND mac IS NOT NULL`,
  )
    .bind(c.get('budgetId'), r.data.connectionId)
    .first<{ access_token_enc: string | null; key_version: number | null }>();
  if (!row?.access_token_enc || row.key_version === null)
    return no(404, 'not_found', 'This is gone. Go back and try again.');
  const token = await decryptToken(
    keyring(c.env),
    row.access_token_enc,
    row.key_version,
    r.data.connectionId,
  );
  // Update mode reuses the link: no new link is used. The person signs in on the bank's own page.
  const lt = await makeProvider(c.env).createLinkSession({
    mode: 'repair',
    accessToken: token,
    userId: c.get('userId'),
    hosted,
  });
  return c.json({ linkToken: lt.linkToken, hostedUrl: lt.hostedUrl });
});

sealedApi.post('/settings/connections/link-finish', async (c) => {
  const r = LinkFinish.safeParse(await c.req.json().catch(() => null));
  if (!r.success) return no(400, 'invalid', TRY_AGAIN);
  const provider = makeProvider(c.env);
  const result = await provider.linkResult(r.data.linkToken);
  let out: LinkFinishResult;
  // A repair keeps its link, so there is nothing to exchange. The app then asks for a fetch of that link.
  if (result.state !== 'finished') out = { status: result.state };
  else if (r.data.mode === 'repair') out = { status: 'repaired' };
  else {
    const publicToken = result.publicTokens[0];
    out = publicToken
      ? { status: 'linked', connectionId: await saveLink(c, publicToken) }
      : { status: 'exited' };
  }
  return c.json(out);
});

/**
 * Exchanges a new link's public token and keeps the link: its token encrypted under TOKEN_KEYS, with the Worker's
 * stamp (`linkMac`), and a fetch asked for. The bank's name and accounts are not kept: the link's first run asks
 * the bank for them and seals them to the budget's inbox (seal/fetch-job.ts), and a device writes them. The store
 * starts the fetch once this answers (store/budget-store.ts). Gives the link's connection id.
 */
async function saveLink(c: Context<AppEnv>, publicToken: string): Promise<string> {
  const budgetId = c.get('budgetId');
  const done = await makeProvider(c.env).completeLink(publicToken);
  // The same Item again (update mode, or a link finished twice): the link it is, not a new one.
  const same = await c.env.DB.prepare(
    `SELECT connection_id FROM bank_link WHERE budget_id = ?1 AND provider_item_id = ?2`,
  )
    .bind(budgetId, done.providerItemId)
    .first<{ connection_id: string }>();
  if (same) return same.connection_id;
  const now = requestNow(c);
  const linkId = ulid(now);
  const connectionId = `con_${linkId}`;
  const ring = keyring(c.env);
  const enc = await encryptToken(ring, done.accessToken, connectionId);
  const keys = await workerKeys(ring).keysFor(enc.keyVersion);
  const mac = await linkMac(keys, budgetId, linkId, done.providerItemId, unb64(enc.enc));
  await c.env.DB.prepare(
    `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, access_token_enc, key_version,
       linked_at, mac, checked_at, check_result, status, fetch_requested, created_at)
     VALUES (?1, ?2, ?3, 'plaid', ?4, ?5, ?6, ?7, ?8, ?7, 'ok', 'ok', 1, ?7)`,
  )
    .bind(linkId, connectionId, budgetId, done.providerItemId, enc.enc, enc.keyVersion, now, b64(mac))
    .run();
  // Which budget owns the Item, for the bank's webhooks (docs/multi-user.md 6.4).
  if (c.env.ROUTE_LINK) await c.env.ROUTE_LINK(done.providerItemId, connectionId);
  return connectionId;
}

/**
 * Removes a bank (docs/privacy.md 5.5, D-87): ends the link at Plaid, forgets its token, and stops its fetches. The
 * link's row stays, marked removed, because Plaid counts every link ever made. The budget's side (the connection
 * marked removed; its accounts and rows stay) is an edit the device makes next
 * (POST /settings/connections/:id/mark-removed). The Directory has already asked for a recent passkey check on
 * this path. Asked again for a link already removed, it answers as before.
 */
sealedApi.post('/settings/connections/:id/remove', async (c) => {
  const budgetId = c.get('budgetId');
  const link = await c.env.DB.prepare(
    `SELECT id, connection_id, status, access_token_enc, key_version, provider_item_id FROM bank_link
     WHERE budget_id = ?1 AND connection_id = ?2 AND provider = 'plaid'`,
  )
    .bind(budgetId, c.req.param('id'))
    .first<{
      id: string;
      connection_id: string;
      status: string;
      access_token_enc: string | null;
      key_version: number | null;
      provider_item_id: string | null;
    }>();
  if (!link) return no(404, 'not_found', 'This is gone. Go back and try again.');
  if (link.status === 'removed') return c.json({ ok: true });
  if (link.access_token_enc && link.key_version !== null) {
    const token = await decryptToken(
      keyring(c.env),
      link.access_token_enc,
      link.key_version,
      link.connection_id,
    );
    try {
      await makeProvider(c.env).removeItem(token);
    } catch (e) {
      // A token Plaid no longer takes is an Item already gone (store/account-life.ts does the same).
      if (!(e instanceof ProviderError && (e.code === 'ITEM_NOT_FOUND' || e.code === 'INVALID_ACCESS_TOKEN')))
        throw e;
    }
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE bank_link SET status = 'removed', access_token_enc = NULL, key_version = NULL, provider_item_id = NULL,
         mac = NULL, check_result = 'removed', error_code = NULL, fetch_requested = 0
       WHERE id = ?1`,
    ).bind(link.id),
    c.env.DB.prepare(`DELETE FROM job WHERE id = ?1`).bind(sealedFetchId(link.id)),
  ]);
  // The bank's later news about this Item reaches no budget (best effort: a webhook for it is ignored anyway).
  if (link.provider_item_id) await c.env.DROP_ROUTE?.(link.provider_item_id).catch(() => undefined);
  // A run of this link being fetched goes too: nothing of it was shown to a device.
  await abandonSealedRun(c.env.DB, link.id);
  return c.json({ ok: true });
});

// What the server kept about the app's use and the phone's checks while it could read the budget. For a sealed
// budget it keeps none of it: the app's calls are answered and dropped.
sealedApi.post('/usage', (c) => c.body(null, 204));
sealedApi.delete('/usage', (c) => c.json({ ok: true }));
sealedApi.post('/identity-alert', (c) => c.json({ ok: true }));
sealedApi.post('/sync/shadow', (c) => c.json({ ok: true }));
// The server can't read a locked budget, so it can't restore one, and it keeps no notes about it.
sealedApi.post('/settings/restore', () =>
  no(409, 'sealed', 'A locked budget can’t be restored by the server. Your devices hold it.'),
);
sealedApi.post('/notes', () => no(409, 'sealed', 'Notes can’t be sent from a locked budget yet.'));

sealedApi.onError((_e, c) => c.json({ error: 'internal', message: TRY_AGAIN }, 500));

/** The paths this answers for a sealed budget (store/budget-store.ts routes them here). */
export function sealedPath(method: string, path: string): boolean {
  if (path === '/api/session') return method === 'GET';
  if (path === '/api/settings/connections' || path === '/api/health') return method === 'GET';
  if (/^\/api\/settings\/connections\/(refresh|link-token|link-finish|[^/]+\/(refresh|remove))$/.test(path))
    return method === 'POST';
  if (path === '/api/usage') return method === 'POST' || method === 'DELETE';
  return (
    method === 'POST' &&
    ['/api/identity-alert', '/api/sync/shadow', '/api/settings/restore', '/api/notes'].includes(path)
  );
}
