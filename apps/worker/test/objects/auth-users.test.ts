// Sign-in with more than one user (docs/multi-user.md 7.1, 7.2, 11): passkeys, sessions and device links belong to a
// user, every security route sees only the signed-in user's, a passkey answers only for its own user, and a disabled
// user's session stops working. Through the real Worker with software passkeys.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { tokenHash } from '../../src/http/auth.js';
import { SoftAuthenticator, b64u } from '../soft-authenticator.js';
import { directoryDb, storeDb } from '../store-db.js';

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
    const h: Record<string, string> = { origin: ORIGIN, 'x-ledgerline-sealed': '1' };
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
    // The device link's passkey signed this browser in as it was made: it has been used, not "not used yet".
    expect((mine.json.passkeys as { lastUsedAt: string | null }[])[0]!.lastUsedAt).toBe(
      new Date(now).toISOString(),
    );
    // The second user can't remove the owner's passkey (and the owner's only passkey stays).
    expect((await other.call('POST', `/api/settings/security/passkeys/${ownerKey.id}/remove`)).status).toBe(
      409,
    );
    expect(
      await dir.prepare(`SELECT count(*) AS n FROM passkey WHERE id = ?1`).bind(ownerKey.id).first('n'),
    ).toBe(1);
    // Nor rename it.
    expect(
      (await other.call('POST', `/api/settings/security/passkeys/${ownerKey.id}/rename`, { name: 'Mine' }))
        .status,
    ).toBe(404);
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

  it('signing in as another user on the same browser ends the earlier user’s session there', async () => {
    const shared = new Browser();
    expect((await shared.signIn(ownerKey)).status).toBe(200);
    const ownerSessions = async () =>
      await dir
        .prepare(
          `SELECT count(*) AS n FROM auth_session WHERE user_id = (SELECT user_id FROM passkey WHERE id = ?1)`,
        )
        .bind(ownerKey.id)
        .first<number>('n');
    const withShared = await ownerSessions();
    // The second user signs in on that browser: the owner's session there goes, so it doesn't list as another device.
    expect((await shared.signIn(otherKey)).status).toBe(200);
    expect(await ownerSessions()).toBe(withShared! - 1);
    expect(JSON.stringify((await shared.call('GET', '/api/session')).json)).toContain('b_b');
    // The owner's own browser is still signed in.
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
    await shared.call('POST', '/api/auth/logout');
  });

  it('lists each sign-in and ends one at a time, only the user’s own and never this one', async () => {
    const laptop = new Browser();
    expect((await laptop.signIn(otherKey)).status).toBe(200);
    const list = (await other.call('GET', '/api/settings/security')).json.signIns as {
      id: string;
      name: string;
      current: boolean;
    }[];
    expect(list.map((x) => x.current).sort()).toEqual([false, true]);
    // Ids are not the stored session ids (the cookie's hash).
    const stored = (await dir.prepare(`SELECT id FROM auth_session`).all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    for (const x of list) expect(stored).not.toContain(x.id);
    const here = list.find((x) => x.current)!;
    const there = list.find((x) => !x.current)!;
    // This device ends with Sign out, not here; another user can't end it either.
    expect(
      (await other.call('POST', '/api/settings/security/sign-out-session', { id: here.id })).status,
    ).toBe(404);
    expect(
      (await owner.call('POST', '/api/settings/security/sign-out-session', { id: there.id })).status,
    ).toBe(404);
    expect((await laptop.call('GET', '/api/settings/security')).status).toBe(200);
    expect(
      (await other.call('POST', '/api/settings/security/sign-out-session', { id: there.id })).status,
    ).toBe(200);
    expect((await laptop.call('GET', '/api/settings/security')).status).toBe(401);
    expect((await other.call('GET', '/api/settings/security')).status).toBe(200);
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

  it('only the admin may link a new bank, and the session says so (docs/open-signup.md 5)', async () => {
    // Refused before Plaid is asked: a bank route answers only for a locked budget, a new link needs the budget's
    // key, and then an admin (seal/sealed-routes.ts).
    expect((await other.call('POST', '/api/settings/connections/link-token', { mode: 'new' })).status).toBe(
      409,
    );
    const store = storeDb('b_b');
    await store.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', 1)`).run();
    const b = await other.call('POST', '/api/settings/connections/link-token', { mode: 'new' });
    await store.prepare(`DELETE FROM store_mark`).run();
    expect(b.status).toBe(403);
    expect((await other.call('GET', '/api/session')).json.canLinkBanks).toBe(false);
    expect((await owner.call('GET', '/api/session')).json.canLinkBanks).toBe(true);
  });

  it('a disabled user’s sessions stop working and they can’t sign in', async () => {
    await dir.prepare(`UPDATE user SET status = 'disabled' WHERE id = 'u_b'`).run();
    expect((await other.call('GET', '/api/session')).status).toBe(401);
    expect((await new Browser().signIn(otherKey)).status).toBe(403);
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
  });
});

describe('sign-in fixes for other users (docs/open-signup.md 3.3, 3.4, 6)', () => {
  it('a passkey answer without its user handle is refused', async () => {
    expect((await new Browser().signIn(ownerKey, { noUserHandle: true })).status).toBe(403);
    expect((await new Browser().signIn(ownerKey)).status).toBe(200);
  });

  it('a challenge works once, even after a fresh passkey check changes the session', async () => {
    const b = new Browser();
    const o = await b.call('POST', '/api/auth/login/options');
    const first = await ownerKey.get(o.json as never);
    const second = await ownerKey.get(o.json as never); // a second answer to the same challenge
    const jar = new Map(b.jar);
    expect((await b.call('POST', '/api/auth/login/verify', { response: first })).status).toBe(200);
    // A fresh passkey check on the same browser moves the session's challenge_id to the new challenge.
    expect((await b.signIn(ownerKey)).status).toBe(200);
    const thief = new Browser();
    thief.jar = jar;
    expect((await thief.call('POST', '/api/auth/login/verify', { response: second })).status).toBe(400);
  });

  it('setup opens again only when no admin has a passkey, and never touches other users', async () => {
    const status = async () => (await new Browser().call('GET', '/api/auth/status')).json;
    expect((await status()).setupOpen).toBe(false);
    expect(
      (await new Browser().register(new SoftAuthenticator(ORIGIN, 'ledgerline.test'), { setupCode: SETUP }))
        .status,
    ).toBe(403);
    // The runbook's recovery (docs/runbooks/setup.md): only the admin's sessions and passkeys go.
    await dir.batch([
      dir.prepare(`DELETE FROM auth_session WHERE user_id IN (SELECT id FROM user WHERE is_admin = 1)`),
      dir.prepare(`DELETE FROM passkey WHERE user_id IN (SELECT id FROM user WHERE is_admin = 1)`),
    ]);
    expect(await dir.prepare(`SELECT count(*) AS n FROM passkey WHERE user_id = 'u_b'`).first('n')).toBe(1);
    expect((await status()).setupOpen).toBe(true);
    const newKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
    const b = new Browser();
    expect((await b.register(newKey, { setupCode: SETUP })).status).toBe(200);
    // The new passkey is the admin's, with the admin's handle; no new user or budget was made.
    const admin = await dir.prepare(`SELECT id FROM user WHERE is_admin = 1`).first<string>('id');
    expect(
      await dir.prepare(`SELECT user_id FROM passkey WHERE id = ?1`).bind(newKey.id).first('user_id'),
    ).toBe(admin);
    expect(newKey.userHandle).toBe(b64u(new TextEncoder().encode('ledgerline-owner')));
    expect(await dir.prepare(`SELECT count(*) AS n FROM user`).first('n')).toBe(2);
    expect(await dir.prepare(`SELECT count(*) AS n FROM budget`).first('n')).toBe(2);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
    expect((await status()).setupOpen).toBe(false);
  });
});
