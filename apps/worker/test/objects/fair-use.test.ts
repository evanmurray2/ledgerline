// Fair use and idle budgets (docs/open-signup.md 8, 9; store/shares.ts), through the real Worker with software
// passkeys: an owner (admin) and two other users.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { tokenHash } from '../../src/http/auth.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb } from '../store-db.js';

const dir = directoryDb();
const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const now = Date.parse('2026-11-14T20:00:00Z');
const day = '2026-11-14';
const prodEnv = () =>
  ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined, SETUP_CODE: SETUP }) as never;

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
      const [pair] = sc.split(';');
      const [k, v] = pair!.split('=') as [string, string];
      this.jar.set(k.trim(), v);
    }
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
  }
  async register(a: SoftAuthenticator, start: Record<string, unknown>) {
    const o = await this.call('POST', '/api/auth/register/options', start);
    return this.call('POST', '/api/auth/register/verify', {
      response: await a.create(o.json as never),
      name: 'Test',
    });
  }
}

const owner = new Browser();
const b = new Browser();
const c = new Browser();

async function addUser(id: string, budget: string, who: Browser): Promise<void> {
  const token = `device-link-token-for-${id}-0123456789abcdef`;
  await dir.batch([
    dir
      .prepare(
        `INSERT INTO user (id, email, webauthn_handle, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0)`,
      )
      .bind(id, `u:${id}`, `handle-${id}`),
    dir.prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'B', 0, 0)`).bind(budget),
    dir
      .prepare(
        `INSERT INTO budget_member (budget_id, user_id, role, created_at, updated_at) VALUES (?1, ?2, 'owner', 0, 0)`,
      )
      .bind(budget, id),
    dir
      .prepare(`INSERT INTO device_link (token_hash, created_at, expires_at, user_id) VALUES (?1, 0, ?2, ?3)`)
      .bind(await tokenHash(token), now + 600_000, id),
  ]);
  expect(
    (await who.register(new SoftAuthenticator(ORIGIN, 'ledgerline.test'), { deviceToken: token })).status,
  ).toBe(200);
}

const usageRows = async (budget: string) =>
  (await dir
    .prepare(`SELECT written, requests FROM budget_usage_day WHERE budget_id = ?1`)
    .bind(budget)
    .first<{
      written: number;
      requests: number;
    }>()) ?? null;

/** The store reports in the background (waitUntil): wait for it. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

describe('fair use', () => {
  it('with one user nothing is counted', async () => {
    expect(
      (await owner.register(new SoftAuthenticator(ORIGIN, 'ledgerline.test'), { setupCode: SETUP })).status,
    ).toBe(200);
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
    expect(await dir.prepare(`SELECT count(*) AS n FROM budget_usage_day`).first('n')).toBe(0);
    // last_seen_at is written (at most once an hour).
    expect(await dir.prepare(`SELECT last_seen_at FROM user WHERE is_admin = 1`).first('last_seen_at')).toBe(
      now,
    );
  });

  it('with other users, their stores report their own usage and the owner’s doesn’t', async () => {
    await addUser('u_b', 'b_b', b);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
    const row = await eventually(
      () => usageRows('b_b'),
      (r) => (r?.requests ?? 0) > 0,
    );
    expect(row?.requests).toBeGreaterThan(0);
    expect((await owner.call('GET', '/api/session')).status).toBe(200);
    const ownerBudget = await dir
      .prepare(`SELECT budget_id FROM budget_member m JOIN user u ON u.id = m.user_id WHERE u.is_admin = 1`)
      .first<string>('budget_id');
    expect(await usageRows(ownerBudget!)).toBeNull();
  });

  it('a user far past their share can read but not change anything; the owner is never limited', async () => {
    await addUser('u_c', 'b_c', c);
    // Past 1.5 × even the whole pool (50,000 rows written on Free).
    await dir
      .prepare(
        `INSERT INTO budget_usage_day (budget_id, day, written, read, steps, requests) VALUES ('b_c', ?1, 80000, 0, 0, 0)`,
      )
      .bind(day)
      .run();
    expect((await c.call('GET', '/api/session')).status).toBe(200);
    const w = await c.call('POST', '/api/settings/connections/refresh');
    expect(w).toMatchObject({
      status: 503,
      json: { error: 'readonly', message: 'Paused until tomorrow. Nothing is lost.' },
    });
    expect((await owner.call('POST', '/api/settings/connections/refresh')).status).not.toBe(503);
  });
});
