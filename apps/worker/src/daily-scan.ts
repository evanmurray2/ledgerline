// The daily scan, run by each budget's daily_scan job (store/budget-jobs.ts).
import type { Stmt } from '@ledgerline/db/sql';
import { localDate, nextLocalTime, type Month } from '@ledgerline/domain';
import type { Env } from './env.js';
import { Scoped } from './db/scoped.js';
import { budgetMeta } from './ledger/ledger.js';
import { seededUlid } from '@ledgerline/platform';
import { bumpVersion } from './http/version.js';

/** The hour of the daily scan, in the budget's time zone. */
export const SCAN_HOUR = 5;

/**
 * The time of the scan that `clock` belongs to: the last 5:00 in the budget's time zone at or before it. A scan
 * writes this time, not the moment its job happened to run, so that a device that runs the same day's scan
 * writes the same rows (docs/privacy.md 5.4: "a scan uses 5:00 on its day").
 */
export function scanTime(clock: number, timeZone: string): number {
  // The newest 5:00 that is not after `clock`. Stepping from two days back is right on a 23- or 25-hour day too.
  let t = nextLocalTime(clock - 2 * 86_400_000, timeZone, SCAN_HOUR, 0);
  for (let i = 0; i < 4; i++) {
    const next = nextLocalTime(t, timeZone, SCAN_HOUR, 0);
    if (next > clock) break;
    t = next;
  }
  return t;
}

/** Upcoming entries count from their date; repeating ones schedule their next occurrence. Vanished pending rows get an alert. */
export async function dailyScan(
  env: Env,
  budgetId: string,
  clock: number,
): Promise<{ materialized: number }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const meta = await budgetMeta(s);
  if (!meta) return { materialized: 0 };
  const now = scanTime(clock, meta.timeZone);
  const today = localDate(now, meta.timeZone);
  const due = await s.all<{
    txn_key: string;
    repeats: string;
    date: string;
    account_id: string;
    amount: number;
    payee_name: string;
  }>(
    `SELECT m.txn_key, m.repeats, m.date, m.account_id, m.amount, m.payee_name FROM manual_pending m
     WHERE m.budget_id = ?1 AND m.kind = 'upcoming' AND m.deleted_at IS NULL AND m.date <= ?2
       -- Only repeating rows need their next occurrence scheduled (scheduling sets repeats to 'never'). Their lines
       -- are worked out on the phone (D-45).
       AND m.repeats != 'never' LIMIT 40`,
    today,
  );
  const w: Stmt[] = [];
  for (const d of due) {
    if (d.repeats === 'never') continue;
    const [y, mo, dd] = d.date.split('-').map(Number) as [number, number, number];
    const next =
      d.repeats === 'monthly'
        ? new Date(Date.UTC(y, mo, Math.min(dd, 28)))
        : new Date(Date.UTC(y + 1, mo - 1, dd));
    // Named from the entry it repeats and the scan's time, never at random (docs/privacy.md 5.3: ids are an input).
    const key = `m:${seededUlid(now, `repeat:${d.txn_key}`, 1)}`;
    w.push(
      s.q(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'upcoming', ?5, ?6, ?7, ?8, ?9, ?9)`,
        seededUlid(now, `repeat:${d.txn_key}`, 0),
        key,
        d.account_id,
        next.toISOString().slice(0, 10),
        d.amount,
        d.payee_name,
        d.repeats,
        now,
      ),
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, category_id, categorized_by, created_at, updated_at)
         SELECT ?2, budget_id, category_id, categorized_by, ?3, ?3 FROM txn_overlay WHERE budget_id = ?1 AND txn_key = ?4`,
        key,
        now,
        d.txn_key,
      ),
      s.q(`UPDATE manual_pending SET repeats = 'never' WHERE budget_id = ?1 AND txn_key = ?2`, d.txn_key),
    );
  }
  // Bank pending rows removed with no posted successor after 5 days: usually a released hold.
  w.push(
    s.q(
      `INSERT OR IGNORE INTO alert (id, budget_id, type, ref_key, data, created_at)
       SELECT 'vp:' || o.txn_key, o.budget_id, 'vanished_pending', o.txn_key, '{}', ?2 FROM txn_overlay o
       WHERE o.budget_id = ?1 AND o.orphaned_at IS NOT NULL AND o.orphaned_at < ?2 - 5 * 86400000
         AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.txn_key = o.txn_key AND b.removed_at IS NULL)`,
      now,
    ),
  );
  if (w.length) await s.batch(w);
  await bumpVersion(env.DB, budgetId);
  return { materialized: due.length };
}

export type { Month };
