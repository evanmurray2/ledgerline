// Rows that move an account's starting balance (packages/domain/src/budget/start.ts, D-?): which ones, for the bank
// difference and rule 10's working balance (adjustments), the notes on Accounts, and the account's Starting balance
// sheet (startSheet). The budget lines get each row's role in loadTxns (ledger.ts).
import type { StartBalance } from '@ledgerline/contracts';
import { type IsoDate, SETTLE_DAYS, cameInLater, cents, localDate, settlesAt } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { TX_COLUMNS, uncovered, type TxRow } from './ledger.js';
import { linkInfo, roleOf } from './link.js';

/** A late row is noted on Accounts and the account page for this long after it came in. */
const NOTE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Candidate rows for the adjustments that the stored sums don't already hold: posted rows not pending at link,
 * dated from SETTLE_DAYS before an account's budget start to a few days after it (a link-day row, with the bank's
 * date a day off), posted from SETTLE_DAYS before the earliest start to well after the latest (bank_txn_budget_date).
 */
const CANDIDATES = `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted' AND pending_at_link = 0 AND wont_clear = 0
  AND posted_date >= date((SELECT min(budget_from) FROM account WHERE budget_id = ?1), '-${SETTLE_DAYS} days')
  AND posted_date <= date((SELECT max(budget_from) FROM account WHERE budget_id = ?1), '+45 days')
  AND date >= date(budget_from, '-${SETTLE_DAYS} days') AND date <= date(budget_from, '+3 days') AND ${uncovered('v_txn_bank')}`;

/** Bank rows pending now and dated before their account's budget start (bank_txn_pending). */
const PENDING_BEFORE = `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND bank_pending = 1 AND wont_clear = 0
  AND date < budget_from AND ${uncovered('v_txn_bank')}`;

export interface Recent {
  payee: string;
  date: IsoDate;
  amount: number;
  at: number;
}

export interface Adjustments {
  /**
   * Per account, what posted rows add to the starting balance beyond the stored sums. Those sums (ledger/totals.ts,
   * maintenance.ts) count rows dated from the budget start or pending at link, so this adds the late rows from
   * before the start that weren't pending at link and takes out the link-day rows already in the stored starting
   * balance.
   */
  sum: Map<string, number>;
  /** Per account, the latest row from before the start that came in after the link, in the last 7 days. */
  recent: Map<string, Recent>;
}

export async function adjustments(s: Scoped, now: number): Promise<Adjustments> {
  const [links, [cand, pend]] = await Promise.all([
    linkInfo(s),
    s.batch([s.q(CANDIDATES), s.q(PENDING_BEFORE)]),
  ]);
  const sum = new Map<string, number>();
  const recent = new Map<string, Recent>();
  const note = (t: TxRow) => {
    if (t.seq < now - NOTE_MS || !cameInLater(t.seq, links.get(t.account_id) ?? null)) return;
    const was = recent.get(t.account_id);
    if (!was || t.seq > was.at)
      recent.set(t.account_id, { payee: t.payee, date: t.date, amount: t.amount, at: t.seq });
  };
  for (const t of cand!.results as TxRow[]) {
    const role = roleOf(t, links);
    if (!role) continue;
    sum.set(t.account_id, (sum.get(t.account_id) ?? 0) + (role === 'before' ? t.amount : -t.amount));
    if (role === 'before') note(t);
  }
  for (const t of pend!.results as TxRow[]) if (roleOf(t, links) === 'before') note(t);
  return { sum, recent };
}

/** One account's Starting balance sheet: how the bank's balance at link became the starting balance. */
export async function startSheet(
  s: Scoped,
  account: { id: string; budget_from: string; starting_balance: number },
  recent: Recent | null,
  now: number,
  timeZone: string,
): Promise<StartBalance | null> {
  const [links, rows] = await Promise.all([
    linkInfo(s),
    s.all<TxRow>(
      `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND account_id = ?2 AND wont_clear = 0 AND ${uncovered('v_txn_bank')}
         AND (pending_at_link = 1 OR bank_pending = 1 OR (date >= date(budget_from, '-${SETTLE_DAYS} days') AND date <= date(budget_from, '+3 days')))
       ORDER BY date, seq`,
      account.id,
    ),
  ]);
  const link = links.get(account.id) ?? null;
  if (!link) return null;
  const out: StartBalance['rows'] = [];
  let total = account.starting_balance;
  for (const t of rows) {
    const role = roleOf(t, links);
    if (!role || t.status === 'upcoming') continue;
    out.push({
      key: t.key,
      payee: t.payee,
      date: t.date,
      amount: cents(t.amount),
      pending: t.status === 'pending',
      role,
    });
    total += role === 'before' ? t.amount : -t.amount;
  }
  return {
    from: account.budget_from,
    atLink: cents(account.starting_balance),
    rows: out,
    total: cents(total),
    settlesOn: localDate(settlesAt(link), timeZone),
    settling: now <= settlesAt(link),
    recent: recent ? { payee: recent.payee, date: recent.date, amount: cents(recent.amount) } : null,
  };
}
