// Rewinding a budget from Settings → Import and export (runbooks/restore.md): the route checks the typed name and the
// 30 days, keeps no bookmark in the budget itself, and can always undo the last rewind; the Directory keeps that
// rewind, since the rewind can't reach it. Cloudflare's point-in-time recovery doesn't run in tests, so the route is
// called with stand-ins for the store's hooks and the Directory's record is checked on its own.
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/http/context.js';
import { syncRoutes } from '../src/routes/sync.js';
import { DIRECTORY_NAME, type Directory, type RestoreRecord } from '../src/store/directory.js';
import { storeDb } from './store-db.js';

const e = env as unknown as { DIRECTORY: DurableObjectNamespace<Directory> };
const B = 'b_rewind';
const NOW = Date.UTC(2026, 10, 9, 18, 0);
const db = storeDb('rewind');
let last: RestoreRecord | null = null;
const calls: string[] = [];

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('budgetId', B);
  return next();
});
app.route('/api', syncRoutes);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.fetch(
    new Request(`https://x${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      DB: db,
      FAKE_NOW: new Date(NOW).toISOString(),
      RESTORE_TO: async (at: number) => {
        calls.push(`to ${new Date(at).toISOString()}`);
        last = { at: NOW, to: at, undo: `undo-${at}` };
        return { undo: last.undo };
      },
      RESTORE_UNDO: async () => {
        if (!last) return null;
        calls.push(`undo ${last.undo}`);
        last = { at: NOW, to: null, undo: 'undo-of-undo' };
        return { undo: last.undo };
      },
      LAST_RESTORE: async () => (last ? { at: last.at, to: last.to } : null),
    } as never,
  );
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe('rewinding a budget', () => {
  beforeAll(async () => {
    await db
      .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'Home', 0, 0)`)
      .bind(B)
      .run();
  });

  it('needs the budget’s name and a time in the last 30 days', async () => {
    const t = new Date(NOW - 3600_000).toISOString();
    expect((await call('POST', '/api/settings/restore', { before: t, confirm: 'home' })).status).toBe(422);
    const old = new Date(NOW - 31 * 86_400_000).toISOString();
    expect((await call('POST', '/api/settings/restore', { before: old, confirm: 'Home' })).status).toBe(422);
    const later = new Date(NOW + 60_000).toISOString();
    expect((await call('POST', '/api/settings/restore', { before: later, confirm: 'Home' })).status).toBe(
      422,
    );
    expect((await call('POST', '/api/settings/restore', { confirm: 'Home' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('has nothing to undo before the first rewind', async () => {
    expect((await call('GET', '/api/settings/restore/last')).json).toEqual({ last: null });
    const r = await call('POST', '/api/settings/restore', { undo: true, confirm: 'Home' });
    expect(r).toMatchObject({ status: 422, json: { error: 'invalid' } });
  });

  it('rewinds, shows the last rewind, and undoes it', async () => {
    const t = new Date(NOW - 3600_000).toISOString();
    const r = await call('POST', '/api/settings/restore', { before: t, confirm: ' Home ' });
    expect(r.status).toBe(200);
    expect(calls).toEqual([`to ${t}`]);
    expect((await call('GET', '/api/settings/restore/last')).json).toEqual({
      last: { at: new Date(NOW).toISOString(), to: t },
    });
    expect((await call('POST', '/api/settings/restore', { undo: true, confirm: 'Home' })).status).toBe(200);
    expect(calls[1]).toBe(`undo undo-${Date.parse(t)}`);
    // The undo is a rewind too, and can be undone in turn.
    expect((await call('GET', '/api/settings/restore/last')).json).toEqual({
      last: { at: new Date(NOW).toISOString(), to: null },
    });
  });

  it('the Directory keeps the last rewind of each budget', async () => {
    const d = e.DIRECTORY.get(e.DIRECTORY.idFromName(DIRECTORY_NAME));
    expect(await d.lastRestore('b_none')).toBeNull();
    await d.noteRestore('b_one', { at: 1, to: 0, undo: 'u1' });
    await d.noteRestore('b_one', { at: 2, to: null, undo: 'u2' });
    await d.noteRestore('b_two', { at: 3, to: 1, undo: 'u3' });
    expect(await d.lastRestore('b_one')).toEqual({ at: 2, to: null, undo: 'u2' });
    expect(await d.lastRestore('b_two')).toEqual({ at: 3, to: 1, undo: 'u3' });
  });
});
