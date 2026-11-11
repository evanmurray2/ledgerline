// Close an account, and open it again (D-73). Close runs only at $0: no bank balance, nothing pending or upcoming,
// a working balance of $0 and, for a card, a payment category with $0 available. So no money moves: the account and
// a card's payment category leave the screens, and every past row stays counted. A new row from the bank, or an entry
// you add, opens the account again (`reopenStmts`, called by the sync's apply step and by Add).
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { CloseAccount, type AccountRow } from '@ledgerline/contracts';
import { formatCents } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { changedSince } from '../http/through.js';
import type { Scoped } from '../db/scoped.js';
import { ACK, CHANGED, GONE, HttpError, parse, scoped } from './api.js';

export const accountCloseRoutes = new Hono<AppEnv>();

const PENDING =
  'It has pending or upcoming transactions. Wait for the bank to post them, or delete your own entries.';

/** Why an open account can't be closed yet, or null when it can. The phone works it out (D-45). */
export function closeBlocked(
  a: AccountRow,
  hasPending: boolean,
  cardAvailable: number | null,
): string | null {
  const credit = a.kind === 'credit';
  if (a.bank !== 0)
    return credit
      ? `You still owe ${formatCents(Math.abs(a.bank))} on this card. Pay it off first.`
      : `It still has ${formatCents(a.bank)} at the bank. Move the money out first.`;
  if (hasPending || a.pending !== 0) return PENDING;
  if (a.working !== 0) return `Its balance after pending is ${formatCents(a.working)}, not $0.`;
  if (credit && cardAvailable !== null && cardAvailable !== 0)
    return `Its payment category has ${formatCents(cardAvailable)} available. Move it to another category first.`;
  return null;
}

/** Opens an account again with its card payment category. Nothing to do when it is open. */
export function reopenStmts(s: Scoped, accountId: string, now: number): Stmt[] {
  return [
    s.q(
      `UPDATE category SET archived_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND kind = 'cc_payment'
         AND card_account_id = ?2 AND archived_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM account WHERE budget_id = ?1 AND id = ?2 AND closed_at IS NOT NULL)`,
      accountId,
      now,
    ),
    s.q(
      `UPDATE account SET closed_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2 AND closed_at IS NOT NULL`,
      accountId,
      now,
    ),
  ];
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
  // What the server can check alone: the bank's balance, and no pending or upcoming row.
  const [bank, open] = await s.batch([
    s.q(
      `SELECT current_balance AS b FROM provider_account WHERE budget_id = ?1 AND provider_account_id = ?2`,
      a.provider_account_id,
    ),
    s.q(
      `SELECT (SELECT count(*) FROM bank_txn WHERE budget_id = ?1 AND provider_account_id = ?3 AND pending = 1 AND removed_at IS NULL)
            + (SELECT count(*) FROM manual_pending WHERE budget_id = ?1 AND account_id = ?2 AND deleted_at IS NULL AND matched_txn_key IS NULL) AS n`,
      id,
      a.provider_account_id,
    ),
  ]);
  const b = (bank!.results[0] as { b: number | null } | undefined)?.b ?? 0;
  if (b !== 0) throw new HttpError(422, 'invalid', 'Close works only at $0. Pull down to refresh.');
  if (((open!.results[0] as { n: number } | undefined)?.n ?? 0) > 0)
    throw new HttpError(422, 'invalid', PENDING);
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
