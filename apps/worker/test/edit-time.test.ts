// The time an edit's rows carry (http/clock.ts editNow): the time the person made it, when the phone's queue says
// so, kept within the last 7 days and never later than the server's clock. Sign-in never reads it.
import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { storeDb } from './store-db.js';

const ORIGIN = 'https://ledgerline.test';
const H = { origin: ORIGIN, 'content-type': 'application/json', 'x-ledgerline': '1' };
const send = (method: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method, headers: { ...H, ...extra }, body: JSON.stringify(body) });
let n = 0;
const edit = (at: number) => ({ 'x-edit-id': `edit-time-${++n}-xxxx`, 'x-edit-at': String(at) });

describe('the time of an edit', () => {
  let budget: string;
  let serverNow: number;
  const assigned = async (category: string) => {
    const r = await storeDb(budget)
      .prepare(`SELECT updated_at FROM assignment WHERE month = '2026-11' AND category_id = ?1`)
      .bind(category)
      .first<{ updated_at: number }>();
    return r!.updated_at;
  };
  const assign = (category: string, extra: Record<string, string> = {}) =>
    send('POST', '/api/budget/set', { month: '2026-11', categoryId: category, assigned: 100 + n }, extra);

  beforeAll(async () => {
    expect((await send('POST', '/__dev/seed-november', {})).status).toBe(200);
    const s = (await (await SELF.fetch(`${ORIGIN}/api/session`)).json()) as { budget: { id: string } };
    budget = s.budget.id;
    expect((await assign('rent')).status).toBe(200);
    serverNow = await assigned('rent');
  });

  it('a queued edit writes the time the person made it', async () => {
    const at = serverNow - 3 * 3_600_000;
    expect((await assign('rent', edit(at))).status).toBe(200);
    expect(await assigned('rent')).toBe(at);
  });

  it('never later than the server’s clock, and never more than 7 days back', async () => {
    expect((await assign('rent', edit(serverNow + 86_400_000))).status).toBe(200);
    const late = await assigned('rent');
    expect(late).toBeGreaterThanOrEqual(serverNow);
    expect(late).toBeLessThan(serverNow + 60_000);
    expect((await assign('rent', edit(serverNow - 30 * 86_400_000))).status).toBe(200);
    const old = await assigned('rent');
    expect(old).toBeGreaterThanOrEqual(serverNow - 7 * 86_400_000);
    expect(old).toBeLessThan(serverNow - 7 * 86_400_000 + 60_000);
  });

  it('a time with no edit id, or a time that is not a number, changes nothing', async () => {
    expect((await assign('rent', { 'x-edit-at': String(serverNow - 3_600_000) })).status).toBe(200);
    expect(await assigned('rent')).toBeGreaterThanOrEqual(serverNow);
    expect((await assign('rent', { 'x-edit-id': 'edit-time-bad-xxxx', 'x-edit-at': 'soon' })).status).toBe(
      200,
    );
    expect(await assigned('rent')).toBeGreaterThanOrEqual(serverNow);
  });
});
