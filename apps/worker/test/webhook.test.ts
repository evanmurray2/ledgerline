// Plaid webhooks through the whole Worker: signature checked in the Worker and again in the store, routed by the
// Directory to the budget that owns the Item. Plaid sends no browser headers, so the CSRF check must not stop it.
import { createExecutionContext, env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetWebhookKeyCache, sha256Hex } from '@ledgerline/bank-provider';
import worker from '../src/index.js';
import { directoryStub, ownerDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const db = ownerDb();
const enc = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

let kp: CryptoKeyPair;
let jwk: JsonWebKey;
let keyCalls = 0;

async function sign(body: string): Promise<string> {
  const h = enc({ alg: 'ES256', kid: 'k-test', typ: 'JWT' });
  const p = enc({ iat: Math.floor(Date.now() / 1000), request_body_sha256: await sha256Hex(body) });
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    kp.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64u(sig)}`;
}

async function webhook(payload: unknown, jwt?: string) {
  const body = JSON.stringify(payload);
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/webhooks/plaid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'plaid-verification': jwt ?? (await sign(body)) },
      body,
    }),
    env as never,
    createExecutionContext(),
  );
  return res.status;
}

describe('Plaid webhook', () => {
  const real = globalThis.fetch;
  beforeAll(async () => {
    resetWebhookKeyCache();
    kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== 'plaid.test') return real(input as RequestInfo, init);
      if (url.pathname === '/webhook_verification_key/get') {
        keyCalls++;
        return new Response(JSON.stringify({ key: { ...jwk, kid: 'k-test', expired_at: null } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error_code: 'NOT_MOCKED' }), { status: 400 });
    });
    // The dev user's budget exists after the first request; it is locked (D-102), with a stamped bank link the
    // Directory routes to (a stand-in stamp: the webhook only asks that the link has one).
    await worker.fetch(new Request(`${ORIGIN}/api/session`), env as never, createExecutionContext());
    const budgetId = (await directoryStub().firstBudget())!;
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_link (id, connection_id, budget_id, provider, provider_item_id, linked_at, mac, created_at)
           VALUES ('hook', 'con_hook', ?1, 'plaid', 'item-hook', 0, 'stamp', 0)`,
        )
        .bind(budgetId),
      db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', 0)`),
    ]);
    expect(await directoryStub().registerRoute('item-hook', budgetId, 'con_hook')).toBe('ok');
  });
  afterAll(() => vi.restoreAllMocks());

  it('ITEM:ERROR marks the bank link as needing repair', async () => {
    expect(
      await webhook({
        webhook_type: 'ITEM',
        webhook_code: 'ERROR',
        item_id: 'item-hook',
        error: { error_code: 'ITEM_LOGIN_REQUIRED' },
      }),
    ).toBe(200);
    expect(
      await db.prepare(`SELECT status FROM bank_link WHERE connection_id = 'con_hook'`).first('status'),
    ).toBe('needs_repair');
    // The Worker and the store share one cached key.
    expect(keyCalls).toBe(1);
  });

  it('SYNC_UPDATES_AVAILABLE is accepted and asks for a sync', async () => {
    expect(
      await webhook({
        webhook_type: 'TRANSACTIONS',
        webhook_code: 'SYNC_UPDATES_AVAILABLE',
        item_id: 'item-hook',
      }),
    ).toBe(200);
  });

  it('a forged signature is refused', async () => {
    const body = { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-hook' };
    const jwt = await sign(JSON.stringify({ ...body, item_id: 'other' }));
    expect(await webhook(body, jwt)).toBe(401);
  });
});
