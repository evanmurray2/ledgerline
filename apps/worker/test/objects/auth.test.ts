// Passkey sign-in, sessions, the recent-passkey rule, device links and the ops token (decisions.md D-27), through
// the real Worker with a software passkey.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { Scoped } from '../../src/db/scoped.js';
import { devSignIn } from '../../src/http/auth.js';
import type { Env } from '../../src/env.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb } from '../store-db.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const OPS = 'o'.repeat(40);
const now = Date.parse('2026-11-14T20:00:00Z');
const dir = directoryDb();

/**
 * Time passing for sign-in: the Directory keeps its own clock (FAKE_NOW in vitest.objects.config.ts), so the
 * sessions and their last passkey check are moved back instead.
 */
async function later(ms: number): Promise<void> {
  await dir
    .prepare(
      `UPDATE auth_session SET created_at = created_at - ?1, verified_at = verified_at - ?1, expires_at = expires_at - ?1`,
    )
    .bind(ms)
    .run();
}

/** The Worker's env as production would have it: no dev sign-in (the objects' own bindings say the same). */
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
    const h: Record<string, string> = { origin: ORIGIN, 'x-ledgerline-sealed': '1', ...headers };
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
      signupOpen: false,
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

  it('starting a sign-in writes nothing (the challenge is a signed cookie)', async () => {
    const count = async () =>
      Number(
        await dir
          .prepare(`SELECT (SELECT count(*) FROM auth_challenge) + (SELECT count(*) FROM auth_session) AS n`)
          .first('n'),
      );
    const before = await count();
    for (let i = 0; i < 5; i++) await new Browser().call('POST', '/api/auth/login/options');
    expect(await count()).toBe(before);
  });

  it('sign-in attempts are limited per IP', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    const codes: number[] = [];
    for (let i = 0; i < 25; i++)
      codes.push((await new Browser().call('POST', '/api/auth/login/options', {}, ip)).status);
    expect(codes).toContain(429);
    expect(codes.filter((s) => s === 200).length).toBeLessThanOrEqual(20);
    // Another address isn't affected.
    expect(
      (
        await new Browser().call(
          'POST',
          '/api/auth/login/options',
          {},
          { 'cf-connecting-ip': '203.0.113.10' },
        )
      ).status,
    ).toBe(200);
  });

  it('a sign-in with a broken body is a plain 400, not a server error', async () => {
    for (const path of ['/api/auth/login/verify', '/api/auth/register/verify']) {
      const res = await worker.fetch(
        new Request(ORIGIN + path, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' },
          body: 'not json',
        }),
        prodEnv(),
        createExecutionContext(),
      );
      expect(res.status).toBe(400);
    }
  });

  it('the local sign-in shortcut is off wherever a setup code exists, and on Plaid Production', () => {
    const base = { DEV_AUTH_EMAIL: 'owner@example.com', PLAID_ENV: 'sandbox' } as never as Env;
    expect(devSignIn(base)).toBe(true);
    expect(devSignIn({ ...base, SETUP_CODE: SETUP })).toBe(false);
    expect(devSignIn({ ...base, PLAID_ENV: 'production' })).toBe(false);
    expect(devSignIn({ ...base, DEV_AUTH_EMAIL: undefined })).toBe(false);
  });

  it('sign-up and recovery codes answer 404 while the switch is off (D-75)', async () => {
    for (const path of ['/api/auth/signup/options', '/api/auth/recover/options'])
      expect(
        (await new Browser().call('POST', path, { name: 'X', code: 'X', turnstileToken: 'X' })).status,
      ).toBe(404);
    expect((await new Browser().call('GET', '/api/auth/status')).json.signupOpen).toBe(false);
  });

  it('a challenge is single-use', async () => {
    const o = await b.call('POST', '/api/auth/login/options');
    const resp = await phone.get(o.json as never);
    const jar = new Map(b.jar);
    expect((await b.call('POST', '/api/auth/login/verify', { response: resp })).status).toBe(200);
    b.jar = jar;
    expect((await b.call('POST', '/api/auth/login/verify', { response: resp })).status).toBe(400);
  });

  it('linking a bank needs a passkey check within 15 minutes', async () => {
    await later(16 * 60 * 1000);
    const r = await b.call('POST', '/api/settings/connections/link-token', {});
    expect(r).toMatchObject({ status: 401, json: { error: 'reauth' } });
    expect((await b.call('GET', '/api/session')).status).toBe(200); // everything else still works
    // Syncing banks now isn't sensitive: pull to sync and Try again work without the check.
    expect((await b.call('POST', '/api/settings/connections/refresh')).json).not.toMatchObject({
      error: 'reauth',
    });
    expect((await b.call('POST', '/api/settings/connections/c1/refresh')).json).not.toMatchObject({
      error: 'reauth',
    });
    expect((await b.call('POST', '/api/settings/security/device-link')).json).toMatchObject({
      error: 'reauth',
    });
    expect((await b.signIn(phone)).status).toBe(200); // same session, fresh check
    expect((await b.call('POST', '/api/settings/security/device-link')).status).toBe(200);
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
    await later(24 * 60 * 60 * 1000);
    expect((await b.call('GET', '/api/session')).status).toBe(401);
    expect((await b.signIn(phone)).status).toBe(200);
  });

  it('you can rename a passkey, but only your own and only to 1 to 60 characters', async () => {
    const rename = (id: string, name: unknown) =>
      b.call('POST', `/api/settings/security/passkeys/${id}/rename`, { name });
    expect((await rename(phone.id, '  Apple Passwords ')).status).toBe(200);
    const sec = await b.call('GET', '/api/settings/security');
    const names = (sec.json.passkeys as { id: string; name: string }[]).map((k) => [k.id, k.name]);
    expect(names).toContainEqual([phone.id, 'Apple Passwords']);
    expect((await rename(phone.id, '   ')).status).toBe(400);
    expect((await rename(phone.id, 'x'.repeat(61))).status).toBe(400);
    expect((await rename(phone.id, 5)).status).toBe(400);
    expect((await rename('nope', 'Mine')).status).toBe(404);
  });

  it('you can remove a passkey but never the last one', async () => {
    expect((await b.call('POST', `/api/settings/security/passkeys/${laptop.id}/remove`)).status).toBe(200);
    expect((await b.call('POST', `/api/settings/security/passkeys/${phone.id}/remove`)).status).toBe(409);
  });

  it('the ops token reads health, nothing else', async () => {
    const ops = new Browser();
    const bearer = { authorization: `Bearer ${OPS}` };
    expect((await ops.call('GET', '/api/health', undefined, bearer)).status).toBe(200);
    // It shows how many accounts are marked idle (24 months unopened) and how many deletions are under way.
    await dir
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES ('expire:b_x', '0', 0), ('expire:b_y', '0', 0), ('deleting:b_z', 'u_z', 0)`,
      )
      .run();
    const health = await ops.call('GET', '/api/health', undefined, bearer);
    expect(health.json).toMatchObject({ ok: expect.any(Boolean), idleAccounts: { marked: 2, deleting: 1 } });
    await dir
      .prepare(`DELETE FROM app_state WHERE key IN ('expire:b_x', 'expire:b_y', 'deleting:b_z')`)
      .run();
    expect((await ops.call('POST', '/api/ops/backup-done', {}, bearer)).status).toBe(403);
    expect((await ops.call('GET', '/api/session', undefined, bearer)).status).toBe(403);
    expect((await ops.call('GET', '/api/health', undefined, { authorization: 'Bearer nope' })).status).toBe(
      401,
    );
  });
});

describe('signing out', () => {
  it('needs no fresh passkey check, and ends the session', async () => {
    await later(60 * 60 * 1000);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
    expect((await b.call('POST', '/api/settings/security/sign-out')).status).toBe(200);
    expect((await b.call('GET', '/api/session')).status).toBe(401);
  });
});

describe('budget-scoped data access', () => {
  it('refuses a query that does not bind the budget id as ?1', () => {
    const s = new Scoped(dir, 'b1', 'u1');
    expect(() => s.q(`SELECT * FROM category`)).toThrow(/budget id/);
    expect(() => s.q(`SELECT * FROM category WHERE budget_id = ?1`)).not.toThrow();
  });
});
