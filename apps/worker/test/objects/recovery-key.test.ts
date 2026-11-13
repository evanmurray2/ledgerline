// Signing in with the recovery key of a locked budget (routes/recovery-key.ts; docs/privacy-keys.md 4.2), and the
// fresh way in a session counts as (D-89), through the real Worker with software passkeys.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ACTION,
  type Action,
  type BudgetKeys,
  newRecoveryKey,
  recoverySlot,
  signRecoveryLogin,
  signRequest,
  toHex,
  fromHex,
  utf8,
} from '@ledgerline/seal';
import { genesisIn } from '../signed.js';
import worker from '../../src/index.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb, directoryStub, storeDb } from '../store-db.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const dir = directoryDb();
const prodEnv = () =>
  ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined, SETUP_CODE: SETUP }) as never;

class Browser {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, 'x-ledgerline-sealed': '1', ...extra };
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
/** A second session of the same person: the one the recovery key signed in. */
let second = new Browser();

describe('the recovery key signs in', () => {
  it('a key that is not set signs in nobody', async () => {
    const o = await owner.call('POST', '/api/auth/register/options', { setupCode: SETUP });
    expect(o.status).toBe(200);
    const v = await owner.call('POST', '/api/auth/register/verify', {
      response: await ownerKey.create(o.json as never),
      name: 'Phone',
    });
    expect(v.status).toBe(200);
    budgetId = (await owner.call('GET', '/api/session')).json.budgetId as string;
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
    second = b;
    expect(Number(await dir.prepare(`SELECT count(*) AS n FROM passkey`).first('n'))).toBe(before + 1);
    const s = await b.call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect(s.json.budgetId as string).toBe(budgetId);
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

/** A request signed with the budget's key (http/signed-request.ts): a challenge for `who`'s session, then the signature. */
async function signedCall(
  who: Browser,
  path: string,
  body: unknown,
  sign: { keys: BudgetKeys; action: Action; asker?: Browser; body?: unknown },
) {
  const ch = await (sign.asker ?? who).call('POST', '/api/settings/security/request-challenge', {
    action: sign.action,
  });
  expect(ch.status).toBe(200);
  const text = JSON.stringify(sign.body ?? body);
  const sig = await signRequest(
    sign.keys,
    budgetId,
    sign.action,
    fromHex(ch.json.challenge as string),
    utf8(text),
  );
  return who.call('POST', path, body, {
    'x-ledgerline-challenge': ch.json.token as string,
    'x-ledgerline-signature': toHex(sig),
  });
}

describe('a locked budget: its serious requests are signed with the budget’s key', () => {
  it('sets the recovery key’s sign-in half only with a signature, bound to the session and used once', async () => {
    // The owner's budget is locked: its store has a log, whose signing key this test's device holds.
    const db = storeDb(budgetId);
    await db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(Date.now()).run();
    const w = await genesisIn(db, budgetId, Date.parse('2026-11-14T20:00:00Z'));
    const next = toHex((await authOf(newRecoveryKey())).pub);
    const path = '/api/settings/security/recovery-key';
    const before = await dir.prepare(`SELECT auth_pub FROM recovery_key`).first('auth_pub');
    // A session alone (a stolen one, with a fresh passkey check) can't.
    expect(await owner.call('POST', path, { authPub: next })).toMatchObject({
      status: 403,
      json: { error: 'unsigned' },
    });
    // Nor with a challenge given to another session, another request's challenge, or a body other than the one signed.
    expect(
      await signedCall(
        owner,
        path,
        { authPub: next },
        { keys: w.keys, action: ACTION.setRecoverySignIn, asker: second },
      ),
    ).toMatchObject({ status: 403, json: { error: 'unsigned' } });
    expect(
      (await signedCall(owner, path, { authPub: next }, { keys: w.keys, action: ACTION.deleteAccount }))
        .status,
    ).toBe(403);
    expect(
      (
        await signedCall(
          owner,
          path,
          { authPub: next },
          {
            keys: w.keys,
            action: ACTION.setRecoverySignIn,
            body: { authPub: '00'.repeat(32) },
          },
        )
      ).status,
    ).toBe(403);
    expect(await dir.prepare(`SELECT auth_pub FROM recovery_key`).first('auth_pub')).toBe(before);
    // The device that holds the key can.
    expect(
      (await signedCall(owner, path, { authPub: next }, { keys: w.keys, action: ACTION.setRecoverySignIn }))
        .status,
    ).toBe(200);
    expect(await dir.prepare(`SELECT auth_pub FROM recovery_key`).first('auth_pub')).toBe(next);
    // A challenge is good for one request: the same token and signature again are refused.
    const ch = await owner.call('POST', '/api/settings/security/request-challenge', {
      action: ACTION.setRecoverySignIn,
    });
    const text = JSON.stringify({ authPub: next });
    const sig = toHex(
      await signRequest(
        w.keys,
        budgetId,
        ACTION.setRecoverySignIn,
        fromHex(ch.json.challenge as string),
        utf8(text),
      ),
    );
    const h = { 'x-ledgerline-challenge': ch.json.token as string, 'x-ledgerline-signature': sig };
    expect((await owner.call('POST', path, { authPub: next }, h)).status).toBe(200);
    expect((await owner.call('POST', path, { authPub: next }, h)).status).toBe(403);
    // A challenge is asked only for a request that is signed.
    expect(
      (await owner.call('POST', '/api/settings/security/request-challenge', { action: 'store-sign-key' }))
        .status,
    ).toBe(400);
  });

  it('the Directory says when the recovery key last signed in, on the session only', async () => {
    const s = await directoryStub().authenticate(owner.cookie(), 'GET', '/api/session');
    expect(s.ok && typeof s.caller.recoveryKeyUsedAt).toBe('number');
    const other = await directoryStub().authenticate(owner.cookie(), 'GET', '/api/budget');
    expect(other.ok && other.caller.recoveryKeyUsedAt).toBeUndefined();
  });
});
