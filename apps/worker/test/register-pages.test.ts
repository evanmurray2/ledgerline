// An account's register reads in pages (Show older): about 300 rows each, in whole days, with the running balance
// going on across pages as in one long list. Every row is on exactly one page, and every row still waiting is on the
// first. An account whose bank was removed says so.
import { app, phoneDb } from './phone.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountsView, RegisterPage, RegisterView } from '@ledgerline/contracts';
import { REGISTER_ROWS } from '../src/routes/account-register.js';

const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };
const get = async <T>(p: string): Promise<T> => {
  const r = await app(p);
  if (!r.ok) throw new Error(`${p} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

const ADDED = 700;

describe('register pages', () => {
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
    // Every added row is in the budget (none before its start, which are walked through but not listed).
    await db.prepare(`UPDATE account SET budget_from = '2020-01-01' WHERE id = 'marcus'`).run();
    // 7 rows a day: a page's 300th row ends inside a day. One statement, for speed.
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?4)
         INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         SELECT 'pg_' || i, ?1, ?2, ?3, -(100 + i), date('2026-10-31', '-' || (i / 7) || ' days'), 0, 'Coffee', 'p:pg_' || i, 0, 0, 0, 0 FROM n`,
      )
      .bind(a.budget_id, conn.connection_id, a.provider_account_id, ADDED)
      .run();
  }, 60_000);

  it('lists every row once, in whole days, with the balance going on across pages', async () => {
    const first = await get<RegisterView>('/api/accounts/marcus/register');
    expect(first.more).toBe(true);
    expect(first.older).not.toBeNull();
    const days = [...first.days];
    let cursor = first.older ?? null;
    let pages = 1;
    while (cursor) {
      const p = await get<RegisterPage>(
        `/api/accounts/marcus/register/older?before=${cursor.before}&balance=${cursor.balance}`,
      );
      expect(p.days.length).toBeGreaterThan(0);
      // An older page holds dated days only, each older than the cursor.
      for (const d of p.days) expect(d.balance).not.toBeNull();
      expect(p.days.flatMap((d) => d.rows).every((r) => r.date < cursor!.before)).toBe(true);
      days.push(...p.days);
      cursor = p.older;
      pages++;
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    const labels = days.map((d) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
    const rows = days.flatMap((d) => d.rows);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 0; i < ADDED; i++) expect(keys).toContain(`p:pg_${i}`);
    // Each day's balance is the one after it plus that day's rows: no row is skipped or counted twice at a page edge.
    const dated = days.filter((d) => d.balance !== null);
    expect(dated[0]!.balance).toBe(first.account.bank);
    for (let i = 0; i + 1 < dated.length; i++) {
      const sum = dated[i]!.rows.reduce((a, r) => a + r.amount, 0);
      expect(dated[i + 1]!.balance, dated[i]!.label).toBe(dated[i]!.balance! - sum);
    }
  });

  it('pages hold about REGISTER_ROWS rows each', async () => {
    const first = await get<RegisterView>('/api/accounts/marcus/register');
    const posted = first.days.filter((d) => d.balance !== null).flatMap((d) => d.rows);
    expect(posted.length).toBeGreaterThanOrEqual(REGISTER_ROWS);
    expect(posted.length).toBeLessThan(REGISTER_ROWS + 7);
  });

  it('every row still waiting is on the first page', async () => {
    const first = await get<RegisterView>('/api/accounts/marcus/register');
    const waiting = first.days.filter((d) => d.balance === null).flatMap((d) => d.rows);
    const db = phoneDb();
    const n = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM v_transaction WHERE account_id = 'marcus' AND status <> 'posted'
           AND NOT (status = 'pending' AND source = 'bank' AND EXISTS (SELECT 1 FROM manual_pending cv
             WHERE cv.covers_provider_txn_id = v_transaction.provider_txn_id AND cv.deleted_at IS NULL AND cv.matched_txn_key IS NULL))`,
      )
      .first<{ n: number }>();
    expect(waiting.length).toBe(n!.n);
  });

  it('refuses a cursor it didn’t give', async () => {
    for (const q of [
      'before=2026-13-01&balance=0',
      'before=2026-10-01&balance=',
      'before=2026-10-01&balance=1.5',
    ])
      expect((await app(`/api/accounts/marcus/register/older?${q}`)).status).toBe(400);
    expect((await app('/api/accounts/nope/register/older?before=2026-10-01&balance=0')).status).toBe(404);
  });

  it('an account whose bank was removed is marked unlinked', async () => {
    const db = phoneDb();
    const pa = (await db
      .prepare(
        `SELECT pa.connection_id FROM account a JOIN provider_account pa ON pa.provider_account_id = a.provider_account_id WHERE a.id = 'marcus'`,
      )
      .first<{ connection_id: string }>())!;
    expect((await get<RegisterView>('/api/accounts/marcus/register')).account.unlinked).toBe(false);
    await db.prepare(`UPDATE connection SET removed_at = 1 WHERE id = ?1`).bind(pa.connection_id).run();
    const v = await get<RegisterView>('/api/accounts/marcus/register');
    expect(v.account.unlinked).toBe(true);
    expect(v.account.meta).toMatch(/not linked$/);
    const all = await get<AccountsView>('/api/accounts');
    const row = [...all.groups.flatMap((g) => g.accounts), ...all.closed].find((a) => a.id === 'marcus');
    expect(row?.unlinked).toBe(true);
  });
});
