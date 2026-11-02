// The move with a big budget (docs/multi-user.md 12, phase 4). Same harness as move.test.ts.\n// The move end to end (docs/multi-user.md 8): D1 holds the November budget; the owner starts the move; the
// Directory and the budget's store copy and verify everything; the switch flips; the same session sees exactly the
// same screens, now served by the Durable Objects. A difference found while verifying aborts the move with D1
// untouched, and a freeze past its time limit lifts on its own.
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { dev } from '../../src/measure/dev.js';
import { tokenHash } from '../../src/http/auth.js';
import { checkIdentityDb } from '../../src/maintenance.js';
import { resetRoutingCache } from '../../src/store/router.js';
import { DIRECTORY_NAME, type Directory } from '../../src/store/directory.js';
import type { BudgetStore } from '../../src/store/budget-store.js';

const e = env as unknown as {
  DB: D1Database;
  DIRECTORY: DurableObjectNamespace<Directory>;
  BUDGET: DurableObjectNamespace<BudgetStore>;
};
const ORIGIN = 'https://ledgerline.test';
const TOKEN = 'owner-session-token-for-the-move-test-0123456789';
const dir = () => e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));
const store = (id: string) => e.BUDGET.get(e.BUDGET.idFromName(id));

async function call(method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { origin: ORIGIN, cookie: `__Host-ledgerline=${TOKEN}` };
  if (method !== 'GET') {
    h['content-type'] = 'application/json';
    h['x-ledgerline'] = '1';
  }
  const r = await worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers: h,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
    env as never,
    createExecutionContext(),
  );
  const text = await r.text();
  return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

/** The November budget in D1, an owner session with a fresh passkey check. */
async function seedD1(): Promise<string> {
  await dev.fetch(
    new Request('https://x/seed-november', { method: 'POST' }),
    { ...env, DEV_ROUTES: '1', DEV_AUTH_EMAIL: 'owner@example.com', SETUP_CODE: undefined } as never,
    createExecutionContext(),
  );
  const user = (await e.DB.prepare(`SELECT id FROM user`).first<string>('id'))!;
  await e.DB.prepare(`UPDATE user SET is_admin = 1, webauthn_handle = 'ledgerline-owner' WHERE id = ?1`)
    .bind(user)
    .run();
  await e.DB.prepare(
    `INSERT INTO auth_session (id, created_at, expires_at, verified_at, user_id) VALUES (?1, 0, 9999999999999, ?2, ?3)`,
  )
    .bind(await tokenHash(TOKEN), Date.now(), user)
    .run();
  resetRoutingCache();
  return (await e.DB.prepare(`SELECT id FROM budget`).first<string>('id'))!;
}

/** Runs the Directory's and the store's due alarms until the move reports moved or failed. */
async function runMove(budgetId: string, onStep?: () => Promise<void>): Promise<string> {
  for (let i = 0; i < 3000; i++) {
    for (const stub of [dir(), store(budgetId)] as DurableObjectStub[]) {
      const due = await runInDurableObject(stub, async (_o, st) => {
        const has = st.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name = 'job'`).toArray().length;
        if (!has) return 0;
        const n = Number(
          st.storage.sql
            .exec(`SELECT count(*) AS n FROM job WHERE failed_at IS NULL AND run_at <= ?`, Date.now() + 5000)
            .one().n,
        );
        if (n) {
          st.storage.sql.exec(
            `UPDATE job SET run_at = ? WHERE failed_at IS NULL AND run_at <= ?`,
            Date.now(),
            Date.now() + 5000,
          );
          await st.storage.setAlarm(Date.now());
        }
        return n;
      });
      if (due) await runDurableObjectAlarm(stub);
    }
    if (onStep) await onStep();
    const s = (await dir().moveStatus()) as { state: string } | null;
    if (s?.state === 'moved' || s?.state === 'back' || s?.state === 'failed') return s.state;
  }
  throw new Error('the move did not finish');
}

const screens = [
  '/api/budget/2026-11',
  '/api/activity',
  '/api/accounts',
  '/api/settings/categories',
  '/api/reports?month=2026-11',
];

/** About three years of history before the budget start (copies of the seeded bank rows) and ten ~150 KB raw pages. */
async function addHistory(budgetId: string): Promise<number> {
  const cols = (await e.DB.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
    (c) => c.name,
  );
  for (let i = 1; i <= 60; i++) {
    const sel = cols
      .map((c) =>
        c === 'txn_key'
          ? `txn_key || '-h${i}'`
          : c === 'provider_txn_id'
            ? `provider_txn_id || '-h${i}'`
            : c === 'date' || c === 'authorized_date'
              ? `date('2026-09-30', '-${i * 18} days')`
              : c === 'pending'
                ? '0'
                : c,
      )
      .join(', ');
    await e.DB.prepare(
      `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
    ).run();
  }
  for (let i = 0; i < 10; i++)
    await e.DB.prepare(
      `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, 'x', ?4, 0)`,
    )
      .bind(`raw-${i}`, budgetId, 'p'.repeat(150_000), 150_000)
      .run();
  return Number(await e.DB.prepare(`SELECT count(*) AS n FROM bank_txn`).first('n'));
}

describe('the move with a big budget', () => {
  it('moves ~3,300 transactions and large raw pages across and back with every screen unchanged', async () => {
    const budgetId = await seedD1();
    expect(await addHistory(budgetId)).toBeGreaterThan(3000);
    // The data is consistent before it moves: rule 10 holds on D1.
    expect(await checkIdentityDb({ ...env, DB: e.DB } as never, budgetId)).toMatchObject({ ok: true });
    resetRoutingCache();
    const before: Record<string, unknown> = {};
    for (const p of screens) before[p] = (await call('GET', p)).json;

    expect((await call('POST', '/api/move')).status).toBe(202);
    expect(await runMove(budgetId)).toBe('moved');
    expect(await store(budgetId).moveStatus()).toMatchObject({ state: 'verified', monthsRecomputed: 0 });
    resetRoutingCache();
    for (const p of screens) expect((await call('GET', p)).json, p).toEqual(before[p]);
    const pages = await runInDurableObject(store(budgetId), async (_o, st) =>
      st.storage.sql.exec(`SELECT count(*) AS n, sum(length(body)) AS b FROM raw_page`).one(),
    );
    expect(pages).toEqual({ n: 10, b: 1_500_000 });

    // An edit on the new databases, then the way back.
    expect((await call('POST', '/api/settings/groups', { name: 'Big edit', isBills: false })).status).toBe(
      200,
    );
    const after: Record<string, unknown> = {};
    for (const p of screens) after[p] = (await call('GET', p)).json;
    expect((await call('POST', '/api/move/back')).status).toBe(202);
    expect(await runMove(budgetId)).toBe('back');
    resetRoutingCache();
    for (const p of screens) expect((await call('GET', p)).json, p).toEqual(after[p]);
    expect(Number(await e.DB.prepare(`SELECT count(*) AS n FROM bank_txn`).first('n'))).toBeGreaterThan(3000);
    expect(
      await e.DB.prepare(`SELECT count(*) AS n FROM category_group WHERE name = 'Big edit'`).first('n'),
    ).toBe(1);
  }, 180_000);
});
