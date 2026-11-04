// Posted totals per account per month (migration 0008). Finished months are computed once and reused until a write
// that could change them clears them; the current month is always added up live. Totals are grouped by the
// transaction's date (`v_txn_bank.date`: the authorized date for card purchases), as the screens were.
//
// What clears stored months (month_total_done):
// - the sync's apply step: the months of every row it touches, before and after (sync/steps.ts)
// - processing: from the earliest month it touched (sync/process.ts), since it can re-key a row onto a
//   pending-at-link overlay
// - CSV history import and re-pointing an account (routes/ops.ts): the phone's copy, when the rows arrive
import type { Stmt } from '@ledgerline/db/sql';
import { type Month, addMonths } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';

export interface AccountTotals {
  /** Every posted row (Reports). */
  all: number;
  /** Rows the budget counts: dated from the account's budget start, or pending at link (Accounts). */
  inBudget: number;
}

/** Card holds post within days; a row's posted date is read at most this long after its date's month. */
const POST_LAG = '+4 months';

const SUMS = `sum(amount) AS a, sum(CASE WHEN date >= budget_from OR pending_at_link = 1 THEN amount ELSE 0 END) AS b`;

/** Clears stored totals for this budget from `from` on (or all of them). */
export function clearTotals(s: Scoped, from: string | null = null): Stmt {
  return from
    ? s.q(`DELETE FROM month_total_done WHERE budget_id = ?1 AND month >= ?2`, from.slice(0, 7))
    : s.q(`DELETE FROM month_total_done WHERE budget_id = ?1`);
}

/**
 * Totals per account for each month from `first` through the month before `current` (stored), plus `current`
 * (live). Returns month → account id → totals.
 */
export async function monthTotals(
  s: Scoped,
  first: Month,
  current: Month,
  now: number,
): Promise<Map<string, Map<string, AccountTotals>>> {
  const closed: Month[] = [];
  for (let m = first; m < current; m = addMonths(m, 1)) closed.push(m);
  const out = new Map<string, Map<string, AccountTotals>>();
  const put = (month: string, account: string, t: AccountTotals) => {
    if (!out.has(month)) out.set(month, new Map());
    out.get(month)!.set(account, t);
  };

  const [done, stored, live, stamp] = await s.batch([
    s.q(
      `SELECT month FROM month_total_done WHERE budget_id = ?1 AND month >= ?2 AND month < ?3`,
      first,
      current,
    ),
    s.q(
      `SELECT t.month, t.account_id, t.posted_all, t.posted_in_budget FROM account_month_total t
       JOIN month_total_done d ON d.budget_id = t.budget_id AND d.month = t.month
       WHERE t.budget_id = ?1 AND t.month >= ?2 AND t.month < ?3`,
      first,
      current,
    ),
    s.q(
      `SELECT account_id, ${SUMS} FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted'
         AND posted_date >= ?2 || '-01' AND date >= ?2 || '-01' GROUP BY account_id`,
      current,
    ),
    // What the stored months depend on, read before computing: a change in between leaves them unmarked.
    s.q(
      `SELECT (SELECT seq FROM apply_counter WHERE id = 1) AS applied, processed_through, data_version FROM budget WHERE id = ?1`,
    ),
  ]);
  for (const r of stored!.results as {
    month: string;
    account_id: string;
    posted_all: number;
    posted_in_budget: number;
  }[])
    put(r.month, r.account_id, { all: r.posted_all, inBudget: r.posted_in_budget });
  for (const r of live!.results as { account_id: string; a: number; b: number }[])
    put(current, r.account_id, { all: r.a, inBudget: r.b });

  const have = new Set((done!.results as { month: string }[]).map((r) => r.month));
  const missing = closed.filter((m) => !have.has(m));
  if (missing.length === 0) return out;

  const computed = await s.batch(
    missing.map((m) =>
      s.q(
        `SELECT account_id, ${SUMS} FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted'
           AND posted_date >= ?2 || '-01' AND posted_date < date(?2 || '-01', '${POST_LAG}') AND substr(date, 1, 7) = ?2
         GROUP BY account_id`,
        m,
      ),
    ),
  );
  const st = stamp!.results[0] as { applied: number; processed_through: number; data_version: number };
  const writes: Stmt[] = [];
  missing.forEach((m, i) => {
    const rows = computed[i]!.results as { account_id: string; a: number; b: number }[];
    writes.push(s.q(`DELETE FROM account_month_total WHERE budget_id = ?1 AND month = ?2`, m));
    for (const r of rows) {
      put(m, r.account_id, { all: r.a, inBudget: r.b });
      writes.push(
        s.q(
          `INSERT INTO account_month_total (budget_id, account_id, month, posted_all, posted_in_budget) VALUES (?1, ?2, ?3, ?4, ?5)`,
          r.account_id,
          m,
          r.a,
          r.b,
        ),
      );
    }
    writes.push(
      s.q(
        `INSERT OR REPLACE INTO month_total_done (budget_id, month, computed_at)
         SELECT ?1, ?2, ?3 WHERE (SELECT seq FROM apply_counter WHERE id = 1) = ?4
           AND (SELECT processed_through FROM budget WHERE id = ?1) = ?5 AND (SELECT data_version FROM budget WHERE id = ?1) = ?6`,
        m,
        now,
        st.applied,
        st.processed_through,
        st.data_version,
      ),
    );
  });
  await s.batch(writes);
  return out;
}

/** Sum of in-budget posted totals per account across all months returned. */
export function inBudgetByAccount(t: Map<string, Map<string, AccountTotals>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of t.values()) for (const [a, v] of m) out.set(a, (out.get(a) ?? 0) + v.inBudget);
  return out;
}
