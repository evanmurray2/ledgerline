// Settings → Bank connections, on the device: the budget's side of its bank links. The server keeps only each link's
// token and fetches with it (seal/sealed-routes.ts): it answers the Item meter, the Link tokens, a new link's end
// and Refresh. A new link's connection and accounts come with its first run (local/sealed-filing.ts).
import { Hono } from 'hono';
import { editNow } from '../../http/clock.js';
import type { ConnectionsView } from '@ledgerline/contracts';
import type { AppEnv } from '../../http/context.js';
import { GONE, HttpError, scoped } from '../api.js';
import { ITEM_LIMIT } from '../../sync/provider.js';

export const connectionsRoutes = new Hono<AppEnv>();

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
