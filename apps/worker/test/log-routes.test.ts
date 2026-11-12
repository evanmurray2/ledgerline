// The routes of the sealed log (src/seal/log-routes.ts): they answer only for a budget marked sealed, and a
// sealed budget has no other routes.
import { encodeEntry } from '@ledgerline/seal';
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { logGenesis, logHead } from '../src/seal/log-store.js';
import { Writer } from './log-writer.js';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('the routes of the sealed log', () => {
  let budget: string;
  let w: Writer;
  const seal = (on: boolean) =>
    on
      ? storeDb(budget)
          .prepare(`INSERT OR IGNORE INTO store_mark (key, at) VALUES ('sealed', ?1)`)
          .bind(NOW)
          .run()
      : storeDb(budget).prepare(`DELETE FROM store_mark`).run();

  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
    budget = ((await (await get('/api/session')).json()) as { budget: { id: string } }).budget.id;
    // The budget's first entry, as the cutover will store it.
    w = new Writer(budget, NOW - 60_000);
    const r = await logGenesis(
      {
        db: storeDb(budget),
        budgetId: budget,
        now: NOW,
        resting: false,
        freshWay: false,
        lastCompleteRun: 0,
        receiptHashes: async () => null,
      },
      encodeEntry(await w.genesis()),
    );
    expect(r).toMatchObject({ ok: true, number: 1 });
  });

  it('answer nothing for a budget that is not sealed', async () => {
    expect((await get('/api/log?after=0')).status).toBe(404);
    const e = await w.edit('not yet');
    expect((await post('/api/log/append', { base: 1, entries: [b64(encodeEntry(e))] })).status).toBe(404);
    expect(await logHead(storeDb(budget))).toBe(1);
    // That entry was never stored: the writer goes back to where the log is.
    w = Object.assign(new Writer(budget, NOW - 50_000), { keys: w.keys, bk: w.bk, last: null, counter: 1 });
  });

  it('a sealed budget: the log is read and written here, and nothing else answers', async () => {
    await seal(true);
    try {
      const first = (await (await get('/api/log?after=0')).json()) as {
        entries: string[];
        number: number;
        more: boolean;
      };
      expect(first).toMatchObject({ number: 1, more: false });
      expect(first.entries.length).toBe(1);
      // The writer continues from the stored first entry.
      const { readEntry } = await import('@ledgerline/seal');
      w.last = await readEntry(Uint8Array.from(atob(first.entries[0]!), (c) => c.charCodeAt(0)));

      const a = await w.edit('one');
      const b = await w.edit('two');
      const write = { base: 1, entries: [b64(encodeEntry(a)), b64(encodeEntry(b))] };
      const stored = await post('/api/log/append', write);
      expect(stored.status).toBe(200);
      expect(await stored.json()).toEqual({ ok: true, number: 3, stored: 'now' });
      // Sent again: stored already. On an older log: behind, with where the log stands.
      expect(await (await post('/api/log/append', write)).json()).toEqual({
        ok: true,
        number: 3,
        stored: 'already',
      });
      const late = await post('/api/log/append', {
        base: 1,
        entries: [b64(encodeEntry(await w.edit('three')))],
      });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ ok: false, why: 'behind', number: 3, retry: true });
      const after = (await (await get('/api/log?after=1')).json()) as { entries: string[]; number: number };
      expect(after.entries).toEqual(write.entries);

      // A body that is not a write, and a request with no CSRF header.
      expect((await post('/api/log/append', { base: 3, entries: ['not base64!'] })).status).toBe(400);
      const bare = await SELF.fetch(`${ORIGIN}/api/log/append`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(write),
      });
      expect(bare.status).toBe(403);

      // The old routes leave a sealed budget alone.
      expect((await get('/api/sync?since=0&limit=5')).status).toBe(409);
      expect(
        (await post('/api/budget/set', { month: '2026-11', categoryId: 'rent', assigned: 1 })).status,
      ).toBe(409);
    } finally {
      await seal(false);
    }
    expect((await get('/api/sync?since=0&limit=5')).status).toBe(200);
  });
});
