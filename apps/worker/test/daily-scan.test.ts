// The daily scan writes its planned time (5:00 in the budget's time zone), and names what it makes from content,
// so the same day's scan gives the same rows whenever and wherever it runs (docs/privacy.md 5.4).
import type { Db } from '@ledgerline/db/sql';
import { describe, expect, it } from 'vitest';
import { dailyScan, scanTime } from '../src/daily-scan.js';
import { storeDb } from './store-db.js';

const LA = 'America/Los_Angeles';
const at = (iso: string) => Date.parse(iso);

async function seed(name: string): Promise<Db> {
  const db = storeDb(name);
  await db.batch([
    db.prepare(
      `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES ('b1', 'B', '2026-10', '${LA}', 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO account (id, budget_id, name, kind, budget_from, created_at, updated_at) VALUES ('a1', 'b1', 'Checking', 'checking', '2026-10-01', 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO category (id, budget_id, name, kind, created_at, updated_at) VALUES ('rent', 'b1', 'Rent', 'spending', 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
       VALUES ('m1', 'b1', 'm:rent', 'a1', 'upcoming', '2026-11-10', -150000, 'Landlord', 'monthly', 1, 1)`,
    ),
    db.prepare(
      `INSERT INTO txn_overlay (txn_key, budget_id, category_id, categorized_by, created_at, updated_at) VALUES ('m:rent', 'b1', 'rent', 'user', 1, 1)`,
    ),
  ]);
  return db;
}
const made = async (db: Db) =>
  (
    await db
      .prepare(
        `SELECT id, txn_key, date, amount, repeats, created_at, updated_at FROM manual_pending WHERE id != 'm1' ORDER BY id`,
      )
      .all()
  ).results;

describe('the daily scan', () => {
  it('belongs to the last 5:00 in the budget’s time zone, also on the days the clock changes', () => {
    // Nov 10, 2026 in Los Angeles is UTC-8: 5:00 is 13:00 UTC.
    expect(scanTime(at('2026-11-10T13:00:00Z'), LA)).toBe(at('2026-11-10T13:00:00Z'));
    expect(scanTime(at('2026-11-10T13:00:07Z'), LA)).toBe(at('2026-11-10T13:00:00Z'));
    expect(scanTime(at('2026-11-10T12:59:59Z'), LA)).toBe(at('2026-11-09T13:00:00Z'));
    expect(scanTime(at('2026-11-11T07:00:00Z'), LA)).toBe(at('2026-11-10T13:00:00Z'));
    // Mar 8, 2026: clocks go forward (a 23-hour day); 5:00 is 12:00 UTC from then on.
    expect(scanTime(at('2026-03-08T12:00:30Z'), LA)).toBe(at('2026-03-08T12:00:00Z'));
    expect(scanTime(at('2026-03-08T11:59:00Z'), LA)).toBe(at('2026-03-07T13:00:00Z'));
    // Nov 1, 2026: clocks go back (a 25-hour day).
    expect(scanTime(at('2026-11-01T13:00:30Z'), LA)).toBe(at('2026-11-01T13:00:00Z'));
    expect(scanTime(at('2026-11-01T12:30:00Z'), LA)).toBe(at('2026-10-31T12:00:00Z'));
  });

  it('gives the same rows whenever it runs that day, on any copy', async () => {
    const a = await seed('daily-scan-a');
    const b = await seed('daily-scan-b');
    // The server's job runs seconds after 5:00; a device opens at noon.
    expect(await dailyScan({ DB: a } as never, 'b1', at('2026-11-10T13:00:04Z'))).toEqual({
      materialized: 1,
    });
    expect(await dailyScan({ DB: b } as never, 'b1', at('2026-11-10T20:00:00Z'))).toEqual({
      materialized: 1,
    });
    const rows = await made(a);
    expect(rows).toEqual(await made(b));
    expect(rows).toEqual([
      expect.objectContaining({
        date: '2026-12-10',
        amount: -150000,
        repeats: 'monthly',
        created_at: at('2026-11-10T13:00:00Z'),
        updated_at: at('2026-11-10T13:00:00Z'),
      }),
    ]);
    // The next occurrence keeps the category, and the entry it came from repeats no more.
    const key = (rows[0] as { txn_key: string }).txn_key;
    const overlay = await a
      .prepare(`SELECT category_id FROM txn_overlay WHERE txn_key = ?1`)
      .bind(key)
      .first<{ category_id: string }>();
    expect(overlay!.category_id).toBe('rent');
    // A second run the same day makes nothing more.
    expect(await dailyScan({ DB: a } as never, 'b1', at('2026-11-10T21:00:00Z'))).toEqual({
      materialized: 0,
    });
    expect((await made(a)).length).toBe(1);
  });
});
