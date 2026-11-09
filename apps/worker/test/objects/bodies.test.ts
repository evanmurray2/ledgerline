// Sign-in and Settings → Sign-in with bodies the app never sends (JSON `null`, a number, a list, broken JSON): each
// gets a JSON answer, never the runtime's plain-text server error, and signing out still signs out.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { SoftAuthenticator } from '../soft-authenticator.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const prodEnv = () => ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined }) as never;

let jar = '';
async function call(method: string, path: string, body: string | undefined, cookie = jar) {
  const h: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
  if (cookie) h.cookie = cookie;
  const res = await worker.fetch(
    new Request(ORIGIN + path, { method, headers: h, body: method === 'GET' ? undefined : body }),
    prodEnv(),
    createExecutionContext(),
  );
  const sc = res.headers.get('set-cookie') ?? '';
  const text = await res.text();
  return { status: res.status, sc, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe('bodies the app never sends', () => {
  it('signs in once with the setup code', async () => {
    const key = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
    const o = await call('POST', '/api/auth/register/options', JSON.stringify({ setupCode: SETUP }));
    const challenge = o.sc.split(';')[0]!;
    const v = await call(
      'POST',
      '/api/auth/register/verify',
      JSON.stringify({ response: await key.create(o.json() as never), name: 'Phone' }),
      challenge,
    );
    expect(v.status).toBe(200);
    jar = v.sc.split(';')[0]!;
    expect((await call('GET', '/api/session', undefined)).status).toBe(200);
  });

  it('answers JSON, never a plain-text server error', async () => {
    const paths = [
      '/api/auth/register/options',
      '/api/auth/register/verify',
      '/api/auth/login/verify',
      '/api/auth/copy-status',
      '/api/settings/security/devices',
      '/api/settings/security/sign-out-session',
      '/api/settings/security/delete-account',
      '/api/settings/security/recovery-code',
    ];
    for (const path of paths)
      for (const body of ['null', '5', '"text"', '[1, 2]', '{broken', '']) {
        const r = await call('POST', path, body);
        expect(r.status, `${path} ${body}`).toBeLessThan(500);
        expect(() => r.json(), `${path} ${body}: ${r.text.slice(0, 40)}`).not.toThrow();
      }
    // A phone's saved copy that can't be named is off.
    expect((await call('POST', '/api/auth/copy-status', 'null')).json()).toEqual({ off: true });
  });

  it('a route the Directory doesn’t have answers JSON', async () => {
    for (const [method, path] of [
      ['GET', '/api/auth/nope'],
      ['DELETE', '/api/auth/logout'],
      ['GET', '/api/settings/security/nope'],
    ] as const) {
      const r = await call(method, path, '{}');
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json()).toMatchObject({ error: 'not_found' });
    }
  });

  it('Sign out with a body of null still signs out', async () => {
    const r = await call('POST', '/api/settings/security/sign-out', 'null');
    expect(r.status).toBe(200);
    expect(r.sc).toContain('Max-Age=0');
    expect((await call('GET', '/api/session', undefined)).status).toBe(401);
  });
});
