// Activity search without case or accents: "café" and "cafe" find "CAFÉ", on posted rows (SQL) as on pending
// rows (read in full and matched in JavaScript), and a category's name the same way.
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ActivityView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

/** A bank row in checking, posted or pending. */
async function bankRow(id: string, date: string, amount: number, name: string, pending: 0 | 1) {
  const db = phoneDb();
  const a = (await db
    .prepare(
      `SELECT a.budget_id, a.provider_account_id, pa.connection_id FROM account a
       JOIN provider_account pa ON pa.provider_account_id = a.provider_account_id WHERE a.id = 'checking'`,
    )
    .first<{ budget_id: string; provider_account_id: string; connection_id: string }>())!;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?1, 0, 0, ?9, ?9)`,
    )
    .bind(id, a.budget_id, a.connection_id, a.provider_account_id, amount, date, pending, name, now)
    .run();
}

const keys = async (q: string) => {
  const v = await get<ActivityView>(`/api/activity?q=${encodeURIComponent(q)}`);
  return { posted: v.posted.map((r) => r.key), pending: v.pending.map((r) => r.key) };
};

describe('Activity search folds case and accents', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    await bankRow('cafe-posted', '2026-11-10', -450, 'CAFÉ LUMIÈRE', 0);
    await bankRow('cafe-pending', '2026-11-13', -380, 'CAFÉ LUMIÈRE', 1);
  });

  it('finds CAFÉ by café, cafe, CAFE and Lumiere', async () => {
    for (const q of ['café', 'cafe', 'CAFE', 'Café Lumière', 'lumiere']) {
      const k = await keys(q);
      expect(k.posted, q).toContain('cafe-posted');
      expect(k.pending, q).toContain('cafe-pending');
    }
  });

  it('finds a category by its name without accents', async () => {
    const db = phoneDb();
    await db.prepare(`UPDATE category SET name = 'Café & dining' WHERE id = 'dining'`).run();
    const v = await get<ActivityView>('/api/activity?q=cafe%20%26%20dining');
    expect([...v.posted, ...v.pending].length).toBeGreaterThan(0);
  });
});
