// Sign-in with more than one user (docs/multi-user.md 7.1, 7.2, 11): passkeys, sessions and device links belong to a
// user, every security route sees only the signed-in user's, a passkey answers only for its own user, and a disabled
// user's session stops working. Through the real Worker with software passkeys.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { tokenHash } from '../../src/http/auth.js';
import { SoftAuthenticator, b64u } from '../soft-authenticator.js';
import { directoryDb } from '../store-db.js';

const dir = directoryDb();

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const now = Date.parse('2026-11-14T20:00:00Z');
const prodEnv = () =>
  ({
    ...env,
    DEV_AUTH_EMAIL: undefined,
    DEV_ROUTES: undefined,
    SETUP_CODE: SETUP,
    FAKE_NOW: new Date(now).toISOString(),
  }) as never;

class Browser {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown) {
    const h: Record<string, string> = { origin: ORIGIN };
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

const ownerKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const otherKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const owner = new Browser();
const other = new Browser();

/** A second user, created directly (sign-up isn't built yet), who adds their passkey through a device link. */
async function addSecondUser(): Promise<void> {
  const token = 'second-user-device-link-token-0123456789';
  await dir.batch([
    dir.prepare(
      `INSERT INTO user (id, email, webauthn_handle, created_at, updated_at) VALUES ('u_b', 'u:u_b', 'handle-of-b', 0, 0)`,
    ),
    dir.prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES ('b_b', 'B', 0, 0)`),
    dir.prepare(
      `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES ('b_b', 'u_b', 'owner', 0, 0)`,
    ),
    dir
      .prepare(
        `INSERT INTO device_link (token_hash, created_at, expires_at, user_id) VALUES (?1, 0, ?2, 'u_b')`,
      )
      .bind(await tokenHash(token), now + 600_000),
  ]);
  expect((await other.register(otherKey, { deviceToken: token })).status).toBe(200);
}

describe('more than one user', () => {
  it('setup creates the first user as admin, with the handle earlier passkeys used', async () => {
    expect((await owner.register(ownerKey, { setupCode: SETUP })).status).toBe(200);
    const u = await dir.prepare(`SELECT id, is_admin, link_allowance, webauthn_handle FROM user`).first<{
      id: string;
      is_admin: number;
      link_allowance: number;
      webauthn_handle: string;
    }>();
    expect(u).toMatchObject({ is_admin: 1, link_allowance: 10, webauthn_handle: 'ledgerline-owner' });
    expect(await dir.prepare(`SELECT user_id FROM passkey`).first('user_id')).toBe(u!.id);
    expect(ownerKey.userHandle).toBe(b64u(new TextEncoder().encode('ledgerline-owner')));
  });

  it('a second user signs in to their own budget with their own handle', async () => {
    await addSecondUser();
    expect(otherKey.userHandle).toBe(b64u(new TextEncoder().encode('handle-of-b')));
    const a = await owner.call('GET', '/api/session');
    const b = await other.call('GET', '/api/session');
    expect(b.status).toBe(200);
    expect(JSON.stringify(b.json)).toContain('b_b');
    expect(JSON.stringify(a.json)).not.toContain('b_b');
  });

  it('each user sees, removes and signs out only their own passkeys and sessions', async () => {
    const mine = await other.call('GET', '/api/settings/security');
    expect((mine.json.passkeys as { id: string }[]).map((p) => p.id)).toEqual([otherKey.id]);
    expect(mine.json.sessions).toBe(1);
    // The second user can't remove the owner's passkey (and the owner's only passkey stays).
    expect((await other.call('POST', `/api/settings/security/passkeys/${ownerKey.id}/remove`)).status).toBe(
      409,
    );
    expect(
      await dir.prepare(`SELECT count(*) AS n FROM passkey WHERE id = ?1`).bind(ownerKey.id).first('n'),
    ).toBe(1);
    // Signing out everywhere else ends only the second user's other sessions.
    await other.call('POST', '/api/settings/security/sign-out-others');
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
  });

  it('signing in again on a browser replaces its session, so only real other devices count', async () => {
    const before = await other.call('GET', '/api/settings/security');
    expect(before.json.otherSessions).toBe(0);
    // Unlocking the phone's copy signs in each time: the earlier session goes, nothing is left behind.
    expect((await other.signIn(otherKey)).status).toBe(200);
    expect((await other.signIn(otherKey)).status).toBe(200);
    const again = await other.call('GET', '/api/settings/security');
    expect(again.json).toMatchObject({ sessions: 1, otherSessions: 0 });
    // A second browser is another device.
    const laptop = new Browser();
    expect((await laptop.signIn(otherKey)).status).toBe(200);
    expect((await other.call('GET', '/api/settings/security')).json).toMatchObject({
      sessions: 2,
      otherSessions: 1,
    });
    await other.call('POST', '/api/settings/security/sign-out-others');
    expect((await laptop.call('GET', '/api/settings/security')).status).toBe(401);
    expect((await other.call('GET', '/api/settings/security')).json.otherSessions).toBe(0);
  });

  it('registration for a user excludes only their own passkeys and never reveals another user’s', async () => {
    const o = await owner.call('POST', '/api/auth/register/options', {});
    const ids = ((o.json.excludeCredentials as { id: string }[]) ?? []).map((x) => x.id);
    expect(ids).toContain(ownerKey.id);
    expect(ids).not.toContain(otherKey.id);
  });

  it('a passkey that answers with another user’s handle is refused', async () => {
    const thief = new Browser();
    const r = await thief.signIn(otherKey, {
      userHandle: b64u(new TextEncoder().encode('ledgerline-owner')),
    });
    expect(r.status).toBe(403);
    expect((await thief.signIn(otherKey)).status).toBe(200);
  });

  it('a disabled user’s sessions stop working and they can’t sign in', async () => {
    await dir.prepare(`UPDATE user SET status = 'disabled' WHERE id = 'u_b'`).run();
    expect((await other.call('GET', '/api/session')).status).toBe(401);
    expect((await new Browser().signIn(otherKey)).status).toBe(403);
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
  });
});
