// Unchanged screens answer 304 for a couple of rows read; anything that can change a screen changes its ETag.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = (p: string, etag?: string) =>
  SELF.fetch(`https://ledgerline.test${p}`, { headers: etag ? { 'if-none-match': etag } : {} });
const post = (p: string, body: unknown) =>
  SELF.fetch(`https://ledgerline.test${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('screen ETags', () => {
  let tag = '';
  beforeAll(async () => {
    expect((await post('/__dev/seed-november', {})).status).toBe(200);
  });

  it('an unchanged screen is 304, with no body', async () => {
    const r = await get('/api/budget/2026-11');
    expect(r.status).toBe(200);
    tag = r.headers.get('etag')!;
    expect(tag).toMatch(/^W\/"/);
    expect(r.headers.get('cache-control')).toBe('private, no-cache');
    await r.text();
    const again = await get('/api/budget/2026-11', tag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('an edit through the API changes it', async () => {
    const cat = await env.DB.prepare(`SELECT id FROM category WHERE kind = 'spending' LIMIT 1`).first<{
      id: string;
    }>();
    expect(
      (await post('/api/budget/assign', { month: '2026-11', items: [{ categoryId: cat!.id, amount: 100 }] }))
        .status,
    ).toBe(200);
    const r = await get('/api/budget/2026-11', tag);
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).not.toBe(tag);
    tag = r.headers.get('etag')!;
  });

  it('a sync applying or processing bank rows changes it, and so does a connection update', async () => {
    await env.DB.prepare(`UPDATE apply_counter SET seq = seq + 1 WHERE id = 1`).run();
    let r = await get('/api/budget/2026-11', tag);
    expect(r.status).toBe(200);
    tag = r.headers.get('etag')!;
    await env.DB.prepare(`UPDATE budget SET processed_through = processed_through + 1`).run();
    r = await get('/api/budget/2026-11', tag);
    expect(r.status).toBe(200);
    tag = r.headers.get('etag')!;
    await env.DB.prepare(`UPDATE connection SET last_synced_at = coalesce(last_synced_at, 0) + 1`).run();
    r = await get('/api/budget/2026-11', tag);
    expect(r.status).toBe(200);
  });

  it('session and sign-in state are never cached', async () => {
    const r = await get('/api/session');
    expect(r.headers.get('etag')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});
