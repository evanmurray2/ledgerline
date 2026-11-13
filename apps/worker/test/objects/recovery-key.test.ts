// Signing in with the recovery key of a locked budget (routes/recovery-key.ts; docs/privacy-keys.md 4.2), and the
// fresh way in a session counts as (D-89), through the real Worker with software passkeys.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { newRecoveryKey, recoverySlot, signRecoveryLogin, toHex, fromHex } from '@ledgerline/seal';
import worker from '../../src/index.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb, directoryStub } from '../store-db.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const dir = directoryDb();
const prodEnv = () =>
  ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined, SETUP_CODE: SETUP }) as never;

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
      const [pair] = sc.split(';');
      const [k, v] = pair!.split('=') as [string, string];
      this.jar.set(k.trim(), v);
    }
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  }
  cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

type Auth = { privateKey: CryptoKey; pub: Uint8Array };
const authOf = async (r: Uint8Array): Promise<Auth> =>
  ((await recoverySlot(r, 1)) as unknown as { auth: Auth }).auth;

/** The recovery-key sign-in up to the passkey's options: the key's public half, then the signature. */
async function prove(b: Browser, auth: Auth, sign = auth) {
  const o = await b.call('POST', '/api/auth/recover-key/options', { authPub: toHex(auth.pub) });
  if (o.status !== 200) return o;
  const signature = await signRecoveryLogin(
    sign.privateKey,
    o.json.budgetId as string,
    fromHex(o.json.challenge as string),
  );
  return b.call('POST', '/api/auth/recover-key/verify', { signature: toHex(signature) });
}

const owner = new Browser();
const ownerKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const recovery = newRecoveryKey();
let budgetId = '';

describe('the recovery key signs in', () => {
  it('a key that is not set signs in nobody', async () => {
    const o = await owner.call('POST', '/api/auth/register/options', { setupCode: SETUP });
    expect(o.status).toBe(200);
    const v = await owner.call('POST', '/api/auth/register/verify', {
      response: await ownerKey.create(o.json as never),
      name: 'Phone',
    });
    expect(v.status).toBe(200);
    budgetId = ((await owner.call('GET', '/api/session')).json.budget as { id: string }).id;
    expect((await prove(new Browser(), await authOf(recovery))).status).toBe(403);
    expect(
      (await new Browser().call('POST', '/api/auth/recover-key/options', { authPub: 'zz' })).status,
    ).toBe(403);
  });

  it('a signed-in device sets the key’s public half, once its passkey was checked', async () => {
    const auth = await authOf(recovery);
    expect((await owner.call('GET', '/api/settings/security/recovery-key')).json).toMatchObject({
      set: false,
    });
    expect(
      (await owner.call('POST', '/api/settings/security/recovery-key', { authPub: 'nope' })).status,
    ).toBe(400);
    expect(
      (await owner.call('POST', '/api/settings/security/recovery-key', { authPub: toHex(auth.pub) })).status,
    ).toBe(200);
    // The same key again is fine.
    expect(
      (await owner.call('POST', '/api/settings/security/recovery-key', { authPub: toHex(auth.pub) })).status,
    ).toBe(200);
    expect((await owner.call('GET', '/api/settings/security/recovery-key')).json).toMatchObject({
      set: true,
    });
    // Only the public half is stored.
    expect(await dir.prepare(`SELECT auth_pub FROM recovery_key`).first('auth_pub')).toBe(toHex(auth.pub));
    // Without a recent passkey check, it is refused.
    await dir.prepare(`UPDATE auth_session SET verified_at = verified_at - 3600000`).run();
    expect(
      (await owner.call('POST', '/api/settings/security/recovery-key', { authPub: toHex(auth.pub) })).json,
    ).toMatchObject({ error: 'reauth' });
    await dir.prepare(`UPDATE auth_session SET verified_at = verified_at + 3600000`).run();
  });

  it('gives the budget id and a challenge; a signature by another key, or none, is refused', async () => {
    const auth = await authOf(recovery);
    const b = new Browser();
    const o = await b.call('POST', '/api/auth/recover-key/options', { authPub: toHex(auth.pub) });
    expect(o.status).toBe(200);
    expect(o.json.budgetId).toBe(budgetId);
    expect(o.json.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (await b.call('POST', '/api/auth/recover-key/verify', { signature: '00'.repeat(64) })).status,
    ).toBe(403);
    expect((await prove(new Browser(), auth, await authOf(newRecoveryKey()))).status).toBe(403);
    // No challenge cookie: nothing.
    expect(
      (await new Browser().call('POST', '/api/auth/recover-key/verify', { signature: '00' })).status,
    ).toBe(400);
  });

  it('a good signature works once and adds a new passkey that signs in, fresh for 7 days', async () => {
    const auth = await authOf(recovery);
    const b = new Browser();
    const options = await prove(b, auth);
    expect(options.status).toBe(200);
    // The same signature again (its challenge is used): refused.
    expect((await b.call('POST', '/api/auth/recover-key/verify', {})).status).toBe(400);
    const lost = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
    const before = Number(await dir.prepare(`SELECT count(*) AS n FROM passkey`).first('n'));
    const v = await b.call('POST', '/api/auth/register/verify', {
      response: await lost.create(options.json as never),
      name: 'New phone',
    });
    expect(v.status).toBe(200);
    expect(Number(await dir.prepare(`SELECT count(*) AS n FROM passkey`).first('n'))).toBe(before + 1);
    const s = await b.call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect((s.json.budget as { id: string }).id).toBe(budgetId);
    // Nothing was removed: the owner's own passkey still signs in.
    expect((await owner.call('GET', '/api/session')).status).toBe(200);

    // The new passkey's session is a fresh way in (D-89); the old passkey's is not.
    const fresh = await directoryStub().authenticate(b.cookie(), 'GET', '/api/session');
    expect(fresh.ok && fresh.caller.freshWay).toBe(true);
    await dir
      .prepare(`UPDATE passkey SET created_at = created_at - ?1 WHERE name = 'Phone'`)
      .bind(8 * 86_400_000)
      .run();
    const old = await directoryStub().authenticate(owner.cookie(), 'GET', '/api/session');
    expect(old.ok && old.caller.freshWay).toBe(false);
  });

  it('a new key replaces the old one, which signs in no more', async () => {
    const next = await authOf(newRecoveryKey());
    expect(
      (await owner.call('POST', '/api/settings/security/recovery-key', { authPub: toHex(next.pub) })).status,
    ).toBe(200);
    expect((await prove(new Browser(), await authOf(recovery))).status).toBe(403);
    expect((await prove(new Browser(), next)).status).toBe(200);
  });
});
