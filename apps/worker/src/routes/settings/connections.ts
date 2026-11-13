// Settings → Bank connections: the Item meter, Link tokens, exchanging a new link, setting up its accounts, and
// starting a sync (Finish setup, Refresh).
import { Hono } from 'hono';
import { clock, editNow, requestNow } from '../../http/clock.js';
import {
  LinkExchange,
  LinkFinish,
  type LinkFinishResult,
  LinkTokenRequest,
  type ConnectionsView,
} from '@ledgerline/contracts';
import { encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import { canLinkBanks, type AppEnv } from '../../http/context.js';
import { GONE, HttpError, TRY_AGAIN, parse, scoped } from '../api.js';
import { acquire, isFenceAbort, requestSync } from '../../sync/lease.js';
import { connectionToken, makeProvider } from '../../sync/provider.js';
import type { Scoped } from '../../db/scoped.js';
import type { Env } from '../../env.js';
import { connectionStmts, linkedAccountStmts, type SetUpAccount } from './link-rows.js';

export { accountKind } from './link-rows.js';

export const connectionsRoutes = new Hono<AppEnv>();

/** Plaid Trial: 10 Production Items for the life of the team; removed Items still count. */
export const ITEM_LIMIT = 10;

// ---------------------------------------------------------------- bank connections

connectionsRoutes.get('/settings/connections', async (c) => {
  const s = scoped(c);
  const rows = await s.all<{
    id: string;
    institution_name: string;
    status: string;
    last_synced_at: number | null;
    linked_at: number;
    accounts: string | null;
    removed_at: number | null;
    setup_done: number;
  }>(
    `SELECT c.id, c.institution_name, c.status, c.last_synced_at, c.linked_at, c.removed_at, c.setup_done,
       (SELECT group_concat(name, ', ') FROM provider_account p WHERE p.connection_id = c.id) AS accounts
     FROM connection c WHERE c.budget_id = ?1 AND c.provider = 'plaid' ORDER BY c.linked_at`,
  );
  const view: ConnectionsView = {
    used: rows.length,
    limit: ITEM_LIMIT,
    environment: c.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    items: rows.map((r) => ({
      id: r.id,
      institution: r.institution_name,
      accounts: r.accounts ?? '',
      status: r.removed_at ? 'removed' : (r.status as 'ok' | 'login_required' | 'error'),
      lastSynced: r.last_synced_at,
      linkedAt: r.linked_at,
      setupDone: r.setup_done === 1,
    })),
  };
  return c.json(view);
});

connectionsRoutes.post('/settings/connections/link-token', async (c) => {
  const r = await parse(LinkTokenRequest, c.req.raw);
  const s = scoped(c);
  const provider = makeProvider(c.env);
  // Hosted Link: the person links on Plaid's own site and comes back to a page of the app that only says "done".
  // The link is finished by /link-finish, which asks Plaid, never by where the browser lands.
  const hosted = r.hosted ? { completionUrl: `${new URL(c.req.url).origin}/link-done` } : undefined;
  if (r.mode === 'repair') {
    // Update mode reuses the Item; it never uses a new slot.
    if (!r.connectionId) throw new HttpError(400, 'invalid', TRY_AGAIN);
    const token = await connectionToken(c.env, r.connectionId);
    const lt = await provider.createLinkSession({
      mode: 'repair',
      accessToken: token,
      userId: c.get('userId'),
      hosted,
    });
    return c.json({ linkToken: lt.linkToken, hostedUrl: lt.hostedUrl });
  }
  // Plaid Trial's links are for the whole Plaid account, so only admins link new banks (docs/open-signup.md 5).
  if (!canLinkBanks(c))
    throw new HttpError(403, 'banks_off', 'Linking banks isn’t available on your account yet.');
  const used = await s.first<{ n: number }>(
    `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND provider = 'plaid'`,
  );
  if ((used?.n ?? 0) >= ITEM_LIMIT)
    throw new HttpError(409, 'item_limit', `All ${ITEM_LIMIT} bank links are used.`);
  if (c.env.PLAID_ENV === 'production' && !r.confirmSlot)
    throw new HttpError(409, 'confirm_slot', 'Confirm that you want to use one of your bank links.');
  const lt = await provider.createLinkSession({ mode: 'new', userId: c.get('userId'), hosted });
  return c.json({ linkToken: lt.linkToken, hostedUrl: lt.hostedUrl });
});

/**
 * Step 1 of a new link, run as soon as Plaid returns the access token: save the connection with its encrypted token
 * and setup_done = 0. From here on the link is never lost, even if setting up its accounts fails.
 */
export async function saveLinkedItem(
  env: Env,
  s: Scoped,
  accessToken: string,
  itemId: string,
  institution: string,
  now: number,
): Promise<string> {
  const connectionId = `con_${ulid(now)}`;
  const enc = await encryptToken(
    parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
    accessToken,
    connectionId,
  );
  await s.batch(
    connectionStmts(s, {
      id: connectionId,
      institution,
      itemId,
      tokenEnc: enc.enc,
      keyVersion: enc.keyVersion,
      linkedAt: now,
    }),
  );
  // Inside a budget's Durable Object: record which budget owns the Item, for webhooks (docs/multi-user.md 6.4).
  if (env.ROUTE_LINK) await env.ROUTE_LINK(itemId, connectionId);
  return connectionId;
}

/**
 * Step 2: fetch the link's accounts and set them up (accounts, card payment categories, starting balances) in one
 * atomic batch that also sets setup_done = 1. Safe to retry: it does nothing once setup is done.
 */
export async function setUpLinkedAccounts(
  env: Env,
  s: Scoped,
  connectionId: string,
  accessToken: string,
  now: number,
): Promise<{
  connectionId: string;
  accounts: SetUpAccount[];
}> {
  const conn = await s.first<{ provider_item_id: string; setup_done: number }>(
    `SELECT provider_item_id, setup_done FROM connection WHERE budget_id = ?1 AND id = ?2`,
    connectionId,
  );
  if (!conn) throw new HttpError(404, 'not_found', GONE);
  if (conn.setup_done === 1) return { connectionId, accounts: [] };
  const itemId = conn.provider_item_id;
  const provider = makeProvider(env);
  const accts = await provider.getAccounts({ id: connectionId, accessToken, providerItemId: itemId });
  const setup = await linkedAccountStmts(s, connectionId, accts, now, () => ulid(now));
  try {
    await s.batch(setup.stmts);
  } catch (e) {
    if (isFenceAbort(e)) return { connectionId, accounts: [] };
    throw e;
  }
  return { connectionId, accounts: setup.accounts };
}

export async function startSync(
  env: Env,
  budgetId: string,
  connectionId: string,
  trigger: 'webhook' | 'cron' | 'refresh' | 'link',
): Promise<boolean> {
  const now = clock(env);
  // A link whose accounts aren't set up yet would sync transactions no account can take (and the watermark would pass
  // them by), so it waits until "Finish setup".
  // A CSV import (routes/ops.ts) is stored as a connection too, but has no bank to sync.
  const ready = await env.DB.prepare(`SELECT setup_done, provider FROM connection WHERE id = ?1`)
    .bind(connectionId)
    .first<{ setup_done: number; provider: string }>();
  if (!ready || ready.setup_done !== 1 || ready.provider === 'csv') return false;
  await requestSync(env.DB, connectionId, now);
  const runId = `run_${ulid(now)}`;
  if (!(await acquire(env.DB, connectionId, runId, now))) return false;
  try {
    if (!env.JOBS) throw new Error('jobs run only inside a budget store');
    await env.JOBS.sync(runId, connectionId, trigger);
    return true;
  } catch (e) {
    const { releaseFailed } = await import('../../sync/lease.js');
    await releaseFailed(env.DB, connectionId, runId);
    throw e;
  }
}

connectionsRoutes.post('/settings/connections/exchange', async (c) => {
  const r = await parse(LinkExchange, c.req.raw);
  return c.json({ ok: true, ...(await finishLink(c.env, scoped(c), r.publicToken, requestNow(c))) });
});

/**
 * Hosted Link: what the session came to, and the link finished if the person linked a bank. The app asks while the
 * person is on Plaid's site and again when they come back. A repair keeps its Item, so there is nothing to exchange.
 */
connectionsRoutes.post('/settings/connections/link-finish', async (c) => {
  const r = await parse(LinkFinish, c.req.raw);
  const result = await makeProvider(c.env).linkResult(r.linkToken);
  let out: LinkFinishResult;
  if (result.state !== 'finished') out = { status: result.state };
  else if (r.mode === 'repair') out = { status: 'repaired' };
  else {
    const publicToken = result.publicTokens[0];
    if (!publicToken) out = { status: 'exited' };
    else {
      const done = await finishLink(c.env, scoped(c), publicToken, requestNow(c));
      out = { status: 'linked', connectionId: done.connectionId };
    }
  }
  return c.json(out);
});

/** Exchanges a public token and stores the link: a new connection with its accounts, or the same Item repaired. */
async function finishLink(
  env: Env,
  s: Scoped,
  publicToken: string,
  now: number,
): Promise<{ connectionId: string; accounts: unknown[] }> {
  const provider = makeProvider(env);
  const done = await provider.completeLink(publicToken);
  const existing = await s.first<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND provider_item_id = ?2`,
    done.providerItemId,
  );
  if (existing) {
    // Update mode returned the same Item: repaired, not a new link.
    await s.run(
      `UPDATE connection SET status = 'ok', error_code = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      existing.id,
      now,
    );
    await startSync(env, s.budgetId, existing.id, 'link');
    return { connectionId: existing.id, accounts: [] };
  }
  const connectionId = await saveLinkedItem(
    env,
    s,
    done.accessToken,
    done.providerItemId,
    done.institutionName ?? 'Bank',
    now,
  );
  let res;
  try {
    res = await setUpLinkedAccounts(env, s, connectionId, done.accessToken, now);
  } catch {
    throw new HttpError(
      503,
      'setup_incomplete',
      'Your bank is linked, but its accounts aren’t set up yet. Tap Finish setup in Bank connections. It doesn’t use another link.',
    );
  }
  await startSync(env, s.budgetId, connectionId, 'link');
  return res;
}

/** A refresh within this long of a bank's last sync or attempt skips that bank, so repeated pulls don't pile up. */
export const REFRESH_COOLDOWN_MS = 60_000;

/**
 * Pull-to-refresh on Accounts (design.md, When data updates): syncs every set-up bank now. It fetches only what Plaid
 * has already collected. Banks that need their login repaired, and banks synced or tried in the last minute, are left.
 */
connectionsRoutes.post('/settings/connections/refresh', async (c) => {
  const s = scoped(c);
  const now = requestNow(c);
  const conns = await s.all<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND setup_done = 1
       AND provider != 'csv' AND status != 'login_required'
       AND max(coalesce(last_synced_at, 0), coalesce(last_attempt_at, 0)) < ?2`,
    now - REFRESH_COOLDOWN_MS,
  );
  let started = 0;
  for (const conn of conns) if (await startSync(c.env, s.budgetId, conn.id, 'refresh')) started++;
  return c.json({ ok: true, started });
});

connectionsRoutes.post('/settings/connections/:id/refresh', async (c) => {
  const s = scoped(c);
  const conn = await s.first<{ id: string; setup_done: number }>(
    `SELECT id, setup_done FROM connection WHERE budget_id = ?1 AND id = ?2 AND removed_at IS NULL`,
    c.req.param('id'),
  );
  if (!conn) throw new HttpError(404, 'not_found', GONE);
  if (conn.setup_done !== 1) {
    // Finish setup of a link saved before its accounts were set up.
    const token = await connectionToken(c.env, conn.id);
    await setUpLinkedAccounts(c.env, s, conn.id, token, requestNow(c));
  }
  await startSync(c.env, s.budgetId, conn.id, 'refresh');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- a sealed budget's links, on the device
//
// For a sealed budget the server keeps only a link's token (seal/sealed-routes.ts). The device writes the budget's
// side: a new link's connection and accounts come with its first run (local/sealed-filing.ts), and a removed bank is
// this edit. It runs on the device's copy and goes to the log like any other edit, and is a twin of the same route on
// a budget that isn't sealed (test/twin.test.ts).

/**
 * Marks a removed bank in the budget (D-87): the connection is removed, and its accounts and every past row stay as
 * they are, counted at their last balance and shown as not linked. The link must already be gone at the bank: a
 * connection that still holds its token is refused (a device's copy never holds one).
 */
connectionsRoutes.post('/settings/connections/:id/mark-removed', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const conn = await s.first<{ removed_at: number | null; linked: number }>(
    `SELECT removed_at, access_token_enc IS NOT NULL AS linked FROM connection WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!conn) throw new HttpError(404, 'not_found', GONE);
  if (conn.removed_at !== null) return c.json({ ok: true });
  if (conn.linked) throw new HttpError(409, 'still_linked', 'Remove the bank first.');
  await s.batch([
    s.q(
      `UPDATE connection SET status = 'removed', removed_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      id,
      now,
    ),
    s.audit('connection.remove', 'connection', id, null, null, now),
  ]);
  return c.json({ ok: true });
});
