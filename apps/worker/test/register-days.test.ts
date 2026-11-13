// An account's register lists its days by date: two days a year apart get their own labels (and keys on screen).
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RegisterView } from '@ledgerline/contracts';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };

describe('register days', () => {
  beforeAll(async () => {
    expect((await app('/__dev/seed-november', { method: 'POST', headers: H, body: '{}' })).status).toBe(200);
    const db = phoneDb();
    const a = (await db
      .prepare(`SELECT budget_id, provider_account_id FROM account WHERE id = 'marcus'`)
      .first<{ budget_id: string; provider_account_id: string }>())!;
    const conn = (await db
      .prepare(`SELECT connection_id FROM provider_account WHERE provider_account_id = ?1`)
      .bind(a.provider_account_id)
      .first<{ connection_id: string }>())!;
    // The account's budget began a year earlier, so last November's row is listed too.
    await db.prepare(`UPDATE account SET budget_from = '2025-10-01' WHERE id = 'marcus'`).run();
    for (const [id, date] of [
      ['yr_2025', '2025-11-12'],
      ['yr_2026', '2026-11-12'],
    ])
      await db
        .prepare(
          `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, -500, ?5, 0, 'Coffee', ?6, 0, 0, 0, 0)`,
        )
        .bind(id, a.budget_id, conn.connection_id, a.provider_account_id, date, `p:${id}`)
        .run();
  });

  it('labels a day from another year with its year', async () => {
    const r = await app('/api/accounts/marcus/register');
    expect(r.status).toBe(200);
    const v = (await r.json()) as RegisterView;
    const labels = v.days.map((d) => d.label);
    expect(labels).toContain('Nov 12');
    expect(labels).toContain('Nov 12, 2025');
    expect(new Set(labels).size).toBe(labels.length);
  });
});
