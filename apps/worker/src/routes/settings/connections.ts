// Settings → Bank connections: the Item meter, Link tokens, exchanging a new link, setting up its accounts, and
// starting a sync (Finish setup, Refresh).
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { clock } from '../../http/clock.js';
import { LinkExchange, LinkTokenRequest, type ConnectionsView } from '@ledgerline/contracts';
import { localDate } from '@ledgerline/domain';
import { encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import type { AppEnv } from '../../http/context.js';
import { HttpError, parse, scoped } from '../api.js';
import { acquire, isFenceAbort, requestSync } from '../../sync/lease.js';
import { connectionToken, makeProvider } from '../../sync/provider.js';
import type { Scoped } from '../../db/scoped.js';
import type { Env } from '../../env.js';

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
  if (r.mode === 'repair') {
    // Update mode reuses the Item; it never uses a new slot.
    if (!r.connectionId) throw new HttpError(400, 'invalid', 'connectionId');
    const token = await connectionToken(c.env, r.connectionId);
    const lt = await provider.createLinkSession({
      mode: 'repair',
      accessToken: token,
      userId: c.get('userId'),
    });
    return c.json({ linkToken: lt.linkToken });
  }
  const used = await s.first<{ n: number }>(
    `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND provider = 'plaid'`,
  );
  if ((used?.n ?? 0) >= ITEM_LIMIT) throw new HttpError(409, 'item_limit', 'All 10 bank links are used');
  if (c.env.PLAID_ENV === 'production' && !r.confirmSlot)
    throw new HttpError(409, 'confirm_slot', 'Confirm using one of your remaining bank links');
  const lt = await provider.createLinkSession({ mode: 'new', userId: c.get('userId') });
  return c.json({ linkToken: lt.linkToken });
});

/** Maps a provider account to a budget account kind; investment and loan accounts are not linked in v1. */
export function accountKind(type: string, subtype: string | null): 'checking' | 'savings' | 'credit' | null {
  if (type === 'credit') return 'credit';
  if (type === 'depository')
    return subtype === 'savings' || subtype === 'money market' || subtype === 'cd' || subtype === 'hsa'
      ? 'savings'
      : 'checking';
  return null;
}

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
  await s.batch([
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, days_requested, setup_done, linked_at, created_at, updated_at)
       VALUES (?2, ?1, 'plaid', ?3, ?4, ?5, ?6, 180, 0, ?7, ?7, ?7)`,
      connectionId,
      itemId,
      institution,
      enc.enc,
      enc.keyVersion,
      now,
    ),
    s.audit('connection.link', 'connection', connectionId, null, { institution }, now),
  ]);
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
  accounts: { id: string; name: string; kind: string; startingBalance: number }[];
}> {
  const conn = await s.first<{ provider_item_id: string; setup_done: number }>(
    `SELECT provider_item_id, setup_done FROM connection WHERE budget_id = ?1 AND id = ?2`,
    connectionId,
  );
  if (!conn) throw new HttpError(404, 'not_found', 'connection');
  if (conn.setup_done === 1) return { connectionId, accounts: [] };
  const itemId = conn.provider_item_id;
  const provider = makeProvider(env);
  const accts = await provider.getAccounts({ id: connectionId, accessToken, providerItemId: itemId });
  const b = await s.first<{ budget_start_month: string | null; time_zone: string }>(
    `SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`,
  );
  const today = localDate(now, b?.time_zone ?? 'America/Los_Angeles');
  const startDate = b?.budget_start_month ? `${b.budget_start_month}-01` : today;
  // Each account budgets from the later of the budget start and the date it was linked (Budget start).
  const budgetFrom = today > startDate ? today : startDate;
  // The guard makes the whole batch a no-op if another attempt already finished setup.
  const w: Stmt[] = [
    s.q(
      `INSERT OR REPLACE INTO lease_guard (id, ok) VALUES (3, (SELECT setup_done = 0 FROM connection WHERE id = ?2 AND budget_id = ?1))`,
      connectionId,
    ),
  ];
  const out: { id: string; name: string; kind: string; startingBalance: number }[] = [];
  for (const a of accts) {
    w.push(
      s.q(
        `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, credit_limit, iso_currency, balance_as_of, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?14)`,
        ulid(now),
        connectionId,
        a.providerAccountId,
        a.name,
        a.officialName,
        a.type,
        a.subtype,
        a.mask,
        a.currentBalance,
        a.availableBalance,
        a.creditLimit,
        a.isoCurrency,
        now,
      ),
    );
    const kind = accountKind(a.type, a.subtype);
    if (!kind) continue;
    const id = `acc_${ulid(now)}`;
    // Starting balance = current balance at link, treated as excluding pending; you confirm or correct it.
    const startingBalance = kind === 'credit' ? -(a.currentBalance ?? 0) : (a.currentBalance ?? 0);
    w.push(
      s.q(
        `INSERT INTO account (id, budget_id, provider_account_id, name, role, kind, budget_from, starting_balance, opening_anchor, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'budget', ?5, ?6, ?7, ?7, ?8, ?8)`,
        id,
        a.providerAccountId,
        a.name,
        kind,
        budgetFrom,
        startingBalance,
        now,
      ),
    );
    if (kind === 'credit') {
      // The only categories the app makes: one card payment category per card.
      w.push(
        s.q(
          `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?2, ?1, ?3, 'cc_payment', ?4, ?5, ?5)`,
          `pay_${id}`,
          a.name,
          id,
          now,
        ),
      );
    }
    out.push({ id, name: a.name, kind, startingBalance });
  }
  w.push(
    s.q(
      `UPDATE connection SET setup_done = 1, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      connectionId,
      now,
    ),
    s.audit('connection.setup', 'connection', connectionId, null, { accounts: out.length }, now),
  );
  try {
    await s.batch(w);
  } catch (e) {
    if (isFenceAbort(e)) return { connectionId, accounts: [] };
    throw e;
  }
  return { connectionId, accounts: out };
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
  const ready = await env.DB.prepare(`SELECT setup_done FROM connection WHERE id = ?1`)
    .bind(connectionId)
    .first<{ setup_done: number }>();
  if (!ready || ready.setup_done !== 1) return false;
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
  const s = scoped(c);
  const now = clock(c.env);
  const provider = makeProvider(c.env);
  const done = await provider.completeLink(r.publicToken);
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
    await startSync(c.env, s.budgetId, existing.id, 'link');
    return c.json({ ok: true, connectionId: existing.id, accounts: [] });
  }
  const connectionId = await saveLinkedItem(
    c.env,
    s,
    done.accessToken,
    done.providerItemId,
    done.institutionName ?? 'Bank',
    now,
  );
  let res;
  try {
    res = await setUpLinkedAccounts(c.env, s, connectionId, done.accessToken, now);
  } catch {
    throw new HttpError(
      503,
      'setup_incomplete',
      'Your bank is linked, but setting up its accounts didn’t finish. Open Bank connections and tap Finish setup. It won’t use another link.',
    );
  }
  await startSync(c.env, s.budgetId, connectionId, 'link');
  return c.json({ ok: true, ...res });
});

/** A refresh within this long of a bank's last sync or attempt skips that bank, so repeated pulls don't pile up. */
export const REFRESH_COOLDOWN_MS = 60_000;

/**
 * Pull-to-refresh on Accounts (design.md, When data updates): syncs every set-up bank now. It fetches only what Plaid
 * has already collected. Banks that need their login repaired, and banks synced or tried in the last minute, are left.
 */
connectionsRoutes.post('/settings/connections/refresh', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const conns = await s.all<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND setup_done = 1
       AND status != 'login_required'
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
  if (!conn) throw new HttpError(404, 'not_found', 'connection');
  if (conn.setup_done !== 1) {
    // Finish setup of a link saved before its accounts were set up.
    const token = await connectionToken(c.env, conn.id);
    await setUpLinkedAccounts(c.env, s, conn.id, token, clock(c.env));
  }
  await startSync(c.env, s.budgetId, conn.id, 'refresh');
  return c.json({ ok: true });
});
