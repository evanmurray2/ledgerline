// The bank difference (D-66) and pending the bank already counts (D-68). The bank's balance comes from one Plaid feed
// and the rows from another, so the balance can move before a row arrives. Amounts here are signed balances (cards
// negative when owed), as the ledger keeps them.
import type { Scoped } from '../db/scoped.js';
import { type Month, addMonths } from '@ledgerline/domain';
import { RECENT_TX } from './ledger.js';
import { inBudgetByAccount, monthTotals } from './totals.js';
import { type Adjustments, adjustments } from './start-part.js';

/** A difference shows only once it has lasted this long: most are timing and clear when the row arrives. */
export const DIFF_WAIT_MS = 24 * 60 * 60 * 1000;

export interface BankDiff {
  /** Part of the pending total the bank balance already counts (signed like pending; 0 when none). */
  inBank: number;
  /** What pending can't explain: bank minus posted rows minus inBank (signed). */
  left: number;
}

/**
 * `bank` and `posted` are signed balances, `pending` the signed pending total the app counts. When the bank is lower
 * than the posted rows and pending is negative (or both higher and positive), the bank has taken in up to that much
 * of the pending already: counting it again would show it twice.
 */
export function bankDiff(bank: number, posted: number, pending: number): BankDiff {
  const d = bank - posted;
  const same = (d < 0 && pending < 0) || (d > 0 && pending > 0);
  const inBank = same ? Math.sign(d) * Math.min(Math.abs(d), Math.abs(pending)) : 0;
  return { inBank, left: d - inBank };
}

export interface AcctLedgerIn {
  id: string;
  budget_from: string;
  starting_balance: number;
}

export interface AcctLedger {
  /** Starting balance plus posted rows the budget counts, per account (signed). */
  posted: Map<string, number>;
  /** Pending and due upcoming rows the app counts, per account (signed; won't-clear left out). */
  pending: Map<string, number>;
  startAdjust: Adjustments;
}

/** Posted rows the budget counts, per account, from `from` on (the rows ledger/totals.ts adds up, in one read). */
async function directSums(s: Scoped, from: Month): Promise<Map<string, number>> {
  const rows = await s.all<{ account_id: string; b: number }>(
    `SELECT account_id, sum(CASE WHEN date >= budget_from OR pending_at_link = 1 THEN amount ELSE 0 END) AS b
     FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted' AND date >= ?2 || '-01' GROUP BY account_id`,
    from,
  );
  return new Map(rows.map((r) => [r.account_id, r.b]));
}

/**
 * What the app counts for each account, to compare with the bank. Posted rows from two months before the earliest
 * budget start, for rows pending at link.
 */
export async function accountLedger(
  s: Scoped,
  accounts: AcctLedgerIn[],
  today: string,
  now: number,
  /** The server has no stored month totals (migration 0006): add up the posted rows directly. */
  direct = false,
): Promise<AcctLedger> {
  const pend = await s.all<{ account_id: string; p: number }>(
    `SELECT account_id, sum(amount) AS p FROM ${RECENT_TX} WHERE budget_id = ?1 AND status IN ('pending', 'upcoming') AND wont_clear = 0
       AND (status != 'upcoming' OR date <= ?2) GROUP BY account_id`,
    today,
  );
  const pending = new Map(pend.map((r) => [r.account_id, r.p]));
  const earliest = accounts.reduce((m, a) => (a.budget_from < m ? a.budget_from : m), today);
  const from = addMonths(earliest.slice(0, 7) as Month, -2);
  const postedSum = direct
    ? await directSums(s, from)
    : // Stored totals for finished months plus the current month live (ledger/totals.ts), on the phone.
      inBudgetByAccount(await monthTotals(s, from, today.slice(0, 7) as Month, now));
  // Late rows from before the start and link-day rows (ledger/start-part.ts, D-67): the stored sums leave them out.
  const startAdjust = await adjustments(s, now);
  const posted = new Map(
    accounts.map((a) => [
      a.id,
      a.starting_balance + (startAdjust.sum.get(a.id) ?? 0) + (postedSum.get(a.id) ?? 0),
    ]),
  );
  return { posted, pending, startAdjust };
}
