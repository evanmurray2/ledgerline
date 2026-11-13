// The route that starts emptying a sealed budget's old tables (src/seal/cutover-routes.ts, POST /api/cutover/purge),
// and what GET /api/cutover/state says about it. Nothing starts the job but this route; it refuses a budget that
// is not sealed and one whose way back is still open. The job itself is tested in purge.test.ts. Also: the
// server's full backup and restore are refused for a sealed budget.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ACTION } from '@ledgerline/seal';
import { PURGE_ID } from '../src/seal/purge.js';
import { askChallenge, genesisIn, signedHeaders, signedPost } from './signed.js';
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

  it('refuses a budget that is not locked; then starts the job once, which ends the way back', async () => {
    const db = ownerDb();
    const r1 = await post('/api/cutover/purge');
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ message: 'This budget is not locked.' });

    await db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(NOW).run();
    const budgetId = (await db.prepare(`SELECT id FROM budget LIMIT 1`).first<string>('id'))!;
    const w = await genesisIn(db, budgetId, NOW);
    const purge = () =>
      signedPost('/api/cutover/purge', '{}', { keys: w.keys, budgetId, action: ACTION.purgeOldCopy });
    await db
      .prepare(`INSERT INTO store_note (key, value) VALUES ('cutover_at', ?1)`)
      .bind(NOW - 86_400_000)
      .run();
    const state = async () =>
      ((await (await get('/api/cutover/state')).json()) as { purge: { stage: string } | null }).purge;
    // A locked budget is never served as a full backup, and the server can't restore it (phase 5).
    expect((await get('/api/export/dump')).status).toBe(409);
    expect((await post('/api/settings/restore')).status).toBe(409);
    // While the way back is open, the readable copy may be deleted all the same (the owner's choice).
    expect(await state()).toMatchObject({ stage: 'ready' });
    // The way back closed long ago (by every clock the store reads).
    await db
      .prepare(`UPDATE store_note SET value = ?1 WHERE key = 'cutover_at'`)
      .bind(Date.parse('2026-01-01'))
      .run();
    expect(await state()).toMatchObject({ stage: 'ready' });
    // Only a device that holds the budget's key starts it: a session alone, another request's signature, or a
    // challenge used once already are refused (docs/privacy-keys.md 11).
    const unsigned = await post('/api/cutover/purge');
    expect(unsigned.status).toBe(403);
    expect(await unsigned.json()).toMatchObject({ error: 'unsigned' });
    const wrong = await signedHeaders(w.keys, budgetId, ACTION.deleteAccount, '{}');
    expect((await signedPost('/api/cutover/purge', '{}', null, wrong)).status).toBe(403);
    const ch = await askChallenge(ACTION.purgeOldCopy);
    const once = await signedHeaders(w.keys, budgetId, ACTION.purgeOldCopy, '{}', ch);
    expect((await signedPost('/api/cutover/purge', '{"x":1}', null, once)).status).toBe(403);
    expect((await signedPost('/api/cutover/purge', '{}', null, once)).status).toBe(403);
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(0);
    // The job's first step must not run while this test looks: it is queued for later.
    expect((await purge()).status).toBe(200);
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(1);
    await db
      .prepare(`UPDATE job SET run_at = ?1 WHERE id = ?2`)
      .bind(NOW + 365 * 86_400_000, PURGE_ID)
      .run();
    expect(await state()).toMatchObject({ stage: 'running' });
    // Asked again, nothing new is queued.
    expect((await purge()).status).toBe(200);
    expect(await db.prepare(`SELECT count(*) AS n FROM job WHERE id = ?1`).bind(PURGE_ID).first('n')).toBe(1);
    // The way back is closed for good, and the state says so.
    expect((await post('/api/cutover/back')).status).toBe(409);
    expect(await (await get('/api/cutover/state')).json()).toMatchObject({ backUntil: null });
    await db.prepare(`DELETE FROM job WHERE id = ?1`).bind(PURGE_ID).run();
  });
});
