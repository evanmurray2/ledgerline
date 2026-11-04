// Rows read per request in the budget's Durable Object. The free plan allows 5 million rows read a day and every
// request costs reads, so this test fails if a request grows past its budget. The data is shaped like a real first month: the November budget
// plus about 600 transactions of history before it, and two months of daily card statement snapshots.
import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { DurableDb } from '../src/store/adapter.js';
import { budgetStub, directoryStub, ownerDb } from './store-db.js';
import { app } from './phone.js';

const db = ownerDb();

/** Rows the budget's store has read so far: its DurableDb counts every statement (store/adapter.ts). */
const storeReads = async () => {
  const id = await directoryStub().firstBudget();
  if (!id) return 0;
  return runInDurableObject(
    budgetStub(id),
    async (o) => (o as unknown as { db: DurableDb }).db.stats.rowsRead,
  );
};

const call = async (p: string, method = 'GET', body: unknown = {}) => {
  const before = await storeReads();
  const r = await worker.fetch(
    new Request('https://ledgerline.test' + p, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ledgerline': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }),
    env as never,
    createExecutionContext(),
  );
  await r.text();
  return { p, status: r.status, reads: (await storeReads()) - before };
};

/** Copies of the seeded bank rows, dated 1–10 periods of 18 days before the budget start: history. */
async function addHistory() {
  const cols = (await db.prepare(`PRAGMA table_info(bank_txn)`).all<{ name: string }>()).results.map(
    (c) => c.name,
  );
  for (let i = 1; i <= 10; i++) {
    const sel = cols
      .map((c) =>
        c === 'txn_key'
          ? `txn_key || '-h${i}'`
          : c === 'provider_txn_id'
            ? `provider_txn_id || '-h${i}'`
            : c === 'date' || c === 'authorized_date'
              ? `date('2026-11-01', '-${i * 18} days')`
              : c === 'pending'
                ? '0'
                : c,
      )
      .join(', ');
    await db
      .prepare(
        `INSERT INTO bank_txn (${cols.join(', ')}) SELECT ${sel} FROM bank_txn WHERE txn_key NOT LIKE '%-h%'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, created_at, updated_at)
       SELECT txn_key || '-h${i}', budget_id, payee_id, NULL, created_at, updated_at FROM txn_overlay
       WHERE txn_key NOT LIKE '%-h%' AND txn_key IN (SELECT txn_key FROM bank_txn)`,
      )
      .run();
  }
  // Two months of daily statement snapshots per card (one sync a day kept).
  for (let d = 1; d <= 60; d++)
    await db
      .prepare(
        `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, due_date, data, created_at)
       SELECT 'ls-' || provider_account_id || '-${d}', budget_id, provider_account_id, date('2026-11-14', '-${d} days'), 10000, '2026-12-01', '{}', ${d}
       FROM account WHERE kind = 'credit' AND provider_account_id IS NOT NULL`,
      )
      .run();
}

/** What the server still answers (D-45): the session, sync pages and changes. Screens are read on the phone. */
describe('database reads per request', () => {
  it('stay within budget with six months of history', async () => {
    await call('/__dev/seed-november', 'POST');
    await addHistory();
    const n = await db.prepare(`SELECT count(*) AS b FROM bank_txn`).first<{ b: number }>();
    expect(n!.b).toBeGreaterThan(550);

    const out = [await call('/api/session'), await call('/api/sync?since=0&limit=200')];
    const t = await db
      .prepare(
        `SELECT key FROM v_transaction WHERE category_id IS NULL AND date >= budget_from AND status = 'posted' LIMIT 1`,
      )
      .first<{ key: string }>();
    const cat = await db
      .prepare(`SELECT id, name, group_id FROM category WHERE kind = 'spending' LIMIT 1`)
      .first<{ id: string; name: string; group_id: string }>();
    out.push(await call('/api/transactions/categorize', 'POST', { keys: [t!.key], categoryId: cat!.id }));
    out.push(
      await call('/api/budget/assign', 'POST', {
        month: '2026-11',
        items: [{ categoryId: cat!.id, amount: 1000 }],
      }),
    );
    const reads = Object.fromEntries(out.map((o) => [o.p, o.reads]));
    for (const o of out) expect(o.status, o.p).toBe(200);

    // The Activity list reads in date windows; paging through it on the phone still returns every posted row the
    // budget counts once, in order (rows before an account's budget start aren't listed, D-?).
    const all = (
      await db
        .prepare(
          `SELECT key FROM v_transaction WHERE status = 'posted' AND (date >= budget_from OR pending_at_link = 1)
           ORDER BY date DESC, seq DESC`,
        )
        .all<{ key: string }>()
    ).results.map((r) => r.key);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const res = await app(`/api/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const v = (await res.json()) as { posted: { key: string }[]; nextCursor: string | null };
      seen.push(...v.posted.map((r) => r.key));
      cursor = v.nextCursor;
      if (!cursor || v.posted.length < 50) break;
    }
    expect(seen).toEqual(all);

    const report = () => JSON.stringify(reads, null, 1);
    expect(reads['/api/session'], report()).toBeLessThan(100);
    // A sync page reads the rows it sends (200) and their change-log entries.
    expect(reads['/api/sync?since=0&limit=200'], report()).toBeLessThan(1_500);
    // Edits.
    expect(reads['/api/transactions/categorize'], report()).toBeLessThan(500);
    expect(reads['/api/budget/assign'], report()).toBeLessThan(500);
  });
});
