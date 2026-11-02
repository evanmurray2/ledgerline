// The move end to end (docs/multi-user.md 8): D1 holds the November budget; the owner starts the move; the
// Directory and the budget's store copy and verify everything; the switch flips; the same session sees exactly the
// same screens, now served by the Durable Objects. A difference found while verifying aborts the move with D1
// untouched, and a freeze past its time limit lifts on its own.
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { dev } from '../../src/measure/dev.js';
import { tokenHash } from '../../src/http/auth.js';
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
    if (s?.state === 'moved' || s?.state === 'failed') return s.state;
  }
  throw new Error('the move did not finish');
}

const phase = async () =>
  (await e.DB.prepare(`SELECT phase FROM move_state WHERE id = 1`).first<string>('phase'))!;
const screens = ['/api/budget/2026-11', '/api/activity', '/api/accounts', '/api/settings/categories'];

describe('the move', () => {
  it('a difference found while verifying aborts the move; D1 carries on untouched', async () => {
    const budgetId = await seedD1();
    const before = await call('GET', '/api/budget/2026-11');
    expect((await call('POST', '/api/move')).status).toBe(202);
    expect(await phase()).toBe('frozen');
    let tampered = false;
    const result = await runMove(budgetId, async () => {
      if (tampered) return;
      // Once the store has copied everything, change one row in it before it's verified.
      const verifying = await runInDurableObject(store(budgetId), async (_o, st) => {
        const r = st.storage.sql.exec(`SELECT state FROM job WHERE id = 'move_in'`).toArray()[0];
        return r ? JSON.parse(String(r.state)).phase === 'verify' : false;
      });
      if (!verifying) return;
      await runInDurableObject(store(budgetId), async (_o, st) => {
        st.storage.sql.exec(
          `UPDATE category SET name = name || ' (changed)' WHERE rowid = (SELECT min(rowid) FROM category)`,
        );
      });
      tampered = true;
    });
    expect(tampered).toBe(true);
    expect(result).toBe('failed');
    expect(await phase()).toBe('none');
    resetRoutingCache();
    // Served from D1 again, with the same numbers, and writable.
    expect((await call('GET', '/api/budget/2026-11')).json).toEqual(before.json);
    expect((await call('POST', '/api/settings/groups', { name: 'After abort', isBills: false })).status).toBe(
      200,
    );
    await e.DB.prepare(`DELETE FROM category_group WHERE name = 'After abort'`).run();
  });

  it('copies, verifies and switches; the same session sees exactly the same screens from the new databases', async () => {
    const budgetId = (await e.DB.prepare(`SELECT id FROM budget`).first<string>('id'))!;
    resetRoutingCache();
    const before: Record<string, unknown> = {};
    for (const p of screens) before[p] = (await call('GET', p)).json;
    expect((await call('POST', '/api/move')).status).toBe(202);
    // While copying: read-only, and the app is told why.
    expect((await call('GET', '/api/session')).json.writeState).toBe('moving');
    expect((await call('POST', '/api/settings/groups', { name: 'x', isBills: false })).status).toBe(503);
    expect(await runMove(budgetId)).toBe('moved');
    // With the same clock as the copied data, a full recompute in the new database changes nothing.
    expect(await store(budgetId).moveStatus()).toMatchObject({ state: 'verified', monthsRecomputed: 0 });
    expect(await phase()).toBe('moved');
    resetRoutingCache();
    for (const p of screens) expect((await call('GET', p)).json, p).toEqual(before[p]);
    // Served by the store now: a change lands there, and D1 stays frozen.
    expect(
      (await call('POST', '/api/settings/groups', { name: 'After the move', isBills: false })).status,
    ).toBe(200);
    const inStore = await runInDurableObject(
      store(budgetId),
      async (_o, st) =>
        st.storage.sql.exec(`SELECT count(*) AS n FROM category_group WHERE name = 'After the move'`).one().n,
    );
    expect(inStore).toBe(1);
    expect(
      await e.DB.prepare(`SELECT count(*) AS n FROM category_group WHERE name = 'After the move'`).first('n'),
    ).toBe(0);
    // The store now keeps its own recurring jobs.
    expect((await store(budgetId).jobs()).map((j) => j.id)).toEqual(
      expect.arrayContaining(['recurring:maintenance']),
    );
  });

  it('refuses to wipe a store or the Directory unless a move is copying', async () => {
    expect(await dir().resetForMove()).toMatchObject({ ok: false, reason: expect.stringMatching(/refused/) });
    expect(await store('anything').resetForMove('anything')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/refused/),
    });
  });
});

describe('the freeze time limit', () => {
  it('a freeze past its time limit lifts on its own', async () => {
    await e.DB.prepare(`UPDATE move_state SET phase = 'frozen', lease_expires = ?1 WHERE id = 1`)
      .bind(Date.now() - 1)
      .run();
    resetRoutingCache();
    await call('GET', '/api/auth/status');
    expect(await phase()).toBe('none');
  });
});
