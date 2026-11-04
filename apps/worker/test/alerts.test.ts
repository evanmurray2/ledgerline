// Stored alerts (the `alert` table: sync, daily scan, a phone's identity check) show on Accounts and can be dismissed.
import { app } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView } from '@ledgerline/contracts';
import { ownerDb } from './store-db.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const accounts = async (): Promise<AccountsView> => {
  const r = await app('/api/accounts');
  expect(r.status).toBe(200);
  return (await r.json()) as AccountsView;
};

describe('Stored alerts on Accounts', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    const db = ownerDb();
    const budget = (await db.prepare(`SELECT id FROM budget`).first<{ id: string }>())!.id;
    const now = Date.now();
    const rows: [string, string, string, string][] = [
      ['al-amb', 'ambiguous_match', 'p:posted-1', JSON.stringify({ candidates: ['a', 'b'] })],
      ['al-vp', 'vanished_pending', 'p:pending-1', '{}'],
      ['al-re', 'possible_reissue', 'p:old-1', JSON.stringify({ added: ['p:new-1'] })],
      ['al-id', 'identity', '2026-11-14', JSON.stringify({ ok: false, difference: -1234, month: '2026-11' })],
      ['al-hist', 'history_changed', 'p:old-2', JSON.stringify({ month: '2026-10', amount: -4500 })],
    ];
    for (const [id, type, ref, data] of rows)
      await db
        .prepare(
          `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(id, budget, type, ref, data, now)
        .run();
  });

  it('lists every kind with an id, and links the ambiguous match to its transaction', async () => {
    const a = (await accounts()).alerts.filter((x) => x.id);
    expect(a.map((x) => x.kind).sort()).toEqual(
      ['ambiguous_match', 'history_changed', 'identity', 'possible_reissue', 'vanished_pending'].sort(),
    );
    expect(a.find((x) => x.kind === 'ambiguous_match')!.txnKey).toBe('p:posted-1');
    expect(a.find((x) => x.kind === 'identity')!.text).toContain('$12.34');
    expect(a.find((x) => x.kind === 'history_changed')!.text).toContain('2026-10');
  });

  it('Dismiss takes one off the list and keeps the row, marked as seen', async () => {
    const r = await app('/api/alerts/al-vp/dismiss', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(200);
    expect((await accounts()).alerts.map((x) => x.id)).not.toContain('al-vp');
    const row = await ownerDb()
      .prepare(`SELECT acked_at FROM alert WHERE id = 'al-vp'`)
      .first<{ acked_at: number | null }>();
    expect(row!.acked_at).not.toBeNull();
  });

  it('Dismiss of an unknown alert is a 404', async () => {
    const r = await app('/api/alerts/nope/dismiss', { method: 'POST', headers: H, body: '{}' });
    expect(r.status).toBe(404);
  });
});
