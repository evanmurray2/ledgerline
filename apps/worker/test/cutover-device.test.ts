// The phone's side of the cutover (src/local/cutover-device.ts) against the real routes: the copy is compared with
// the server, the first entry and snapshot go up, the budget is sealed and the snapshot is read back; and each
// way it can fail leaves the budget, or says what to do.
import { ulid } from '@ledgerline/platform';
import { encodeEntry } from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { cutoverOnDevice, type CutoverDeps } from '../src/local/cutover-device.js';
import { openSnapshot } from '../src/local/device-snapshot.js';
import type { LocalEngine } from '../src/local/engine.js';
import { cutoverTransport, httpTransport, TransportError } from '../src/local/http-transport.js';
import { LogSession } from '../src/local/log-session.js';
import type { RestBatch } from '../src/routes/sync.js';
import { PHONE, Writer } from './log-writer.js';
import { syncPhone } from './phone.js';
import { ownerDb } from './store-db.js';
import { differences, newPhone, rowsOf } from './twin.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const LAPTOP = '01CX5ZZKBKACTAV9WEVGEMMVRZ';
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string, body: unknown = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
const assign = (amount: number) =>
  post('/api/budget/assign', { month: '2026-11', items: [{ categoryId: 'rent', amount }] });
const fetcher = (path: string, init?: RequestInit) =>
  SELF.fetch(`${ORIGIN}${path}`, { ...init, headers: { origin: ORIGIN, ...(init?.headers ?? {}) } });

/** Brings a phone's copy up to date: the synced tables, and the rest. */
async function everything(e: LocalEngine): Promise<void> {
  await syncPhone(e);
  await e.restAgain();
  for (let n = 0; ; n++) {
    if (n > 500) throw new Error('the rest did not end');
    const ask = await e.restRequest();
    if (!ask) return;
    const q = new URLSearchParams({ table: ask.table });
    if (ask.after !== null) q.set('after', String(ask.after));
    await e.applyRest((await (await get(`/api/sync/rest?${q}`)).json()) as RestBatch);
  }
}

describe('the cutover, from the phone', () => {
  let budget: string;
  const t = httpTransport(fetcher);
  const cut = cutoverTransport(fetcher);
  const spares: LocalEngine[] = [];

  beforeAll(async () => {
    expect((await post('/__dev/seed-november')).status).toBe(200);
    budget = ((await (await get('/api/session')).json()) as { budget: { id: string } }).budget.id;
    for (let i = 1; i <= 3; i++) expect((await assign(i)).status).toBe(200);
    // The seeded links never had a token: the link check says so.
    await ownerDb().prepare(`UPDATE bank_link SET check_result = 'no_token', checked_at = 1`).run();
    // Empty copies for later devices: who a copy is for can't be asked once the budget is sealed.
    for (let i = 0; i < 6; i++) spares.push(await newPhone());
  });

  const deps = async (phone: LocalEngine, over: Partial<CutoverDeps> = {}): Promise<CutoverDeps> => {
    const w = new Writer(budget, NOW - 60_000);
    return {
      keys: (await w.genesis(), w.keys),
      genesis: w.last!,
      budgetId: budget,
      deviceId: PHONE,
      clock: () => NOW,
      snapshotId: ulid(NOW),
      encode: encodeEntry,
      sync: () => everything(phone),
      cutover: cut,
      snapshots: t,
      ...over,
    };
  };
  const sealedNow = async () => (await get('/api/sync?since=0&limit=1')).status === 409;

  it('a copy that is not the server’s is not moved; a step that fails leaves the budget as it was', async () => {
    const phone = spares.pop()!;
    // The copy differs from the server in one row, and a sync does not mend it.
    const drift = await deps(phone, {
      sync: async () => {
        await everything(phone);
        await phone.db.prepare(`UPDATE category SET name = name || '?' WHERE id = 'rent'`).run();
      },
    });
    expect(await cutoverOnDevice(phone, drift)).toEqual({
      ok: false,
      why: 'This device’s copy is not the same as the server’s.',
      tables: ['category'],
    });
    expect(await sealedNow()).toBe(false);
    // An edit that waits on the device: nothing is asked of the server.
    const waiting = spares.pop()!;
    await everything(waiting);
    await waiting.enqueue({
      id: 'waits-edit-1-xxxxxx',
      at: NOW,
      method: 'POST',
      path: '/api/budget/assign',
      body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 5 }] },
    });
    expect(await cutoverOnDevice(waiting, await deps(waiting, { sync: async () => undefined }))).toEqual({
      ok: false,
      why: 'Changes made on this device wait to be sent.',
    });

    // The server refuses the seal: the copy, which was changed for the move, is thrown away.
    const again = spares.pop()!;
    const refused = await deps(again, {
      cutover: { ...cut, seal: async () => ({ ok: false, why: 'Not today.' }) },
    });
    expect(await cutoverOnDevice(again, refused)).toEqual({ ok: false, why: 'Not today.' });
    expect((await again.state()).through).toBe(0);
    expect(await sealedNow()).toBe(false);
    // A fault of the network is a fault, and the copy is thrown away too.
    const broken = spares.pop()!;
    await expect(
      cutoverOnDevice(
        broken,
        await deps(broken, {
          cutover: {
            ...cut,
            begin: async () => {
              throw new TransportError(502, 'The server gave no answer. Try again.');
            },
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TransportError);
    expect((await broken.state()).through).toBe(0);
    // The freeze of the failed tries ends by itself (here: by hand), and the budget is as it was.
    await ownerDb().prepare(`DELETE FROM store_mark`).run();
    expect((await assign(7)).status).toBe(200);
  }, 120_000);

  it('moves the budget, and reads the first snapshot back; a snapshot that does not come back says so', async () => {
    const phone = spares.pop()!;
    const d = await deps(phone);
    const moved = await cutoverOnDevice(phone, d);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    expect(await sealedNow()).toBe(true);
    expect(moved.log.number).toBe(1);
    expect((await phone.state()).through).toBe(1);
    expect(await phone.noted(LogSession.PLACE)).not.toBeNull();

    // The phone lives on the log, and a second device joins from the first snapshot.
    const session = new LogSession(phone, moved.log, t, encodeEntry);
    await phone.enqueue({
      id: 'moved-edit-1-xxxxxx',
      at: NOW,
      method: 'POST',
      path: '/api/budget/assign',
      body: { month: '2026-11', items: [{ categoryId: 'rent', amount: 11 }] },
    });
    expect(await session.flush()).toEqual({ sent: 1, lost: 0 });
    const second = spares.pop()!;
    const log2 = await openSnapshot(second, t, {
      keys: [d.keys],
      budgetId: budget,
      deviceId: LAPTOP,
      clock: () => NOW,
    });
    await new LogSession(second, log2, t, encodeEntry).pull();
    expect(differences(await rowsOf(second), await rowsOf(phone))).toEqual([]);

    // The way back, then a move whose snapshot does not come back whole: the budget is sealed, and the phone
    // says to take the way back.
    expect(await (await post('/api/cutover/back')).json()).toEqual({ ok: true });
    expect(await sealedNow()).toBe(false);
    const other = await newPhone();
    const lost = await cutoverOnDevice(
      other,
      await deps(other, { snapshots: { manifest: t.manifest, chunk: async () => null } }),
    );
    expect(lost).toEqual({
      ok: false,
      why: 'The server did not keep the first snapshot whole. Take the way back.',
      sealed: true,
    });
    expect(await sealedNow()).toBe(true);
    expect(await (await post('/api/cutover/back')).json()).toEqual({ ok: true });
    expect((await assign(12)).status).toBe(200);
  }, 120_000);
});
