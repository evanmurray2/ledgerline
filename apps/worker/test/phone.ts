// The app as the phone runs it (D-45): screens come from a copy synced from the server and worked out by the local
// engine; changes and the few server reads go to the Worker. Tests read numbers through this, so they check the code
// production runs: the server stores, the engine counts.
import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { SERVER_READS } from '../src/routes/api.js';
import type { SyncPage } from '../src/routes/sync.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const phones = new Map<string, Promise<LocalEngine>>();
let copies = 0;

async function server(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, init);
}

/** The phone's copy for the signed-in user's budget (one per budget for the whole test file). */
export async function phone(): Promise<LocalEngine> {
  const r = await server('/api/session');
  expect(r.status, '/api/session').toBe(200);
  const s = (await r.json()) as { budget: { id: string }; user: { email: string } };
  let p = phones.get(s.budget.id);
  if (!p) {
    p = (async () => {
      const db = storeDb(`phone-copy-${++copies}`);
      await migrateLocal(db, Date.now());
      return new LocalEngine(db, { budgetId: s.budget.id, userId: 'phone', email: s.user.email });
    })();
    phones.set(s.budget.id, p);
  }
  return p;
}

/** Downloads what changed on the server into the copy and works it out, as the app does before showing a screen. */
export async function syncPhone(engine?: LocalEngine): Promise<LocalEngine> {
  const e = engine ?? (await phone());
  for (let pages = 0; ; pages++) {
    if (pages > 500) throw new Error('sync did not finish');
    const { since, cursor } = await e.nextRequest();
    const q = new URLSearchParams({ since: String(since), limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const r = await server(`/api/sync?${q}`);
    expect(r.status, '/api/sync').toBe(200);
    const res = await e.apply((await r.json()) as SyncPage);
    if (res.caughtUp) break;
  }
  if (await e.needsDerive()) await e.derive();
  return e;
}

/** A fetch the way the app makes it: a screen from the phone's copy, anything else from the Worker. */
export async function app(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const pathname = path.split('?')[0]!;
  if ((method === 'GET' || method === 'HEAD') && !SERVER_READS.some((r) => r.test(pathname))) {
    const e = await syncPhone();
    return e.request(method, path);
  }
  const r = await server(path, init);
  if (method === 'GET' || method === 'HEAD' || !r.ok || r.status === 204) return r;
  // The server no longer works out Ready to Assign: the app fills it from the copy once the change is synced.
  const json = (await r.json()) as unknown;
  if (json && typeof json === 'object' && (json as { ok?: unknown }).ok === true && !('rta' in json)) {
    const { rta, updating } = await (await syncPhone()).rta();
    return Response.json({ ...json, rta, rtaUpdating: updating }, { status: r.status, headers: r.headers });
  }
  return Response.json(json, { status: r.status, headers: r.headers });
}
