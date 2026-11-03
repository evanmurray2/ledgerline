// A new bank link is saved before its accounts are set up, so a failure in between can't lose a link that already
// counts toward the 10 (migration 0005). Plaid is faked at the fetch level.
import { createExecutionContext, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { ownerDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
let accountsFailures = 1;
const db = ownerDb();
/** A sync was started: its job is queued in the budget's store, or has already begun a run. */
const syncsStarted = async () =>
  Number(
    await db
      .prepare(`SELECT (SELECT count(*) FROM job WHERE kind = 'sync') + (SELECT count(*) FROM sync_run) AS n`)
      .first('n'),
  );
const testEnv = () => env as never;

async function call(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers:
        method === 'GET'
          ? { origin: ORIGIN }
          : { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
    testEnv(),
    createExecutionContext(),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const plaid = (path: string, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('linking a bank', () => {
  const real = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== 'plaid.test') return real(input as RequestInfo, init);
      switch (url.pathname) {
        case '/item/public_token/exchange':
          return plaid(url.pathname, { access_token: 'access-test-1', item_id: 'item-test-1' });
        case '/item/get':
          return plaid(url.pathname, { item: { institution_id: null } });
        case '/accounts/get':
          if (accountsFailures-- > 0)
            return plaid(url.pathname, { error_code: 'INTERNAL_SERVER_ERROR', error_message: 'boom' }, 500);
          return plaid(url.pathname, {
            accounts: [
              {
                account_id: 'pa-chk',
                name: 'Checking',
                type: 'depository',
                subtype: 'checking',
                balances: { current: 1200.5 },
              },
              {
                account_id: 'pa-card',
                name: 'Card',
                type: 'credit',
                subtype: 'credit card',
                balances: { current: 300 },
              },
            ],
          });
        default:
          return plaid(url.pathname, {});
      }
    });
  });
  afterAll(() => vi.restoreAllMocks());

  it('keeps the link when setting up its accounts fails, and says how to finish', async () => {
    expect((await call('GET', '/api/session')).status).toBe(200);
    const r = await call('POST', '/api/settings/connections/exchange', { publicToken: 'public-test-1' });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('setup_incomplete');
    const conns = await call('GET', '/api/settings/connections');
    expect(conns.json.used).toBe(1);
    expect((conns.json.items as { setupDone: boolean }[])[0]!.setupDone).toBe(false);
    expect(await syncsStarted()).toBe(0); // no sync before its accounts exist
  });

  it('Finish setup sets up the accounts once, then syncs', async () => {
    const id = ((await call('GET', '/api/settings/connections')).json.items as { id: string }[])[0]!.id;
    expect((await call('POST', `/api/settings/connections/${id}/refresh`)).status).toBe(200);
    const conns = await call('GET', '/api/settings/connections');
    expect((conns.json.items as { setupDone: boolean }[])[0]!.setupDone).toBe(true);
    expect(await syncsStarted()).toBeGreaterThan(0);
    const counts = await db
      .prepare(
        `SELECT (SELECT count(*) FROM account) AS accounts, (SELECT count(*) FROM category WHERE kind = 'cc_payment') AS cards,
         (SELECT count(*) FROM connection) AS links`,
      )
      .first<{ accounts: number; cards: number; links: number }>();
    expect(counts).toEqual({ accounts: 2, cards: 1, links: 1 });

    // A second Finish setup (say, a double tap) adds nothing.
    await db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL`).run();
    expect((await call('POST', `/api/settings/connections/${id}/refresh`)).status).toBe(200);
    const again = await db.prepare(`SELECT count(*) AS n FROM account`).first<{ n: number }>();
    expect(again!.n).toBe(2);
  });

  it('Refresh on Accounts syncs set-up banks, but not one just synced or needing repair', async () => {
    const lastSync = async () =>
      (await db.prepare(`SELECT last_synced_at FROM connection`).first<{ last_synced_at: number | null }>())!;
    await db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL, last_synced_at = 0`).run();
    await db.prepare(`DELETE FROM job WHERE kind = 'sync'`).run();
    await db.prepare(`DELETE FROM sync_run`).run();
    const r = await call('POST', '/api/settings/connections/refresh');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, started: 1 });
    expect(await syncsStarted()).toBeGreaterThan(0);

    // Synced a moment ago: a second pull starts nothing.
    await db
      .prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL, last_synced_at = ?1`)
      .bind(Date.parse('2026-11-14T20:00:00Z'))
      .run(); // vitest.config FAKE_NOW
    expect((await call('POST', '/api/settings/connections/refresh')).json).toEqual({ ok: true, started: 0 });
    expect((await lastSync()).last_synced_at).not.toBe(0);

    // A bank whose login needs repair is left for Repair.
    await db.prepare(`UPDATE connection SET last_synced_at = 0, status = 'login_required'`).run();
    expect((await call('POST', '/api/settings/connections/refresh')).json).toEqual({ ok: true, started: 0 });
    await db.prepare(`UPDATE connection SET status = 'ok'`).run();
  });
});
