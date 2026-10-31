import { describe, expect, it } from 'vitest';
import { resetAccessKeyCache, verifyAccessJwt } from '../src/http/auth.js';
import { Scoped } from '../src/db/scoped.js';
import { env } from 'cloudflare:test';

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag';
const enc = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

async function keys() {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ keys: [{ kid: 'k1', kty: 'RSA', n: jwk.n, e: jwk.e }] }),
    )) as unknown as typeof fetch;
  const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
    const h = enc({ alg: 'RS256', kid });
    const p = enc(claims);
    const s = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      kp.privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64u(s)}`;
  };
  return { fetcher, sign };
}

describe('Cloudflare Access JWT verification', () => {
  it('accepts a valid token and rejects wrong audience, issuer, expiry and signature', async () => {
    resetAccessKeyCache();
    const now = 1_800_000_000_000;
    const { fetcher, sign } = await keys();
    const good = { iss: TEAM, aud: [AUD], exp: now / 1000 + 600, email: 'Owner@Example.com' };
    const opts = { team: TEAM, aud: AUD, now, fetcher };
    expect(await verifyAccessJwt(await sign(good), opts)).toEqual({
      email: 'owner@example.com',
      serviceClientId: null,
    });
    expect(await verifyAccessJwt(await sign({ ...good, aud: ['other'] }), opts)).toBeNull();
    expect(
      await verifyAccessJwt(await sign({ ...good, iss: 'https://evil.cloudflareaccess.com' }), opts),
    ).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 1 }), opts)).toBeNull();
    const other = await keys();
    expect(await verifyAccessJwt(await other.sign(good), opts)).toBeNull();
    expect(await verifyAccessJwt('not.a.jwt', opts)).toBeNull();
    const svc = await verifyAccessJwt(
      await sign({ iss: TEAM, aud: AUD, exp: now / 1000 + 600, common_name: 'svc.access' }),
      opts,
    );
    expect(svc).toEqual({ email: '', serviceClientId: 'svc.access' });
  });
});

describe('budget-scoped data access', () => {
  it('refuses a query that does not bind the budget id as ?1', () => {
    const s = new Scoped(env.DB, 'b1', 'u1');
    expect(() => s.q(`SELECT * FROM category`)).toThrow(/budget id/);
    expect(() => s.q(`SELECT * FROM category WHERE budget_id = ?1`)).not.toThrow();
  });
});
