// A new budget starts locked (D-102; src/seal/start.ts and src/local/start-device.ts) against the real routes:
// the server says the budget is new, the device sends its first entry and first snapshot, the budget is sealed
// and the snapshot reads back; a second device joins from it, and the budget's first edit goes out as an entry.
import { ulid } from '@ledgerline/platform';
import { encodeEntry } from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { openSnapshot } from '../src/local/device-snapshot.js';
import { LocalEngine, migrateLocal } from '../src/local/engine.js';
import { httpTransport, startTransport } from '../src/local/http-transport.js';
import { LogSession } from '../src/local/log-session.js';
import { startOnDevice, type StartDeps, type StartTransport } from '../src/local/start-device.js';
import { OLD_START } from '../src/seal/start.js';
import { PHONE, Writer } from './log-writer.js';
import { ownerDb, copyDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const fetcher = (path: string, init?: RequestInit) =>
  SELF.fetch(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init?.headers ?? {}) } });
const session = async () =>
  (await (await fetcher('/api/session', { headers: { 'x-ledgerline-sealed': '1' } })).json()) as {
    sealed?: boolean;
    fresh?: boolean;
    budgetId: string;
  };
let copies = 0;

describe('a new budget, locked from the start', () => {
  let budget: string;
  const t = httpTransport(fetcher);
  const start = startTransport(fetcher);
  const copy = async () => {
    const db = copyDb(`start-copy-${++copies}`);
    await migrateLocal(db, NOW);
    return new LocalEngine(db, { budgetId: budget, userId: 'phone', email: 'owner@example.com' }, () => NOW);
  };
  const deps = async (over: Partial<StartDeps> = {}): Promise<StartDeps> => {
    const w = new Writer(budget, NOW - 60_000);
    await w.genesis();
    return {
      keys: w.keys,
      genesis: w.last!,
      budgetId: budget,
      deviceId: PHONE,
      clock: () => NOW,
      snapshotId: ulid(NOW),
      encode: encodeEntry,
      start,
      snapshots: t,
      ...over,
    };
  };

  beforeAll(async () => {
    const s = await session();
    expect(s).toMatchObject({ sealed: true, fresh: true });
    budget = s.budgetId;
  });

  it('a start that fails leaves nothing in use, and a budget with data of its own never starts', async () => {
    const phone = await copy();
    const refused = await startOnDevice(
      phone,
      await deps({ start: { ...start, seal: async () => ({ ok: false, why: 'Not today.' }) } }),
    );
    expect(refused).toEqual({ ok: false, why: 'Not today.' });
    expect((await phone.state()).through).toBe(0);
    expect(await session()).toMatchObject({ fresh: true });
    // The log's routes don't answer for it.
    expect((await fetcher('/api/log?after=0')).status).not.toBe(200);

    // No bank route answers before the budget is locked.
    const refresh = await fetcher('/api/settings/connections/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ledgerline': '1', 'x-ledgerline-sealed': '1' },
      body: '{}',
    });
    expect(refresh.status).toBe(409);
    expect(await refresh.json()).toMatchObject({ error: 'not_locked' });

    // A budget that holds a bank link is not new.
    const db = ownerDb();
    await db
      .prepare(
        `INSERT INTO bank_link (id, connection_id, budget_id, provider, linked_at, created_at)
         VALUES ('x', 'con_x', ?1, 'fake', 1, 1)`,
      )
      .bind(budget)
      .run();
    expect(await startOnDevice(await copy(), await deps())).toEqual({
      ok: false,
      why: 'This budget already holds data. It can’t start again.',
    });
    await db.prepare(`DELETE FROM bank_link WHERE id = 'x'`).run();
  }, 120_000);

  it('a newer begin replaces the start: the older one’s chunks and seal are refused', async () => {
    // Another device begins after this one's begin: this one's chunks are refused.
    const beganAgain: StartTransport = {
      ...start,
      begin: async (s) => {
        const mine = await start.begin(s);
        await start.begin(s);
        return mine;
      },
    };
    expect(await startOnDevice(await copy(), await deps({ start: beganAgain }))).toEqual({
      ok: false,
      why: OLD_START,
    });
    // Another device begins after this one sent its chunks: this one's seal is refused.
    let sent: Parameters<StartTransport['begin']>[0] | null = null;
    const sealLate: StartTransport = {
      ...start,
      begin: (s) => {
        sent = s;
        return start.begin(s);
      },
      seal: async (startId) => {
        await start.begin(sent!);
        return start.seal(startId);
      },
    };
    expect(await startOnDevice(await copy(), await deps({ start: sealLate }))).toEqual({
      ok: false,
      why: OLD_START,
    });
    expect(await session()).toMatchObject({ fresh: true });
    // A start id that was never given is refused too.
    expect(await start.seal('12345')).toEqual({ ok: false, why: OLD_START });
  }, 120_000);

  it('starts the budget locked; a second device joins, and the first edit goes out as an entry', async () => {
    const phone = await copy();
    const d = await deps();
    const r = await startOnDevice(phone, d);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.log.number).toBe(1);
    expect((await phone.state()).through).toBe(1);
    expect(await phone.noted(LogSession.PLACE)).not.toBeNull();
    // The server answers for a sealed budget now: no longer new, and its log is there.
    const s = await session();
    expect(s.sealed).toBe(true);
    expect(s.fresh).toBeUndefined();
    expect((await fetcher('/api/log?after=0')).status).toBe(200);
    // The copy holds the budget's own row, before its first-run setup.
    const own = await (await phone.request('GET', '/api/session')).json();
    expect(own).toMatchObject({ budget: { id: budget, name: 'My budget', setupStep: 'start' } });

    // The first-run setup is an edit on the device, sent as an entry of the log.
    await phone.enqueue({
      id: 'start-edit-1-xxxxxx',
      at: NOW,
      method: 'POST',
      path: '/api/setup/start',
      body: { startMonth: '2026-11' },
    });
    expect(await new LogSession(phone, r.log, t, encodeEntry).flush()).toEqual({ sent: 1, lost: 0 });

    // A second device opens the first snapshot and reads the log on: it has the same budget.
    const second = await copy();
    const log2 = await openSnapshot(second, t, {
      keys: [d.keys],
      budgetId: budget,
      deviceId: LAPTOP,
      clock: () => NOW,
    });
    await new LogSession(second, log2, t, encodeEntry).pull();
    expect(await (await second.request('GET', '/api/session')).json()).toMatchObject({
      budget: { id: budget, startMonth: '2026-11' },
    });

    // It starts once.
    expect(await startOnDevice(await copy(), await deps())).toEqual({
      ok: false,
      why: 'This budget is locked already.',
    });
  }, 120_000);
});
