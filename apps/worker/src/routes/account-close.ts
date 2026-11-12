// Close an account, and open it again (D-73, D-93). Close runs only at $0: a working balance of $0, no pending row
// from the bank, nothing upcoming and, for a card, a payment category with $0 available. So no money moves: the
// account and a card's payment category leave the screens, and every past row stays counted. A new row from the bank,
// or an entry you add, opens the account again (`reopenStmts`, called by the sync's apply step and by Add).
//
// A bank that closed the account sends nothing more, so a pending row there (the bank's own, or an entry of yours
// such as a transfer's other side, D-83) would never post and the bank's last balance would never change. Close
// therefore takes pending rows as they are (D-93): they stay, count as they did, and stop waiting for the bank
// (`FINAL_ROWS_BY_MONTH`). The bank's last balance is no longer shown: the closed account is $0. Changing such a
// row, or any word from the bank about the account, opens it again.
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { CloseAccount, type AccountRow } from '@ledgerline/contracts';
import { formatCents } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { changedSince } from '../http/through.js';
import type { Scoped } from '../db/scoped.js';
import { uncovered } from '../ledger/ledger.js';
import { ACK, CHANGED, GONE, HttpError, parse, scoped } from './api.js';

export const accountCloseRoutes = new Hono<AppEnv>();

const UPCOMING = 'It has upcoming transactions. Delete them first.';

/** What is still open in an account, as its register lists it. */
export interface OpenRows {
  /** Pending rows, the bank's or yours: they don't block Close (D-93). */
  pending: boolean;
  upcoming: boolean;
}

/** Why an open account can't be closed yet, or null when it can. The phone works it out (D-45). */
export function closeBlocked(a: AccountRow, open: OpenRows, cardAvailable: number | null): string | null {
  const credit = a.kind === 'credit';
  // With a pending row, the bank's balance may never reach $0 (D-93): the working balance decides.
  if (!open.pending && a.bank !== 0)
    return credit
      ? `You still owe ${formatCents(Math.abs(a.bank))} on this card. Pay it off first.`
      : `It still has ${formatCents(a.bank)} at the bank. Move the money out first.`;
  if (open.upcoming) return UPCOMING;
  if (a.working !== 0) return `Its balance after pending is ${formatCents(a.working)}, not $0.`;
  if (credit && cardAvailable !== null && cardAvailable !== 0)
    return `Its payment category has ${formatCents(cardAvailable)} available. Move it to another category first.`;
  return null;
}

/**
 * Pending rows in closed accounts (the bank's, and your entries), added up by the month of their date: they are
 * final (D-93), so net worth over time counts them as it counts posted rows. Binds ?1 (budget id).
 */
export const FINAL_ROWS_BY_MONTH = `SELECT substr(v.date, 1, 7) AS month, sum(v.amount) AS a FROM (
    SELECT budget_id, account_id, date, amount, wont_clear FROM v_txn_manual WHERE budget_id = ?1 AND status = 'pending'
    UNION ALL
    SELECT budget_id, account_id, date, amount, wont_clear FROM v_txn_bank WHERE budget_id = ?1 AND bank_pending = 1
      AND ${uncovered('v_txn_bank')}
  ) v JOIN account a ON a.id = v.account_id
  WHERE v.wont_clear = 0 AND a.closed_at IS NOT NULL GROUP BY 1`;

/** A row of a closed account: a pending one there is final, listed by its date (D-93). */
export const IN_CLOSED_ACCOUNT = `(account_id IN (SELECT id FROM account WHERE budget_id = ?1 AND closed_at IS NOT NULL))`;

/** Opens the account `account` names (SQL over ?2) again, with its card payment category. */
function reopen(s: Scoped, account: string, arg: string, now: number): Stmt[] {
  return [
    s.q(
      `UPDATE category SET archived_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND kind = 'cc_payment'
         AND card_account_id = ${account} AND archived_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM account WHERE budget_id = ?1 AND id = ${account} AND closed_at IS NOT NULL)`,
      arg,
      now,
    ),
    s.q(
      `UPDATE account SET closed_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ${account} AND closed_at IS NOT NULL`,
      arg,
      now,
    ),
  ];
}

/** Opens an account again with its card payment category. Nothing to do when it is open. */
export function reopenStmts(s: Scoped, accountId: string, now: number): Stmt[] {
  return reopen(s, '?2', accountId, now);
}

/**
 * Opens the account of your entry `key` again: deleting the entry, or changing what it counts, moves a closed
 * account off $0 (D-93). Nothing to do when the account is open or the row is the bank's. `only` narrows the entry
 * (SQL over manual_pending).
 */
export function reopenForEntry(s: Scoped, key: string, now: number, only = '1'): Stmt[] {
  return reopen(
    s,
    `(SELECT account_id FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND ${only})`,
    key,
    now,
  );
}

accountCloseRoutes.post('/accounts/:id/close', async (c) => {
  const r = await parse(CloseAccount, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const a = await s.first<{ kind: string; closed_at: number | null; provider_account_id: string | null }>(
    `SELECT kind, closed_at, provider_account_id FROM account WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!a) throw new HttpError(404, 'not_found', GONE);
  if (a.closed_at !== null) return c.json(ACK);
  // The server doesn't work out balances (D-45): the phone sends what it showed, and nothing may have changed since
  // it worked them out (the same check as archiving a category).
  if (await changedSince(c, r.through)) throw new HttpError(409, 'changed', CHANGED);
  const credit = a.kind === 'credit';
  if (r.working !== 0 || (credit && r.available !== 0))
    throw new HttpError(422, 'invalid', 'Close works only at $0. Pull down to refresh.');
  // What the server can check alone: nothing upcoming, and the bank's balance unless a pending row stays (D-93). A
  // bank pending row that a posted row has taken over, or that an entry of yours covers, is done.
  const [bank, open] = await s.batch([
    s.q(
      `SELECT current_balance AS b FROM provider_account WHERE budget_id = ?1 AND provider_account_id = ?2`,
      a.provider_account_id,
    ),
    s.q(
      `SELECT (SELECT count(*) FROM manual_pending WHERE budget_id = ?1 AND account_id = ?2 AND kind = 'upcoming'
                 AND deleted_at IS NULL AND matched_txn_key IS NULL) AS upcoming,
              (SELECT count(*) FROM manual_pending WHERE budget_id = ?1 AND account_id = ?2 AND kind = 'pending'
                 AND deleted_at IS NULL AND matched_txn_key IS NULL)
            + (SELECT count(*) FROM bank_txn b WHERE b.budget_id = ?1 AND b.provider_account_id = ?3 AND b.pending = 1 AND b.removed_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM manual_pending cv WHERE cv.budget_id = ?1 AND cv.covers_provider_txn_id = b.provider_txn_id
                                   AND cv.deleted_at IS NULL AND cv.matched_txn_key IS NULL)) AS pending`,
      id,
      a.provider_account_id,
    ),
  ]);
  const n = open!.results[0] as { upcoming: number; pending: number } | undefined;
  if ((n?.upcoming ?? 0) > 0) throw new HttpError(422, 'invalid', UPCOMING);
  const b = (bank!.results[0] as { b: number | null } | undefined)?.b ?? 0;
  if (b !== 0 && (n?.pending ?? 0) === 0)
    throw new HttpError(422, 'invalid', 'Close works only at $0. Pull down to refresh.');
  await s.batch([
    s.q(`UPDATE account SET closed_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`, id, now),
    // Its available is $0 (checked above), so archiving moves no money.
    s.q(
      `UPDATE category SET archived_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND kind = 'cc_payment'
         AND card_account_id = ?2 AND archived_at IS NULL`,
      id,
      now,
    ),
    s.audit('account.close', 'account', id, null, null, now),
  ]);
  return c.json(ACK);
});

accountCloseRoutes.post('/accounts/:id/reopen', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const a = await s.first(`SELECT id FROM account WHERE budget_id = ?1 AND id = ?2`, id);
  if (!a) throw new HttpError(404, 'not_found', GONE);
  await s.batch([...reopenStmts(s, id, now), s.audit('account.reopen', 'account', id, null, null, now)]);
  return c.json(ACK);
});
