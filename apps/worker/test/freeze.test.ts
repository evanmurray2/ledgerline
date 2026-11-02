// Serving during the move (docs/multi-user.md 8.2) on the D1 path: while move_state is 'frozen', screens keep
// working read-only and say 'moving', edits get a "moving" answer and change nothing, and D1 itself refuses any
// write that gets past that. Afterwards everything works as before.
import { createExecutionContext, env } from 'cloudflare:test';
import { afterAll, describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { resetRoutingCache } from '../src/store/router.js';

const ORIGIN = 'https://ledgerline.test';
const call = async (method: string, path: string, body?: unknown) => {
  const h: Record<string, string> = { origin: ORIGIN };
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
};
const setPhase = async (p: string) => {
  await env.DB.prepare(`UPDATE move_state SET phase = ?1 WHERE id = 1`).bind(p).run();
  resetRoutingCache();
};
const groups = async () =>
  Number(await env.DB.prepare(`SELECT count(*) AS n FROM category_group`).first('n'));

afterAll(() => setPhase('none'));

describe('while the data is moving', () => {
  it('screens load read-only and report moving; edits are refused and change nothing', async () => {
    await call('POST', '/__dev/seed-november');
    const before = await groups();
    await setPhase('frozen');
    const s = await call('GET', '/api/session');
    expect(s.status).toBe(200);
    expect(s.json.writeState).toBe('moving');
    expect((await call('GET', '/api/budget/2026-11')).status).toBe(200);
    expect((await call('GET', '/api/activity')).status).toBe(200);
    const w = await call('POST', '/api/settings/groups', { name: 'New', isBills: false });
    expect(w).toMatchObject({ status: 503, json: { error: 'moving' } });
    expect(await groups()).toBe(before);
  });

  it('D1 itself refuses a write that gets past the app', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO category_group (id, budget_id, name, created_at, updated_at) VALUES ('g', 'b', 'G', 0, 0)`,
      ).run(),
    ).rejects.toThrow(/frozen/);
  });

  it('afterwards everything works as before', async () => {
    await setPhase('none');
    const before = await groups();
    expect((await call('POST', '/api/settings/groups', { name: 'New', isBills: false })).status).toBe(200);
    expect(await groups()).toBe(before + 1);
    expect((await call('GET', '/api/session')).json.writeState).toBe('ok');
  });
});
