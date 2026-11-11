// Hosted Link (docs/privacy.md 5.7): the person links a bank on Plaid's own site, and the app finishes the link by
// asking the server, which asks Plaid. Plaid is faked at the fetch level.
import { createExecutionContext, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { ownerDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const db = ownerDb();

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
    env as never,
    createExecutionContext(),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const plaid = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** What Plaid was asked, and what its newest Link session says. */
const asked: { path: string; body: Record<string, unknown> }[] = [];
let sessions: unknown[] = [];

describe('hosted Link', () => {
  const real = globalThis.fetch;
  beforeAll(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== 'plaid.test') return real(input as RequestInfo, init);
      const text = input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}');
      asked.push({ path: url.pathname, body: JSON.parse(text || '{}') as Record<string, unknown> });
      switch (url.pathname) {
        case '/link/token/create':
          return plaid({
            link_token: 'link-test-1',
            expiration: '2026-11-14T21:00:00Z',
            hosted_link_url: 'https://secure.plaid.test/hl/abc',
          });
        case '/link/token/get':
          return plaid({ link_sessions: sessions });
        case '/item/public_token/exchange':
          return plaid({ access_token: 'access-hosted-1', item_id: 'item-hosted-1' });
        case '/item/get':
          return plaid({ item: { institution_id: null } });
        case '/accounts/get':
          return plaid({
            accounts: [
              {
                account_id: 'pa-hosted-chk',
                name: 'Checking',
                type: 'depository',
                subtype: 'checking',
                balances: { current: 10 },
              },
            ],
          });
        default:
          return plaid({});
      }
    });
  });
  afterAll(() => vi.restoreAllMocks());

  it('the session says banks are linked on Plaid’s site', async () => {
    const s = await call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect(s.json.hostedLink).toBe(true);
  });

  it('gives the address of Plaid’s page, and tells Plaid to send the person back to /link-done', async () => {
    const r = await call('POST', '/api/settings/connections/link-token', { mode: 'new', hosted: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ linkToken: 'link-test-1', hostedUrl: 'https://secure.plaid.test/hl/abc' });
    const create = asked.find((a) => a.path === '/link/token/create')!;
    expect(create.body.hosted_link).toEqual({ completion_redirect_uri: `${ORIGIN}/link-done` });
    expect(create.body.products).toEqual(['transactions']);

    // Without `hosted`, the request is as it was: no hosted page is asked for.
    asked.length = 0;
    const plain = await call('POST', '/api/settings/connections/link-token', { mode: 'new' });
    expect(plain.status).toBe(200);
    expect(asked.find((a) => a.path === '/link/token/create')!.body.hosted_link).toBeUndefined();
  });

  it('says "waiting" while the person is on Plaid’s site, and "exited" when they left', async () => {
    const finish = () =>
      call('POST', '/api/settings/connections/link-finish', { linkToken: 'link-test-1', mode: 'new' });
    sessions = [];
    expect((await finish()).json).toEqual({ status: 'waiting' });
    sessions = [{ started_at: '2026-11-14T20:00:00Z' }];
    expect((await finish()).json).toEqual({ status: 'waiting' });
    sessions = [
      { started_at: '2026-11-14T20:00:00Z', finished_at: '2026-11-14T20:01:00Z', exit: { error: null } },
    ];
    expect((await finish()).json).toEqual({ status: 'exited' });
    expect((await call('GET', '/api/settings/connections')).json.used).toBe(0);
    expect(asked.some((a) => a.path === '/item/public_token/exchange')).toBe(false);
  });

  it('finishes the link when Plaid says the person linked a bank', async () => {
    // The person left once, then came back and linked: the finished session with a bank wins.
    sessions = [
      {
        started_at: '2026-11-14T20:02:00Z',
        finished_at: '2026-11-14T20:03:00Z',
        results: { item_add_results: [{ public_token: 'public-hosted-1' }] },
      },
      { started_at: '2026-11-14T20:00:00Z', finished_at: '2026-11-14T20:01:00Z', exit: { error: null } },
    ];
    const r = await call('POST', '/api/settings/connections/link-finish', {
      linkToken: 'link-test-1',
      mode: 'new',
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('linked');
    const exchange = asked.find((a) => a.path === '/item/public_token/exchange')!;
    expect(exchange.body.public_token).toBe('public-hosted-1');
    const conns = await call('GET', '/api/settings/connections');
    expect(conns.json.used).toBe(1);
    const item = (conns.json.items as { id: string; setupDone: boolean }[])[0]!;
    expect(item.id).toBe(r.json.connectionId);
    expect(item.setupDone).toBe(true);
    const row = await db
      .prepare(`SELECT provider_item_id, access_token_enc FROM connection`)
      .first<{ provider_item_id: string; access_token_enc: string }>();
    expect(row!.provider_item_id).toBe('item-hosted-1');
    expect(row!.access_token_enc).not.toContain('access-hosted-1');
  });

  it('a repair that finished needs no exchange', async () => {
    const id = ((await call('GET', '/api/settings/connections')).json.items as { id: string }[])[0]!.id;
    asked.length = 0;
    const t = await call('POST', '/api/settings/connections/link-token', {
      mode: 'repair',
      connectionId: id,
      hosted: true,
    });
    expect(t.json.hostedUrl).toBe('https://secure.plaid.test/hl/abc');
    const create = asked.find((a) => a.path === '/link/token/create')!;
    expect(create.body.access_token).toBe('access-hosted-1');
    expect(create.body.hosted_link).toEqual({ completion_redirect_uri: `${ORIGIN}/link-done` });

    sessions = [{ started_at: '2026-11-14T20:10:00Z', finished_at: '2026-11-14T20:11:00Z', results: {} }];
    asked.length = 0;
    const r = await call('POST', '/api/settings/connections/link-finish', {
      linkToken: 'link-test-1',
      mode: 'repair',
    });
    expect(r.json).toEqual({ status: 'repaired' });
    expect(asked.some((a) => a.path === '/item/public_token/exchange')).toBe(false);
  });
});
