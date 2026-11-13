import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PLAID_DAYS_REQUESTED,
  PlaidProvider,
  classifyWebhook,
  normalizePlaidTxn,
  parsePlaidSyncPage,
  plaidAmountToCents,
  resetWebhookKeyCache,
  scanSyncTail,
  scanSyncTailBytes,
  sha256Hex,
} from '../src/plaid.js';

describe('Plaid adapter', () => {
  it('flips the sign: Plaid outflows are positive, ours are negative cents', () => {
    expect(plaidAmountToCents(64.22)).toBe(-6422);
    expect(plaidAmountToCents(-1000)).toBe(100000);
    expect(Object.is(plaidAmountToCents(0), 0)).toBe(true);
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        (c) => plaidAmountToCents(c / 100) === -c,
      ),
    );
  });

  it('asks for the same 180-day history window in every Link session, and repairs in update mode', () => {
    const p = new PlaidProvider({
      clientId: 'c',
      secret: 's',
      env: 'production',
      webhookUrl: 'https://x/api/webhooks/plaid',
    });
    const fresh = p.linkTokenRequest({ mode: 'new', userId: 'u' });
    expect(PLAID_DAYS_REQUESTED).toBe(180);
    expect(fresh.transactions).toEqual({ days_requested: 180 });
    expect(fresh.products).toEqual(['transactions']);
    const repair = p.linkTokenRequest({ mode: 'repair', accessToken: 'access-x', userId: 'u' });
    expect(repair.access_token).toBe('access-x');
    expect(repair.products).toBeUndefined();
    expect(repair.transactions).toEqual({ days_requested: 180 });
    expect(() => p.linkTokenRequest({ mode: 'repair', userId: 'u' })).toThrow();
  });

  it('removes an Item with /item/remove and its token, and throws what Plaid refuses', async () => {
    const asked: { url: string; body: Record<string, unknown> }[] = [];
    let answer = new Response(JSON.stringify({ request_id: 'r' }), { status: 200 });
    const p = new PlaidProvider({
      clientId: 'id',
      secret: 'secret',
      env: 'sandbox',
      fetch: async (url, init) => {
        asked.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return answer;
      },
    });
    await p.removeItem('access-sandbox-1');
    expect(asked[0]!.url).toBe('https://sandbox.plaid.com/item/remove');
    expect(asked[0]!.body).toMatchObject({ access_token: 'access-sandbox-1' });
    answer = new Response(JSON.stringify({ error_code: 'ITEM_NOT_FOUND' }), { status: 400 });
    // An Item Plaid no longer knows is already gone.
    await expect(p.removeItem('gone')).resolves.toBeUndefined();
  });

  it('parses a sync page into normalized events with raw paths', () => {
    const body = JSON.stringify({
      added: [
        {
          transaction_id: 't1',
          account_id: 'a',
          amount: 12.5,
          date: '2026-11-01',
          pending: true,
          name: 'X',
          merchant_name: 'Shop',
        },
      ],
      modified: [],
      removed: [{ transaction_id: 't0', account_id: 'a' }],
      next_cursor: 'c2',
      has_more: false,
    });
    const p = parsePlaidSyncPage(body);
    expect(p.events.map((e) => [e.kind, e.providerTxnId, e.rawPath])).toEqual([
      ['added', 't1', 'added/0'],
      ['removed', 't0', 'removed/0'],
    ]);
    expect(p.events[0]!.payload).toMatchObject({ amount: -1250, pending: true, merchantName: 'Shop' });
  });

  it("keeps Plaid's name next to the bank text, and null when Plaid sends none", () => {
    const base = { transaction_id: 't', account_id: 'a', amount: 1, date: '2026-11-01', pending: false };
    expect(
      normalizePlaidTxn({ ...base, name: 'Hulu', original_description: 'HLU*HULUPLUS HULU.COM/BILL CA' }),
    ).toMatchObject({ rawName: 'HLU*HULUPLUS HULU.COM/BILL CA', plaidName: 'Hulu' });
    expect(normalizePlaidTxn({ ...base, name: 'Shell' })).toMatchObject({
      rawName: 'Shell',
      plaidName: 'Shell',
    });
    expect(normalizePlaidTxn({ ...base, original_description: 'SHELL 123' })).toMatchObject({
      rawName: 'SHELL 123',
      plaidName: null,
    });
    expect(() =>
      parsePlaidSyncPage(
        JSON.stringify({
          added: [{ transaction_id: 1 }],
          modified: [],
          removed: [],
          next_cursor: '',
          has_more: false,
        }),
      ),
    ).toThrow();
  });

  it('reads next_cursor and has_more from the tail without parsing, ignoring escaped look-alikes', () => {
    const tricky = JSON.stringify(
      { added: [{ name: '"next_cursor": "evil"' }], next_cursor: 'real', has_more: true },
      null,
      2,
    );
    expect(scanSyncTail(tricky)).toEqual({ nextCursor: 'real', hasMore: true });
    const big = JSON.stringify({
      added: Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(50) })),
      next_cursor: 'tail',
      has_more: false,
    });
    expect(scanSyncTailBytes(new TextEncoder().encode(big))).toEqual({ nextCursor: 'tail', hasMore: false });
  });

  it('classifies webhooks: only SYNC_UPDATES_AVAILABLE starts a sync', () => {
    expect(
      classifyWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'i' })
        .type,
    ).toBe('sync_updates_available');
    expect(classifyWebhook({ webhook_type: 'ITEM', webhook_code: 'ERROR' }).type).toBe('item_error');
    expect(classifyWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE' }).type).toBe(
      'other',
    );
  });

  it('classifies a finished Link session by its link token, with no Item', () => {
    expect(
      classifyWebhook({
        webhook_type: 'LINK',
        webhook_code: 'SESSION_FINISHED',
        link_token: 'link-sandbox-1',
      }),
    ).toEqual({
      type: 'link_session_finished',
      providerItemId: null,
      code: 'LINK:SESSION_FINISHED',
      linkToken: 'link-sandbox-1',
    });
    // No link token: nothing to finish.
    expect(classifyWebhook({ webhook_type: 'LINK', webhook_code: 'SESSION_FINISHED' }).type).toBe('other');
  });

  it('removes an Item with its token, and an Item Plaid no longer knows is already gone', async () => {
    const asked: { path: string; body: Record<string, unknown> }[] = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { request_id: 'r' } };
    const p = new PlaidProvider({
      clientId: 'c',
      secret: 's',
      env: 'sandbox',
      fetch: async (input, init) => {
        asked.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      },
    });
    await p.removeItem('access-1');
    expect(asked).toEqual([
      { path: '/item/remove', body: { client_id: 'c', secret: 's', access_token: 'access-1' } },
    ]);
    answer = { status: 400, body: { error_code: 'ITEM_NOT_FOUND' } };
    await p.removeItem('access-1');
    answer = { status: 400, body: { error_code: 'INVALID_ACCESS_TOKEN' } };
    await expect(p.removeItem('access-1')).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
  });

  it('names the bank an Item is at', async () => {
    const p = new PlaidProvider({
      clientId: 'c',
      secret: 's',
      env: 'sandbox',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        const body =
          path === '/item/get'
            ? { item: { institution_id: 'ins_1' } }
            : { institution: { name: 'Bank One' } };
        return new Response(JSON.stringify(body));
      },
    });
    expect(await p.getInstitution({ id: 'con_x', accessToken: 'a', providerItemId: 'i' })).toEqual({
      id: 'ins_1',
      name: 'Bank One',
    });
  });
});

describe('Plaid webhook verification (ES256, body hash, 5-minute iat)', () => {
  beforeEach(() => resetWebhookKeyCache());
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const b64u = (b: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(b)))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  async function setup(now: number, keyStatus = 200) {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    let keyCalls = 0;
    const provider = new PlaidProvider({
      clientId: 'c',
      secret: 's',
      env: 'sandbox',
      now: () => now,
      fetch: async () => {
        keyCalls++;
        if (keyStatus !== 200)
          return new Response(JSON.stringify({ error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID' }), {
            status: keyStatus,
          });
        return new Response(JSON.stringify({ key: { ...jwk, kid: 'k1', expired_at: null } }), {
          status: 200,
        });
      },
    });
    const sign = async (body: string, claims: Record<string, unknown> = {}) => {
      const h = enc({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
      const p = enc({ iat: Math.floor(now / 1000), request_body_sha256: await sha256Hex(body), ...claims });
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        kp.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      );
      return `${h}.${p}.${b64u(sig)}`;
    };
    return { provider, sign, keyCalls: () => keyCalls };
  }
  const body = JSON.stringify({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'item-1',
  });
  const req = (jwt: string | null, b = body) =>
    new Request('https://x/api/webhooks/plaid', {
      method: 'POST',
      body: b,
      headers: jwt ? { 'plaid-verification': jwt } : {},
    });

  it('accepts a valid signature and caches the key', async () => {
    const now = Date.now();
    const { provider, sign, keyCalls } = await setup(now);
    expect(await provider.verifyWebhook(req(await sign(body)))).toEqual({
      type: 'sync_updates_available',
      providerItemId: 'item-1',
      code: 'TRANSACTIONS:SYNC_UPDATES_AVAILABLE',
    });
    await provider.verifyWebhook(req(await sign(body)));
    expect(keyCalls()).toBe(1);
  });

  it('rejects a missing header, a tampered body, an old iat and a bad signature', async () => {
    const now = Date.now();
    const { provider, sign } = await setup(now);
    expect(await provider.verifyWebhook(req(null))).toBeNull();
    expect(await provider.verifyWebhook(req(await sign(body), body.replace('item-1', 'item-2')))).toBeNull();
    expect(
      await provider.verifyWebhook(req(await sign(body, { iat: Math.floor(now / 1000) - 301 }))),
    ).toBeNull();
    const other = await setup(now);
    expect(await provider.verifyWebhook(req(await other.sign(body)))).toBeNull();
  });

  it('shares the key between providers, as the Worker and the store each build one per webhook', async () => {
    const now = Date.now();
    const a = await setup(now);
    expect(await a.provider.verifyWebhook(req(await a.sign(body)))).not.toBeNull();
    const second = new PlaidProvider({
      clientId: 'c',
      secret: 's',
      env: 'sandbox',
      now: () => now,
      fetch: async () => {
        throw new Error('should use the cached key');
      },
    });
    expect(await second.verifyWebhook(req(await a.sign(body)))).not.toBeNull();
    expect(a.keyCalls()).toBe(1);
  });

  it('remembers a key id Plaid refuses, so forged webhooks do not each call Plaid', async () => {
    const now = Date.now();
    const { provider, sign, keyCalls } = await setup(now, 400);
    expect(await provider.verifyWebhook(req(await sign(body)))).toBeNull();
    expect(await provider.verifyWebhook(req(await sign(body)))).toBeNull();
    expect(keyCalls()).toBe(1);
  });

  it("does not remember a failure on Plaid's side", async () => {
    const now = Date.now();
    const { provider, sign, keyCalls } = await setup(now, 500);
    expect(await provider.verifyWebhook(req(await sign(body)))).toBeNull();
    expect(await provider.verifyWebhook(req(await sign(body)))).toBeNull();
    expect(keyCalls()).toBe(2);
  });
});
