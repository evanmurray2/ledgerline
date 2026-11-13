// Add a transaction you entered: pending (counts now) or upcoming (counts from its date).
import type { Context } from 'hono';
import { NewTxnRequest } from '@ledgerline/contracts';
import { type Month, monthOfDate } from '@ledgerline/domain';
import { newId } from '../http/ids.js';
import { editNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped, GONE, FAR_DATE, inReach, thisMonth } from './api.js';
import { reopenStmts } from './account-close.js';
import { monthLong } from '../views/common.js';
import { commit } from './txn-common.js';

export async function addTxn(c: Context<AppEnv>) {
  const r = await parse(NewTxnRequest, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  if (!inReach(monthOfDate(r.date), await thisMonth(s, now))) throw new HttpError(422, 'too_far', FAR_DATE);
  // Before the budget start is history, which never counts (D-61, D-67); your own entries there are refused too
  // (D-79).
  const start = (
    await s.first<{ m: string | null }>(`SELECT budget_start_month AS m FROM budget WHERE id = ?1`)
  )?.m;
  if (start && monthOfDate(r.date) < start)
    throw new HttpError(
      422,
      'before_start',
      `Pick a date from ${monthLong(start as Month)} 1, ${start.slice(0, 4)} on.`,
    );
  const acct = await s.first(`SELECT id FROM account WHERE budget_id = ?1 AND id = ?2`, r.accountId);
  if (!acct) throw new HttpError(404, 'not_found', GONE);
  if (r.categoryId) {
    const ok = await s.first(
      `SELECT id FROM category WHERE budget_id = ?1 AND id = ?2 AND kind != 'cc_payment'`,
      r.categoryId,
    );
    if (!ok) throw new HttpError(404, 'not_found', GONE);
  }
  // Only money in can go to Ready to Assign.
  const toRta = r.toRta === true && r.amount > 0;
  const key = `m:${newId(c)}`;
  const w = [
    // An entry for a closed account opens it again (D-73).
    ...reopenStmts(s, r.accountId, now),
    s.q(
      `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      newId(c),
      key,
      r.accountId,
      r.kind,
      r.date,
      r.amount,
      r.payee,
      r.repeats,
      now,
    ),
    s.q(
      `INSERT INTO txn_overlay (txn_key, budget_id, category_id, to_rta, categorized_by, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, 'user', ?5, ?5)`,
      key,
      toRta ? null : r.categoryId,
      toRta ? 1 : 0,
      now,
    ),
    s.audit('txn.add', 'transaction', key, null, r, now),
  ];
  return c.json(await commit(c, w));
}
