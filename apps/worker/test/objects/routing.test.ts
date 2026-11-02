// Routing (docs/multi-user.md 5.1), through the real Worker with software passkeys: sign-in is served by the
// Directory and the budget by its own Durable Object; each user reaches only their own budget.
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { tokenHash } from '../../src/http/auth.js';
import { DIRECTORY_NAME, type Directory } from '../../src/store/directory.js';
import type { BudgetStore } from '../../src/store/budget-store.js';
import { SoftAuthenticator } from '../soft-authenticator.js';

const e = env as unknown as {
  DIRECTORY: DurableObjectNamespace<Directory>;
  BUDGET: DurableObjectNamespace<BudgetStore>;
};
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
const directory = () => e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));

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
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : null) as Record<string, unknown>,
    };
  }
  async register(a: SoftAuthenticator, start: Record<string, unknown>) {
    const o = await this.call('POST', '/api/auth/register/options', start);
    if (o.status !== 200) return o;
    return this.call('POST', '/api/auth/register/verify', {
      response: await a.create(o.json as never),
      name: 'Test',
    });
  }
}

const ownerKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const otherKey = new SoftAuthenticator(ORIGIN, 'ledgerline.test');
const owner = new Browser();
const other = new Browser();
let ownerBudget = '';

describe('routing', () => {
  it('nothing is reachable signed out', async () => {
    expect((await owner.call('GET', '/api/session')).status).toBe(401);
  });

  it('setup and sign-in are served by the Directory', async () => {
    expect((await owner.register(ownerKey, { setupCode: SETUP })).status).toBe(200);
    const inDirectory = await runInDurableObject(directory(), async (_o, st) =>
      Number(st.storage.sql.exec(`SELECT count(*) AS n FROM passkey`).one().n),
    );
    expect(inDirectory).toBe(1);
  });

  it('the budget is served by its own Durable Object, with the usual security headers', async () => {
    const s = await owner.call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect(s.headers.get('x-content-type-options')).toBe('nosniff');
    ownerBudget = String((s.json.budget as { id: string }).id);
    const w = await owner.call('POST', '/api/settings/groups', { name: 'Bills', isBills: true });
    expect(w.status).toBe(200);
    const inStore = await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName(ownerBudget)), async (_o, st) =>
      st.storage.sql
        .exec(`SELECT name FROM category_group`)
        .toArray()
        .map((r) => r.name),
    );
    expect(inStore).toEqual(['Bills']);
  });

  it('Settings → Sign-in is served by the Directory for the signed-in user', async () => {
    const sec = await owner.call('GET', '/api/settings/security');
    expect(sec.status).toBe(200);
    expect((sec.json.passkeys as { id: string }[]).map((p) => p.id)).toEqual([ownerKey.id]);
  });

  it('a second user reaches only their own budget', async () => {
    const token = 'second-user-device-link-token-routing-0123';
    const hash = await tokenHash(token);
    await runInDurableObject(directory(), async (_o, st) => {
      st.storage.sql.exec(
        `INSERT INTO user (id, email, webauthn_handle, created_at, updated_at) VALUES ('u_b', 'u:u_b', 'handle-of-b', 0, 0)`,
      );
      st.storage.sql.exec(`INSERT INTO budget (id, name, created_at, updated_at) VALUES ('b_b', 'B', 0, 0)`);
      st.storage.sql.exec(
        `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES ('b_b', 'u_b', 'owner', 0, 0)`,
      );
      st.storage.sql.exec(
        `INSERT INTO device_link (token_hash, created_at, expires_at, user_id) VALUES (?, 0, ?, 'u_b')`,
        hash,
        now + 600_000,
      );
    });
    expect((await other.register(otherKey, { deviceToken: token })).status).toBe(200);
    const s = await other.call('GET', '/api/session');
    expect((s.json.budget as { id: string }).id).toBe('b_b');
    const cats = await other.call('GET', '/api/settings/categories');
    expect(JSON.stringify(cats.json)).not.toContain('Bills');
  });
});

describe('when the Durable Objects can’t be reached', () => {
  const broken = (message: string) =>
    ({
      ...(prodEnv() as object),
      DIRECTORY: {
        idFromName: () => ({}),
        get: () => ({
          fetch: () => Promise.reject(new Error(message)),
          authenticate: () => Promise.reject(new Error(message)),
        }),
      },
    }) as never;
  const call = (env: never, path: string) =>
    worker.fetch(new Request(ORIGIN + path, { headers: { origin: ORIGIN } }), env, createExecutionContext());

  it('says the daily limit ran out, plainly, instead of a bare error', async () => {
    const env = broken('Exceeded allowed volume of requests in Durable Objects free tier.');
    for (const path of ['/api/auth/status', '/api/session']) {
      const r = await call(env, path);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: 'daily_limit' });
    }
  });

  it('any other failure is a short "can’t reach your data" answer', async () => {
    const r = await call(broken('Network connection lost.'), '/api/session');
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'unavailable' });
  });
});
