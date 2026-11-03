// The daily scan, run by each budget's daily_scan job (store/budget-jobs.ts).
import type { Stmt } from '@ledgerline/db/sql';
import { localDate, type Month } from '@ledgerline/domain';
import type { Env } from './env.js';
import { Scoped } from './db/scoped.js';
import { budgetMeta } from './ledger/ledger.js';
import { ulid } from '@ledgerline/platform';
import { bumpVersion } from './http/etag.js';

/** Upcoming entries count from their date; repeating ones schedule their next occurrence. Vanished pending rows get an alert. */
export async function dailyScan(env: Env, budgetId: string, now: number): Promise<{ materialized: number }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const meta = await budgetMeta(s);
  if (!meta) return { materialized: 0 };
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
    const key = `m:${ulid(now)}`;
    w.push(
      s.q(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'upcoming', ?5, ?6, ?7, ?8, ?9, ?9)`,
        ulid(now),
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
