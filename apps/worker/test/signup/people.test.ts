// Deleting your own account and Settings → Users (D-75, docs/open-signup.md 10, 12), with the switch on.
import { createExecutionContext, env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { TEST_TOKEN } from '../../src/routes/signup.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { budgetStub, directoryDb, directoryStub, storeDb } from '../store-db.js';

const dir = directoryDb();
const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const prodEnv = () => ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined }) as never;

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
  async ceremony(key: SoftAuthenticator, path: string, body: Record<string, unknown>) {
    const o = await this.call('POST', path, body);
    expect(o.status).toBe(200);
    const v = await this.call('POST', '/api/auth/register/verify', {
      response: await key.create(o.json as never),
      name: 'Phone',
    });
    expect(v.status).toBe(200);
  }
  async signIn(key: SoftAuthenticator) {
    const o = await this.call('POST', '/api/auth/login/options');
    return this.call('POST', '/api/auth/login/verify', { response: await key.get(o.json as never) });
  }
}

const key = () => new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const owner = new Browser();
const sam = new Browser();
const samKey = key();
let samBudget = '';
let samId = '';

/** Runs the Directory's jobs that are due (the delete_account job), as its alarm would. */
async function runDirectoryJobs() {
  for (let i = 0; i < 5; i++) await runDurableObjectAlarm(directoryStub());
}

describe('Settings → Users', () => {
  it('is for admins only, and shows the accounts', async () => {
    await owner.ceremony(key(), '/api/auth/register/options', { setupCode: SETUP });
    await sam.ceremony(samKey, '/api/auth/signup/options', { turnstileToken: TEST_TOKEN });
    samBudget = ((await sam.call('GET', '/api/session')).json.budget as { id: string }).id;
    samId = (await dir
      .prepare(`SELECT user_id FROM budget_member WHERE budget_id = ?1`)
      .bind(samBudget)
      .first<string>('user_id'))!;
    expect((await sam.call('GET', '/api/settings/security/users')).status).toBe(404);
    expect((await sam.call('GET', '/api/settings/security')).json.usersScreen).toBe(false);
    expect((await owner.call('GET', '/api/settings/security')).json.usersScreen).toBe(true);
    const v = await owner.call('GET', '/api/settings/security/users');
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ users: 2, signupsOpen: true });
    expect((v.json.list as { name: string }[]).map((u) => u.name)).toEqual(['Account', 'Admin']);
  });

  it('turning an account off signs it out and stops its jobs; on again brings them back', async () => {
    const recurring = async () =>
      Number(
        await storeDb(samBudget).prepare(`SELECT count(*) AS n FROM job WHERE recurring = 1`).first('n'),
      );
    expect(await recurring()).toBe(3);
    expect((await sam.call('POST', `/api/settings/security/users/${samId}/turn-off`)).status).toBe(404);
    expect((await owner.call('POST', `/api/settings/security/users/${samId}/turn-off`)).status).toBe(200);
    expect((await sam.call('GET', '/api/session')).status).toBe(401);
    expect((await new Browser().signIn(samKey)).status).toBe(403);
    expect(await recurring()).toBe(0);
    // The daily check leaves a turned-off budget resting.
    await budgetStub(samBudget).ensureJobs();
    expect(await recurring()).toBe(0);
    expect((await owner.call('POST', `/api/settings/security/users/${samId}/turn-on`)).status).toBe(200);
    expect(await recurring()).toBe(3);
    expect((await sam.signIn(samKey)).status).toBe(200);
    // An admin can't be turned off.
    const adminId = await dir.prepare(`SELECT id FROM user WHERE is_admin = 1`).first<string>('id');
    expect((await owner.call('POST', `/api/settings/security/users/${adminId}/turn-off`)).status).toBe(404);
  });
});

describe('deleting an account', () => {
  it('a store refuses to wipe itself without the Directory’s deletion record', async () => {
    expect(await budgetStub(samBudget).wipe(samBudget)).toEqual({ ok: false, why: 'refused' });
    expect((await sam.call('GET', '/api/session')).status).toBe(200);
  });

  it('needs the budget’s name, and the admin can’t delete theirs', async () => {
    expect(
      (await sam.call('POST', '/api/settings/security/delete-account', { budgetName: 'nope' })).status,
    ).toBe(400);
    const name = ((await owner.call('GET', '/api/session')).json.budget as { name: string }).name;
    expect(
      (await owner.call('POST', '/api/settings/security/delete-account', { budgetName: name })).status,
    ).toBe(409);
  });

  it('signs the user out at once, then wipes the budget and every row of the user', async () => {
    const name = ((await sam.call('GET', '/api/session')).json.budget as { name: string }).name;
    const r = await sam.call('POST', '/api/settings/security/delete-account', { budgetName: name });
    expect(r.status).toBe(200);
    expect((await sam.call('GET', '/api/session')).status).toBe(401);
    expect((await new Browser().signIn(samKey)).status).toBe(403);
    await runDirectoryJobs();
    for (const t of ['user', 'passkey', 'recovery_code', 'auth_session', 'budget_member'])
      expect(
        await dir
          .prepare(`SELECT count(*) AS n FROM ${t} WHERE ${t === 'user' ? 'id' : 'user_id'} = ?1`)
          .bind(samId)
          .first('n'),
        t,
      ).toBe(0);
    expect(
      await dir.prepare(`SELECT count(*) AS n FROM budget WHERE id = ?1`).bind(samBudget).first('n'),
    ).toBe(0);
    // The store is empty, and nothing can make its budget again.
    expect(
      await budgetStub(samBudget)
        .health()
        .then((h) => h.ok),
    ).toBe(true);
    expect(await storeDb(samBudget).prepare(`SELECT count(*) AS n FROM budget`).first('n')).toBe(0);
    const late = await budgetStub(samBudget).api(new Request(`${ORIGIN}/api/session`), {
      userId: samId,
      budgetId: samBudget,
      email: '',
      sessionId: '',
      verifiedAt: 0,
    });
    expect(late.status).toBe(403);
    expect(await storeDb(samBudget).prepare(`SELECT count(*) AS n FROM budget`).first('n')).toBe(0);
    // The account no longer counts toward MAX_USERS.
    expect((await owner.call('GET', '/api/settings/security/users')).json.users).toBe(1);
  });
});
