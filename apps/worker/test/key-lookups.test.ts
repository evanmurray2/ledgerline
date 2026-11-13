// Every row of a budget's store has the same budget_id, so an index that starts with budget_id matches all of them.
// Without table statistics SQLite takes such an index for a selective one and, for "budget_id = ? AND key IN (…)",
// reads every bank row instead of looking up the keys (Nov 9, 2026: about 3,000 rows read for 25 keys, several times a
// processing step). The hot lookups write +budget_id so the key's index is used; this test fails if one goes back.
// Filing runs on the device now (D-102); a Durable Object's SQLite with the budget's schema stands in for the
// device's here (test/store-db.ts budgetDb).
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedNovember } from '../src/dev-seed.js';
import type { DurableDb } from '../src/store/adapter.js';
import { Scoped } from '../src/db/scoped.js';
import { loadBankRows } from '../src/sync/bank-rows.js';
import { budgetDb, copyStub } from './store-db.js';

const NAME = 'key-lookups';
const db = budgetDb(NAME);
const budgetId = 'b_key_lookups';

describe('key lookups in a store', () => {
  it('read the keys asked for, not every bank row', async () => {
    // November goes in as a copy holds it.
    await seedNovember(db, budgetId, 'owner', Date.now());
    // About 2,000 more bank rows, as after a few months of syncs.
    const cols = (await db.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    for (let i = 1; i <= 30; i++) {
      const sel = cols
        .map((c) =>
          c === 'txn_key'
            ? `txn_key || '-h${i}'`
            : c === 'provider_txn_id'
              ? `provider_txn_id || '-h${i}'`
              : c,
        )
        .join(', ');
      await db
        .prepare(
          `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
        )
        .run();
    }
    const total = (await db.prepare(`SELECT count(*) AS n FROM bank_txn`).first<{ n: number }>())!.n;
    expect(total).toBeGreaterThan(1500);
    const ids = (
      await db.prepare(`SELECT provider_txn_id FROM bank_txn ORDER BY provider_txn_id LIMIT 25`).all<{
        provider_txn_id: string;
      }>()
    ).results.map((r) => r.provider_txn_id);

    const { rows, read } = await runInDurableObject(copyStub(NAME), async (o) => {
      const d = (o as unknown as { db: DurableDb }).db;
      const before = d.stats.rowsRead;
      const rows = await loadBankRows(new Scoped(d, budgetId, 'system'), ids);
      return { rows: rows.length, read: d.stats.rowsRead - before };
    });
    expect(rows).toBe(25);
    // The 25 rows and their account and connection, not the whole table.
    expect(read).toBeLessThan(200);
  });
});
