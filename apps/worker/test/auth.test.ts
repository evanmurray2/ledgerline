// Passkey sign-in, sessions, the recent-passkey rule, device links and the ops token (decisions.md D-27), through
// the real Worker with a software passkey.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { Scoped } from '../src/db/scoped.js';
import { SoftAuthenticator } from './soft-authenticator.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const OPS = 'o'.repeat(40);
let now = Date.parse('2026-11-14T20:00:00Z');

/** The Worker's env as production would have it: no dev sign-in. */
const prodEnv = () =>
  ({
    ...env,
    DEV_AUTH_EMAIL: undefined,
    DEV_ROUTES: undefined,
    SETUP_CODE: SETUP,
    OPS_TOKEN: OPS,
    FAKE_NOW: new Date(now).toISOString(),
  }) as never;

/** One browser: a cookie jar. */
class Browser {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      h['content-type'] = 'application/json';
      h['x-ledgerline'] = '1';
    }
    const res = await worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: h,
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      }),
      prodEnv(),
      createExecutionContext(),
    );
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const [pair, ...attrs] = sc.split(';');
      const [k, v] = pair!.split('=') as [string, string];
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) this.jar.delete(k.trim());
      else this.jar.set(k.trim(), v);
    }
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  }
  async register(a: SoftAuthenticator, start: Record<string, unknown>) {
    const o = await this.call('POST', '/api/auth/register/options', start);
    if (o.status !== 200) return o;
    return this.call('POST', '/api/auth/register/verify', {
      response: await a.create(o.json as never),
      name: 'Test',
    });
  }
  async signIn(a: SoftAuthenticator, opts: Parameters<SoftAuthenticator['get']>[1] = {}) {
    const o = await this.call('POST', '/api/auth/login/options');
    return this.call('POST', '/api/auth/login/verify', { response: await a.get(o.json as never, opts) });
  }
}

const phone = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const laptop = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const b = new Browser();

describe('passkey sign-in', () => {
  it('nothing is reachable before setup, and setup needs the setup code', async () => {
    expect((await b.call('GET', '/api/session')).status).toBe(401);
    expect((await b.call('GET', '/api/auth/status')).json).toEqual({
      signedIn: false,
      hasPasskey: false,
      setupOpen: true,
    });
    expect((await b.register(phone, { setupCode: 'wrong'.repeat(10) })).status).toBe(403);
    expect((await b.register(phone, { setupCode: SETUP })).status).toBe(200);
    expect(b.jar.has('__Host-ledgerline')).toBe(true);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
  });

  it('the setup code stops working once a passkey exists', async () => {
    const other = new Browser();
    expect((await other.register(laptop, { setupCode: SETUP })).status).toBe(403);
    expect((await other.call('GET', '/api/auth/status')).json).toMatchObject({
      hasPasskey: true,
      setupOpen: false,
    });
  });

  it('sign out, then sign in with the passkey; a wrong key or origin is refused', async () => {
    await b.call('POST', '/api/auth/logout');
    expect((await b.call('GET', '/api/session')).status).toBe(401);
    const stranger = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
    await stranger.create({ challenge: 'x' });
    expect((await b.signIn(phone, { signWith: stranger })).status).toBe(403);
    expect((await b.signIn(phone, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await b.call('GET', '/api/session')).status).toBe(401);
    expect((await b.signIn(phone)).status).toBe(200);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
  });

  it('a challenge is single-use', async () => {
    const o = await b.call('POST', '/api/auth/login/options');
    const resp = await phone.get(o.json as never);
    const jar = new Map(b.jar);
    expect((await b.call('POST', '/api/auth/login/verify', { response: resp })).status).toBe(200);
    b.jar = jar;
    expect((await b.call('POST', '/api/auth/login/verify', { response: resp })).status).toBe(400);
  });

  it('linking a bank and exports need a passkey check within 15 minutes', async () => {
    now += 16 * 60 * 1000;
    const r = await b.call('POST', '/api/settings/connections/link-token', {});
    expect(r).toMatchObject({ status: 401, json: { error: 'reauth' } });
    expect((await b.call('GET', '/api/export/json')).json).toMatchObject({ error: 'reauth' });
    expect((await b.call('GET', '/api/session')).status).toBe(200); // everything else still works
    expect((await b.call('POST', '/api/settings/security/device-link')).json).toMatchObject({
      error: 'reauth',
    });
    expect((await b.signIn(phone)).status).toBe(200); // same session, fresh check
    expect((await b.call('GET', '/api/export/json')).status).toBe(200);
  });

  it('a device link adds a passkey once, then stops working', async () => {
    const link = await b.call('POST', '/api/settings/security/device-link');
    expect(link.status).toBe(200);
    const token = String(link.json.url).split('#')[1]!;
    const newDevice = new Browser();
    expect((await newDevice.register(laptop, { deviceToken: token })).status).toBe(200);
    expect((await newDevice.call('GET', '/api/session')).status).toBe(200);
    const third = new Browser();
    const again = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
    expect((await third.register(again, { deviceToken: token })).status).toBe(403);
    const sec = await b.call('GET', '/api/settings/security');
    expect((sec.json.passkeys as unknown[]).length).toBe(2);
  });

  it('a session ends after 24 hours', async () => {
    now += 24 * 60 * 60 * 1000;
    expect((await b.call('GET', '/api/session')).status).toBe(401);
    expect((await b.signIn(phone)).status).toBe(200);
  });

  it('you can remove a passkey but never the last one', async () => {
    expect((await b.call('POST', `/api/settings/security/passkeys/${laptop.id}/remove`)).status).toBe(200);
    expect((await b.call('POST', `/api/settings/security/passkeys/${phone.id}/remove`)).status).toBe(409);
  });

  it('the ops token reads health, nothing else', async () => {
    const ops = new Browser();
    const bearer = { authorization: `Bearer ${OPS}` };
    expect((await ops.call('GET', '/api/health', undefined, bearer)).status).toBe(200);
    expect((await ops.call('POST', '/api/ops/backup-done', {}, bearer)).status).toBe(403);
    // Only the monitor's own checks count for the "Monitoring stopped" alert.
    const checks = () =>
      env.DB.prepare(`SELECT count(*) AS n FROM health_status WHERE key = 'last_monitor_check_at'`).first<{
        n: number;
      }>();
    expect((await checks())!.n).toBe(0);
    await ops.call('GET', '/api/health', undefined, { ...bearer, 'x-ledgerline-monitor': '1' });
    expect((await checks())!.n).toBe(1);
    expect((await ops.call('GET', '/api/session', undefined, bearer)).status).toBe(403);
    expect((await ops.call('GET', '/api/health', undefined, { authorization: 'Bearer nope' })).status).toBe(
      401,
    );
  });
});

describe('signing out', () => {
  it('needs no fresh passkey check, and ends the session', async () => {
    now += 60 * 60 * 1000;
    expect((await b.call('GET', '/api/session')).status).toBe(200);
    expect((await b.call('POST', '/api/settings/security/sign-out')).status).toBe(200);
    expect((await b.call('GET', '/api/session')).status).toBe(401);
  });
});

describe('budget-scoped data access', () => {
  it('refuses a query that does not bind the budget id as ?1', () => {
    const s = new Scoped(env.DB, 'b1', 'u1');
    expect(() => s.q(`SELECT * FROM category`)).toThrow(/budget id/);
    expect(() => s.q(`SELECT * FROM category WHERE budget_id = ?1`)).not.toThrow();
  });
});
