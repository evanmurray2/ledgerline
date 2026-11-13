// Keeping users apart (D-75, docs/open-signup.md 11; docs/multi-user.md 11). Two users sign up through the real
// sign-up route; user B's budget gets data with a marker name; then user A calls every route of the budget API and
// of Settings → Sign-in, with B's ids in the path, the query and the body. No answer may show B's data, and B's
// database must not change. The route list is read from the Hono apps, so a new route can't be left out.
import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { budgetApi } from '../../src/routes/api.js';
import { securityRoutes } from '../../src/routes/security.js';
import { recoveryRoutes, TEST_TOKEN } from '../../src/routes/signup.js';
import { recoveryKeySettings } from '../../src/routes/recovery-key.js';
import { SoftAuthenticator } from '../soft-authenticator.js';
import { directoryDb, storeDb } from '../store-db.js';

const ORIGIN = 'https://ledgerline.test';
const SETUP = 's'.repeat(40);
const MARK = 'ZZ-ONLY-B-SEES-THIS';
const prodEnv = () => ({ ...env, DEV_AUTH_EMAIL: undefined, DEV_ROUTES: undefined }) as never;

class Browser {
  jar = new Map<string, string>();
  async call(method: string, path: string, body?: unknown) {
    const h: Record<string, string> = { origin: ORIGIN };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && method !== 'HEAD') {
      h['content-type'] = 'application/json';
      h['x-ledgerline'] = '1';
    }
    const res = await worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: h,
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
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
    return { status: res.status, text: await res.text() };
  }
  async ceremony(key: SoftAuthenticator, path: string, body: Record<string, unknown>) {
    const o = await this.call('POST', path, body);
    expect(o.status).toBe(200);
    const v = await this.call('POST', '/api/auth/register/verify', {
      response: await key.create(JSON.parse(o.text) as never),
      name: 'Phone',
    });
    expect(v.status).toBe(200);
  }
}

const key = () => new SoftAuthenticator(ORIGIN, 'ledgerline.test');

/** Every row of every table in a store, except the job queue and usage counters that background work moves. */
async function snapshot(budgetId: string): Promise<string> {
  const db = storeDb(budgetId);
  const tables = (
    await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all<{ name: string }>()
  ).results
    .map((r) => r.name)
    .filter((n) => !/^(job|_migrations|usage_|health_status|_cf_)/.test(n));
  const out: string[] = [];
  for (const t of tables)
    out.push(t, JSON.stringify((await db.prepare(`SELECT * FROM "${t}"`).all()).results));
  return out.join('\n');
}

/** Routes this test can't call without ending A's own sign-in or store (they act only on A's anyway). */
const SKIP = /sign-out|\/settings\/restore|\/webhooks\//;

describe('keeping users apart', () => {
  it('user A reaches none of user B’s data through any route', async () => {
    const owner = new Browser();
    await owner.ceremony(key(), '/api/auth/register/options', { setupCode: SETUP });
    const a = new Browser();
    const b = new Browser();
    await a.ceremony(key(), '/api/auth/signup/options', { turnstileToken: TEST_TOKEN });
    await b.ceremony(key(), '/api/auth/signup/options', { turnstileToken: TEST_TOKEN });
    const bBudget = (JSON.parse((await b.call('GET', '/api/session')).text) as { budget: { id: string } })
      .budget.id;
    const aBudget = (JSON.parse((await a.call('GET', '/api/session')).text) as { budget: { id: string } })
      .budget.id;
    expect(aBudget).not.toBe(bBudget);

    // B's data, with the marker in every name.
    const bs = storeDb(bBudget);
    const t = Date.parse('2026-11-14T20:00:00Z');
    await bs.batch([
      bs.prepare(`UPDATE budget SET budget_start_month = '2026-11', name = ?1`).bind(MARK),
      bs
        .prepare(
          `INSERT INTO account (id, budget_id, name, kind, budget_from, created_at, updated_at) VALUES ('acct_b', ?1, ?2, 'checking', '2026-11-01', ?3, ?3)`,
        )
        .bind(bBudget, MARK, t),
      bs
        .prepare(
          `INSERT INTO category_group (id, budget_id, name, created_at, updated_at) VALUES ('grp_b', ?1, ?2, ?3, ?3)`,
        )
        .bind(bBudget, MARK, t),
      bs
        .prepare(
          `INSERT INTO category (id, budget_id, group_id, name, kind, created_at, updated_at) VALUES ('cat_b', ?1, 'grp_b', ?2, 'spending', ?3, ?3)`,
        )
        .bind(bBudget, MARK, t),
      bs
        .prepare(
          `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
           VALUES ('mp_b', ?1, 'm:mp_b', 'acct_b', 'pending', '2026-11-10', -1234, ?2, ?3, ?3)`,
        )
        .bind(bBudget, MARK, t),
    ]);
    const bPasskey = await directoryDb()
      .prepare(
        `SELECT p.id FROM passkey p JOIN budget_member m ON m.user_id = p.user_id WHERE m.budget_id = ?1`,
      )
      .bind(bBudget)
      .first<string>('id');
    const ids = ['acct_b', 'cat_b', 'grp_b', 'm:mp_b', 'mp_b', bBudget, bPasskey!];
    const body = (id: string) => ({
      id,
      accountId: id,
      categoryId: id,
      groupId: id,
      txnKey: id,
      key: id,
      keys: [id],
      budgetId: id,
      connectionId: id,
      payeeId: id,
      month: '2026-11',
      name: 'x',
      amount: 100,
    });
    const before = await snapshot(bBudget);

    const routes = [
      ...budgetApi.routes,
      ...securityRoutes.routes,
      ...recoveryRoutes.routes,
      ...recoveryKeySettings.routes,
    ]
      .filter((r) => r.method !== 'ALL' && !SKIP.test(r.path))
      .map((r) => ({ method: r.method, path: r.path }));
    const unique = [...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(unique.length).toBeGreaterThan(40);
    let calls = 0;
    for (const r of unique)
      for (const id of ids) {
        const path = '/api' + r.path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, encodeURIComponent(id));
        const q = `?id=${encodeURIComponent(id)}&accountId=${encodeURIComponent(id)}&categoryId=${encodeURIComponent(id)}&month=2026-11`;
        const res = await a.call(r.method, path + (r.method === 'GET' ? q : ''), body(id));
        calls++;
        expect(res.text, `${r.method} ${path}`).not.toContain(MARK);
      }
    expect(calls).toBe(unique.length * ids.length);
    // Nothing A did reached B's database, and B still sees their own data.
    expect(await snapshot(bBudget)).toBe(before);
    expect((await b.call('GET', '/api/session')).status).toBe(200);
    expect((await b.call('GET', '/api/sync?since=0')).text).toContain(MARK);
  });
});
