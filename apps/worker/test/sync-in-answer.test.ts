// An online edit's answer carries the changes since the change number the phone sends (x-sync-since, routes/sync.ts
// syncInAnswer), so the phone updates its copy without a second request. Applied to the copy, the answer gives the
// same screens as a sync; an edit sent from the offline queue, or one without the header, carries nothing.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNC_SINCE_HEADER } from '@ledgerline/contracts';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { ANSWER_SYNC_ROWS, type SyncPage } from '../src/routes/sync.js';
import { storeDb } from './store-db.js';
import { syncPhone } from './phone.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const api = async (path: string, init?: RequestInit) => SELF.fetch(`https://ledgerline.test${path}`, init);
const who = (budgetId: string) => ({ budgetId, userId: 'phone', email: 'owner@example.com' });
let copies = 0;

describe('an edit’s answer carries what it changed', () => {
  let budgetId: string;
  let month: string;
  let category: string;
  let engine: LocalEngine;

  const copy = async () => {
    const db = storeDb(`answer-copy-${++copies}`);
    await migrateLocal(db, Date.now());
    return syncPhone(new LocalEngine(db, who(budgetId)));
  };
  const assign = (amount: number, headers: Record<string, string> = {}) =>
    api('/api/budget/assign', {
      method: 'POST',
      headers: { ...H, ...headers },
      body: JSON.stringify({ month, items: [{ categoryId: category, amount }] }),
    });

  beforeAll(async () => {
    expect((await api('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    const s = (await (await api('/api/session')).json()) as { budget: { id: string; currentMonth: string } };
    budgetId = s.budget.id;
    month = s.budget.currentMonth;
    engine = await copy();
    const cats = (await (await engine.request('GET', '/api/settings/categories')).json()) as {
      groups: { categories: { id: string; kind: string }[] }[];
    };
    category = cats.groups.flatMap((g) => g.categories).find((c) => c.kind === 'spending')!.id;
  });

  it('gives the copy the same screens as a sync', async () => {
    const since = (await engine.state()).through;
    const r = await assign(4321, { [SYNC_SINCE_HEADER]: String(since) });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; sync: SyncPage };
    expect(body.ok).toBe(true);
    expect(body.sync.rows.length).toBeGreaterThan(0);
    expect(body.sync.rows.length).toBeLessThanOrEqual(ANSWER_SYNC_ROWS);
    expect(body.sync.through).toBeGreaterThan(since);
    expect(body.sync.more).toBe(false);
    expect(await engine.apply(body.sync)).toMatchObject({ reset: false, caughtUp: true });
    if (await engine.needsDerive()) await engine.derive();
    const ref = await copy();
    for (const path of [`/api/budget/${month}`, '/api/accounts', '/api/settings/categories'])
      expect(await (await engine.request('GET', path)).json(), path).toEqual(
        await (await ref.request('GET', path)).json(),
      );
    // Nothing is left for a sync to bring.
    const after = await api(`/api/sync?since=${body.sync.through}`);
    expect(((await after.json()) as SyncPage).rows).toEqual([]);
  });

  it('carries nothing without the header: the offline queue sends none, and syncs once at its end', async () => {
    const plain = (await (await assign(1111)).json()) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('sync');
    const queued = await assign(2222, { 'x-edit-id': `e${Date.now()}`, 'x-edit-at': String(Date.now()) });
    expect(queued.status).toBe(200);
    expect(await queued.json()).not.toHaveProperty('sync');
  });

  // The app sends an edit that can wait in its queue with its id from the first try (apps/web/src/api/client.ts).
  it('an online edit that carries its id still gets its changes', async () => {
    const since = (await engine.state()).through;
    const r = await assign(3333, {
      [SYNC_SINCE_HEADER]: String(since),
      'x-edit-id': `e${Date.now()}x`,
      'x-edit-at': String(Date.now()),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toHaveProperty('sync');
  });

  it('a refused edit carries nothing', async () => {
    const since = (await engine.state()).through;
    const r = await api('/api/budget/assign', {
      method: 'POST',
      headers: { ...H, [SYNC_SINCE_HEADER]: String(since) },
      body: JSON.stringify({ month, items: [{ categoryId: 'no-such-category', amount: 1 }] }),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await r.json()).not.toHaveProperty('sync');
  });
});
