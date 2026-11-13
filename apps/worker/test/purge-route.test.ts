// The route that starts emptying a sealed budget's old tables (src/seal/cutover-routes.ts, POST /api/cutover/purge),
// and what GET /api/cutover/state says about it. Nothing starts the job but this route; it refuses a budget that
// is not sealed and one whose way back is still open. The job itself is tested in purge.test.ts. Also: the
// server's full backup and restore are refused for a sealed budget.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { PURGE_ID } from '../src/seal/purge.js';
import { ownerDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);
const post = (path: string) => SELF.fetch(`${ORIGIN}${path}`, { method: 'POST', headers: H, body: '{}' });
/** The test server's clock (FAKE_NOW). */
const NOW = Date.parse('2026-11-14T20:00:00Z');

describe('Delete the readable copy: the route', () => {
  beforeAll(async () => {
    expect((await post('/__dev/seed-november')).status).toBe(200);
  });

  it('refuses a budget that is not locked, then one whose way back is open; then starts the job once', async () => {
    const db = ownerDb();
    const r1 = await post('/api/cutover/purge');
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ message: 'This budget is not locked.' });

    await db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(NOW).run();
    await db
      .prepare(`INSERT INTO store_note (key, value) VALUES ('cutover_at', ?1)`)
      .bind(NOW - 86_400_000)
      .run();
    const state = async () =>
      ((await (await get('/api/cutover/state')).json()) as { purge: { stage: string } | null }).purge;
    expect(await state()).toMatchObject({ stage: 'waiting' });
    // A locked budget is never served as a full backup, and the server can't restore it (phase 5).
    expect((await get('/api/export/dump')).status).toBe(409);
    expect((await post('/api/settings/restore')).status).toBe(409);
    const r2 = await post('/api/cutover/purge');
    expect(r2.status).toBe(409);
    expect(await r2.json()).toMatchObject({ message: expect.stringContaining('way back') as string });
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(0);

    // The way back closed long ago (by every clock the store reads).
    await db
      .prepare(`UPDATE store_note SET value = ?1 WHERE key = 'cutover_at'`)
      .bind(Date.parse('2026-01-01'))
      .run();
    expect(await state()).toMatchObject({ stage: 'ready' });
    // The job's first step must not run while this test looks: it is queued for later.
    expect((await post('/api/cutover/purge')).status).toBe(200);
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(1);
    await db
      .prepare(`UPDATE job SET run_at = ?1 WHERE id = ?2`)
      .bind(NOW + 365 * 86_400_000, PURGE_ID)
      .run();
    expect(await state()).toMatchObject({ stage: 'running' });
    // Asked again, nothing new is queued.
    expect((await post('/api/cutover/purge')).status).toBe(200);
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(1);
    // The way back is closed for good.
    expect((await post('/api/cutover/back')).status).toBe(409);
    await db.prepare(`DELETE FROM job WHERE id = ?1`).bind(PURGE_ID).run();
  });
});
