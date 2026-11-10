// Open sign-up and recovery codes with the switch on (D-75, docs/open-signup.md 2–4; vitest.signup.config.ts),
// through the real Worker with software passkeys.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { TEST_TOKEN } from '../../src/routes/signup.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb } from '../store-db.js';

const dir = directoryDb();
const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const prodEnv = () => ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined }) as never;

class Browser {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { origin: ORIGIN, ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      h['content-type'] ??= 'application/json';
      h['x-ledgerline'] ??= '1';
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
  /** Options from `path`, then the passkey, then register/verify. */
  async ceremony(key: SoftAuthenticator, path: string, body: Record<string, unknown>) {
    const o = await this.call('POST', path, body);
    if (o.status !== 200) return o;
    return this.call('POST', '/api/auth/register/verify', {
      response: await key.create(o.json as never),
      name: 'Phone',
    });
  }
  async signIn(key: SoftAuthenticator) {
    const o = await this.call('POST', '/api/auth/login/options');
    return this.call('POST', '/api/auth/login/verify', { response: await key.get(o.json as never) });
  }
}

const newKey = () => new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const owner = new Browser();
const ownerKey = newKey();
const alex = new Browser();
const alexKey = newKey();
let alexCode = '';

describe('open sign-up', () => {
  it('stays closed until the instance has its admin', async () => {
    expect((await new Browser().call('GET', '/api/auth/status')).json.signupOpen).toBe(false);
    expect(
      (
        await new Browser().ceremony(newKey(), '/api/auth/signup/options', {
          turnstileToken: TEST_TOKEN,
        })
      ).status,
    ).toBe(403);
    expect((await owner.ceremony(ownerKey, '/api/auth/register/options', { setupCode: SETUP })).status).toBe(
      200,
    );
    expect((await new Browser().call('GET', '/api/auth/status')).json).toMatchObject({
      signupOpen: true,
      turnstileSiteKey: '1x00000000000000000000AA',
    });
  });

  it('needs the Turnstile check and the app’s header, and nothing else', async () => {
    const b = new Browser();
    expect((await b.call('POST', '/api/auth/signup/options', { turnstileToken: 'wrong' })).status).toBe(403);
    expect(
      (
        await b.call(
          'POST',
          '/api/auth/signup/options',
          { turnstileToken: TEST_TOKEN },
          { 'x-ledgerline': '0' },
        )
      ).status,
    ).toBe(403);
    // No name and no email (D-85): the check alone gives the passkey options, and a name that is sent is ignored.
    const o = await b.call('POST', '/api/auth/signup/options', { name: 'Alex', turnstileToken: TEST_TOKEN });
    expect(o.status).toBe(200);
    expect((o.json.user as { name: string }).name).toMatch(/^Ledgerline, /);
    expect(await dir.prepare(`SELECT count(*) AS n FROM user`).first('n')).toBe(1);
  });

  it('makes an account with its own budget, passkey and recovery code, never an admin', async () => {
    const r = await alex.ceremony(alexKey, '/api/auth/signup/options', {
      turnstileToken: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    alexCode = String(r.json.recoveryCode);
    expect(alexCode).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    const u = await dir
      .prepare(`SELECT id, is_admin, display_name, email FROM user WHERE is_admin = 0`)
      .first<{
        id: string;
        is_admin: number;
        display_name: string | null;
        email: string;
      }>();
    // No name and no email are kept (D-85): the email column holds a random value.
    expect(u).toMatchObject({ is_admin: 0, display_name: null, email: `u:${u!.id}` });
    const s = await alex.call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ canLinkBanks: false, recoveryNoticeAt: null });
    const own = await owner.call('GET', '/api/session');
    expect((own.json.budget as { id: string }).id).not.toBe((s.json.budget as { id: string }).id);
    expect((await alex.call('GET', '/api/settings/security')).json.recoveryCode).toBe(true);
    expect((await owner.call('GET', '/api/settings/security')).json.recoveryCode).toBe(false);
  });

  it('stops at the daily limit, and says so before the passkey', async () => {
    expect(
      (
        await new Browser().ceremony(newKey(), '/api/auth/signup/options', {
          turnstileToken: TEST_TOKEN,
        })
      ).status,
    ).toBe(200);
    const full = await new Browser().call('POST', '/api/auth/signup/options', {
      turnstileToken: TEST_TOKEN,
    });
    expect(full).toMatchObject({ status: 403, json: { error: 'full' } });
    expect(await dir.prepare(`SELECT count(*) AS n FROM user`).first('n')).toBe(3);
  });

  it('a sign-up that was allowed when it started is refused if the limit was reached meanwhile', async () => {
    // Room again for one: start, then fill the day before the passkey comes back.
    const last = (await dir.prepare(`SELECT id FROM user ORDER BY rowid DESC LIMIT 1`).first<string>('id'))!;
    await dir.prepare(`UPDATE user SET created_at = 0 WHERE id = ?1`).bind(last).run();
    const b = new Browser();
    const o = await b.call('POST', '/api/auth/signup/options', { turnstileToken: TEST_TOKEN });
    expect(o.status).toBe(200);
    await dir
      .prepare(`UPDATE user SET created_at = ?1 WHERE id = ?2`)
      .bind(Date.parse('2026-11-14T20:00:00Z'), last)
      .run();
    const v = await b.call('POST', '/api/auth/register/verify', {
      response: await newKey().create(o.json as never),
      name: 'Phone',
    });
    expect(v).toMatchObject({ status: 403, json: { error: 'full' } });
    expect(await dir.prepare(`SELECT count(*) AS n FROM user`).first('n')).toBe(3);
  });
});

describe('recovery codes', () => {
  it('a wrong code, or one for an admin, gets nothing', async () => {
    const b = new Browser();
    expect(
      (await b.call('POST', '/api/auth/recover/options', { code: 'AAAA-BBBB', turnstileToken: TEST_TOKEN }))
        .status,
    ).toBe(403);
    expect(
      (
        await b.call('POST', '/api/auth/recover/options', {
          code: 'A'.repeat(32),
          turnstileToken: TEST_TOKEN,
        })
      ).status,
    ).toBe(403);
  });

  it('adds a passkey, removes nothing, swaps the code and shows a notice', async () => {
    const phone = new Browser();
    const lostKey = newKey();
    const typed = alexCode.toLowerCase().replace(/-/g, ' ');
    const r = await phone.ceremony(lostKey, '/api/auth/recover/options', {
      code: typed,
      turnstileToken: TEST_TOKEN,
    });
    expect(r.status).toBe(200);
    const next = String(r.json.recoveryCode);
    expect(next).not.toBe(alexCode);
    // The new passkey is Alex's; the old one still works.
    expect(lostKey.userHandle).toBe(alexKey.userHandle);
    expect((await new Browser().signIn(alexKey)).status).toBe(200);
    expect((await alex.call('GET', '/api/session')).status).toBe(200);
    // The old code works no more.
    expect(
      (
        await new Browser().call('POST', '/api/auth/recover/options', {
          code: alexCode,
          turnstileToken: TEST_TOKEN,
        })
      ).status,
    ).toBe(403);
    // The notice shows until dismissed.
    expect((await phone.call('GET', '/api/session')).json.recoveryNoticeAt).toBe('2026-11-14T20:00:00.000Z');
    expect((await phone.call('POST', '/api/settings/security/recovery-notice/dismiss')).status).toBe(200);
    expect((await phone.call('GET', '/api/session')).json.recoveryNoticeAt).toBeNull();
    alexCode = next;
  });

  it('a recovery started before the code was replaced fails', async () => {
    const b = new Browser();
    const o = await b.call('POST', '/api/auth/recover/options', {
      code: alexCode,
      turnstileToken: TEST_TOKEN,
    });
    expect(o.status).toBe(200);
    // Alex makes a new code meanwhile (Settings → Sign-in).
    const fresh = await alex.call('POST', '/api/settings/security/recovery-code');
    expect(fresh.status).toBe(200);
    const v = await b.call('POST', '/api/auth/register/verify', {
      response: await newKey().create(o.json as never),
      name: 'Phone',
    });
    expect(v.status).toBe(403);
    alexCode = String(fresh.json.code);
  });

  it('admins have no recovery code', async () => {
    expect((await owner.call('POST', '/api/settings/security/recovery-code')).status).toBe(404);
  });
});
