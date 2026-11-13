// The relay for adding a device with its own passkey (routes/device-add.ts; docs/privacy-keys.md section 10),
// through the real Worker with software passkeys: the two devices' own objects (packages/seal device-add.ts) talk
// through it, and each step's guard is broken in turn.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  deriveBudgetKeys,
  fromHex,
  NewDevice,
  randomBytes,
  SignedInDevice,
  toHex,
  type Bytes,
} from '@ledgerline/seal';
import worker from '../../src/index.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb } from '../store-db.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const dir = directoryDb();
const prodEnv = () =>
  ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined, SETUP_CODE: SETUP }) as never;
const BASE = '/api/settings/security/device-add';

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
  async register(key: SoftAuthenticator, grant: Record<string, string>) {
    const o = await this.call('POST', '/api/auth/register/options', grant);
    if (o.status !== 200) return o;
    return this.call('POST', '/api/auth/register/verify', {
      response: await key.create(o.json as never),
      name: 'Passkey',
    });
  }
}

const owner = new Browser();
let budgetId = '';

/** A new device signed in by a device link, as Settings → Sign-in → Add a device makes. */
async function linked(): Promise<Browser> {
  const link = await owner.call('POST', '/api/settings/security/device-link');
  expect(link.status).toBe(200);
  const token = (link.json.url as string).split('#')[1]!;
  const b = new Browser();
  expect(
    (await b.register(new SoftAuthenticator(ORIGIN, 'ledgerline.test'), { deviceToken: token })).status,
  ).toBe(200);
  return b;
}

describe('adding a device: the relay', () => {
  it('relays the three messages, the sealed key and the confirmation, and both devices agree', async () => {
    expect(
      (await owner.register(new SoftAuthenticator(ORIGIN, 'ledgerline.test'), { setupCode: SETUP })).status,
    ).toBe(200);
    budgetId = ((await owner.call('GET', '/api/session')).json.budget as { id: string }).id;
    expect((await owner.call('GET', BASE)).json).toEqual({ role: null });
    const start = await owner.call('POST', `${BASE}/start`);
    expect(start.status).toBe(200);
    expect((await owner.call('GET', BASE)).json).toMatchObject({ role: 'from', commit: null, offers: 0 });
    const n = await linked();
    expect((await n.call('GET', BASE)).json).toMatchObject({ role: 'waiting' });

    const bk = randomBytes(32);
    const keys = await deriveBudgetKeys(bk, budgetId, 1);
    const head = { number: 7, hash: randomBytes(32) };
    const o = new SignedInDevice(budgetId, keys, head);
    const nd = await NewDevice.start(budgetId);

    // N's commitment ties the add to its sign-in.
    expect((await n.call('POST', `${BASE}/commit`, { commit: toHex(nd.commit) })).status).toBe(200);
    expect((await n.call('GET', BASE)).json).toMatchObject({ role: 'to', offer: null, sealed: null });
    // Another sign-in, made later, can no longer join, nor see it.
    const third = await linked();
    expect((await third.call('GET', BASE)).json).toEqual({ role: null });
    expect((await third.call('POST', `${BASE}/commit`, { commit: toHex(nd.commit) })).status).toBe(409);
    // O can't send N's messages, and N can't send O's.
    expect((await owner.call('POST', `${BASE}/commit`, { commit: toHex(nd.commit) })).status).toBe(409);

    const seen = (await owner.call('GET', BASE)).json;
    expect(seen.commit).toBe(toHex(nd.commit));
    const offer = o.offer(fromHex(seen.commit as string), Date.now());
    expect((await n.call('POST', `${BASE}/offer`, { commit: seen.commit, offer: toHex(offer) })).status).toBe(
      409,
    );
    // An offer for another commitment is refused.
    expect(
      (await owner.call('POST', `${BASE}/offer`, { commit: '00'.repeat(32), offer: toHex(offer) })).status,
    ).toBe(409);
    expect(
      (await owner.call('POST', `${BASE}/offer`, { commit: seen.commit, offer: toHex(offer) })).status,
    ).toBe(200);
    // Once.
    expect(
      (await owner.call('POST', `${BASE}/offer`, { commit: seen.commit, offer: toHex(offer) })).status,
    ).toBe(409);

    const got = (await n.call('GET', BASE)).json;
    const r = await nd.reveal(fromHex(got.offer as string));
    expect((await owner.call('POST', `${BASE}/reveal`, { reveal: toHex(r.reveal) })).status).toBe(409);
    expect((await n.call('POST', `${BASE}/reveal`, { reveal: toHex(r.reveal) })).status).toBe(200);
    expect((await n.call('POST', `${BASE}/reveal`, { reveal: toHex(r.reveal) })).status).toBe(409);

    const atO = (await owner.call('GET', BASE)).json;
    const code = await o.code(fromHex(atO.reveal as string), Date.now());
    expect(code).toBe(r.code);
    expect(code).toMatch(/^\d{6}$/);
    // The person tapped "They match" on O.
    const sealed = await o.seal(bk, Date.now());
    expect((await n.call('POST', `${BASE}/sealed`, { sealed: toHex(sealed) })).status).toBe(409);
    expect((await owner.call('POST', `${BASE}/sealed`, { sealed: toHex(sealed) })).status).toBe(200);
    // N can't start a new try once the key is sealed.
    expect((await n.call('POST', `${BASE}/commit`, { commit: toHex(nd.commit) })).status).toBe(409);

    const s = (await n.call('GET', BASE)).json.sealed as string;
    const opened = await nd.open(fromHex(s), {
      signPub: keys.sign.pub,
      keyVersion: 1,
      headHash: head.hash,
    });
    expect(toHex(opened.bk)).toBe(toHex(bk));
    expect((await n.call('POST', `${BASE}/confirm`, { confirm: toHex(opened.confirm) })).status).toBe(200);
    const c = (await owner.call('GET', BASE)).json.confirm as string;
    expect(await o.confirmed(bk, fromHex(c))).toBe(true);

    // The server held only public values and the sealed key: never the budget key.
    const row = await dir.prepare(`SELECT * FROM device_add`).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(toHex(bk));
    expect((await owner.call('POST', `${BASE}/end`)).status).toBe(200);
    expect(await dir.prepare(`SELECT count(*) AS n FROM device_add`).first('n')).toBe(0);
    expect((await n.call('GET', BASE)).json).toEqual({ role: null });
  });

  it('a new try clears the offer; at most 3 offers per start; bad values and late steps are refused', async () => {
    await owner.call('POST', `${BASE}/start`);
    const n = await linked();
    expect((await n.call('POST', `${BASE}/commit`, { commit: 'zz' })).status).toBe(400);
    expect((await n.call('POST', `${BASE}/reveal`, { reveal: '00'.repeat(64) })).status).toBe(409);
    for (let i = 0; i < 3; i++) {
      const commit = toHex(randomBytes(32) as Bytes);
      expect((await n.call('POST', `${BASE}/commit`, { commit })).status).toBe(200);
      expect((await n.call('GET', BASE)).json).toMatchObject({ offer: null });
      expect((await owner.call('POST', `${BASE}/offer`, { commit, offer: '11'.repeat(108) })).status).toBe(
        200,
      );
      expect((await n.call('GET', BASE)).json).toMatchObject({ offer: '11'.repeat(108) });
    }
    expect((await owner.call('GET', BASE)).json).toMatchObject({ offers: 3 });
    expect((await n.call('POST', `${BASE}/commit`, { commit: '22'.repeat(32) })).status).toBe(409);

    // A new start ends the one before: the new device's sign-in is no longer part of it.
    await owner.call('POST', `${BASE}/start`);
    expect((await n.call('GET', BASE)).json).toMatchObject({ role: 'waiting' });
    expect((await n.call('POST', `${BASE}/commit`, { commit: '22'.repeat(32) })).status).toBe(200);
    // Ten minutes later it is over.
    await dir.prepare(`UPDATE device_add SET expires_at = expires_at - 3600000`).run();
    expect((await n.call('GET', BASE)).json).toEqual({ role: null });
    expect((await n.call('POST', `${BASE}/reveal`, { reveal: '00'.repeat(64) })).status).toBe(409);
    expect(
      (await owner.call('POST', `${BASE}/offer`, { commit: '22'.repeat(32), offer: '11'.repeat(108) }))
        .status,
    ).toBe(409);
  });

  it('a start needs a recent passkey check', async () => {
    await dir.prepare(`UPDATE auth_session SET verified_at = verified_at - 3600000`).run();
    expect((await owner.call('POST', `${BASE}/start`)).json).toMatchObject({ error: 'reauth' });
    await dir.prepare(`UPDATE auth_session SET verified_at = verified_at + 3600000`).run();
  });
});
