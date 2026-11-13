// Add a transaction you entered: pending (counts now) or upcoming (counts from its date). A pending one can also be a
// transfer, owed to you, or pay back what's owed to you, in the same edit.
import type { Context } from 'hono';
import { NewTxnRequest } from '@ledgerline/contracts';
import { type Month, monthOfDate } from '@ledgerline/domain';
import { newId } from '../http/ids.js';
import { editNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped, GONE, FAR_DATE, inReach, thisMonth } from './api.js';
import { reopenStmts } from './account-close.js';
import { monthLong } from '../views/common.js';
import type { Stmt } from '@ledgerline/db/sql';
import { commit, owedStmt } from './txn-common.js';
import { openItems } from './activity.js';

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
  const extras = [r.transferAccountId, r.owed, r.paysBack].filter((x) => x !== undefined).length;
  if (extras > 1) throw new HttpError(422, 'invalid', 'Pick one: a transfer, owed to you or paid back.');
  if (extras && r.kind !== 'pending')
    throw new HttpError(422, 'invalid', 'Only a transaction dated today or earlier can be this.');
  if (r.owed && r.amount >= 0)
    throw new HttpError(422, 'not_outflow', 'Only money going out can be owed to you.');
  if (r.paysBack && r.amount <= 0)
    throw new HttpError(422, 'not_inflow', 'Only money coming in can pay back what’s owed to you.');
  // Only money in can go to Ready to Assign. Money that pays back what's owed is all in Ready to Assign (rule 12, D-98),
  // and a transfer has no category.
  const toRta = (r.toRta === true && r.amount > 0) || !!r.paysBack;
  const categoryId = toRta || r.transferAccountId ? null : r.categoryId;
  const key = `m:${newId(c)}`;
  const w: Stmt[] = [
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
      categoryId,
      toRta ? 1 : 0,
      now,
    ),
  ];
  if (r.transferAccountId) w.push(...(await transferSide(c, key, r.accountId, r.transferAccountId, r, now)));
  if (r.owed) w.push(owedStmt(s, key, r.amount, r.owed, now));
  if (r.paysBack) w.push(...(await paysBack(c, key, r.amount, r.paysBack, now)));
  w.push(s.audit('txn.add', 'transaction', key, null, r, now));
  return c.json(await commit(c, w));
}

/**
 * The other side of a transfer you add: a pending entry of the opposite amount in the other account, paired with this
 * one, as "Which account got this money?" adds one (D-83). Each bank row takes its own side over when it comes.
 */
async function transferSide(
  c: Context<AppEnv>,
  key: string,
  accountId: string,
  otherId: string,
  r: { date: string; amount: number },
  now: number,
): Promise<Stmt[]> {
  const s = scoped(c);
  // The account this entry is in may be closed (the entry opens it again, D-73); the other side's can't be.
  const me = await s.first<{ name: string }>(
    `SELECT name FROM account WHERE budget_id = ?1 AND id = ?2`,
    accountId,
  );
  const other = await s.first<{ name: string; budget_from: string }>(
    `SELECT name, budget_from FROM account WHERE budget_id = ?1 AND id = ?2 AND role = 'budget' AND closed_at IS NULL`,
    otherId,
  );
  if (otherId === accountId) throw new HttpError(422, 'invalid', 'Pick another account for the transfer.');
  if (!other) throw new HttpError(404, 'not_found', GONE);
  if (r.date < other.budget_from)
    throw new HttpError(
      422,
      'before_start',
      `${other.name}’s budget starts after this date. Pick another date.`,
    );
  const entry = `m:${newId(c)}`;
  return [
    s.q(
      `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, 'pending', ?5, ?6, ?7, 'never', ?8, ?8)`,
      newId(c),
      entry,
      otherId,
      r.date,
      -r.amount,
      `Transfer ${r.amount < 0 ? 'from' : 'to'} ${me?.name ?? 'another account'}`,
      now,
    ),
    s.q(
      `INSERT INTO txn_overlay (txn_key, budget_id, transfer_state, transfer_account_id, categorized_by, created_at, updated_at)
       VALUES (?2, ?1, 'paired', ?3, 'user', ?4, ?4)`,
      entry,
      accountId,
      now,
    ),
    s.q(
      `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      otherId,
    ),
    s.q(
      `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'transfer', ?3, ?4, 'user', ?5)`,
      newId(c),
      r.amount < 0 ? key : entry,
      r.amount < 0 ? entry : key,
      now,
    ),
  ];
}

/** Money in that pays back owed items, checked as Match money back checks it (rule 12). */
async function paysBack(
  c: Context<AppEnv>,
  key: string,
  amount: number,
  items: { itemId: string; amount: number }[],
  now: number,
): Promise<Stmt[]> {
  const s = scoped(c);
  if (items.reduce((a, i) => a + i.amount, 0) > amount)
    throw new HttpError(422, 'too_much', 'That’s more than came in. Lower an amount.');
  const { rows } = await openItems(s, new Date(now).toISOString().slice(0, 10));
  const w: Stmt[] = [];
  for (const i of items) {
    const o = rows.find((x) => x.id === i.itemId);
    if (!o || (o.status !== 'open' && o.status !== 'late')) throw new HttpError(404, 'not_found', GONE);
    if (i.amount > o.stillOwed)
      throw new HttpError(422, 'too_much', 'That’s more than is still owed. Lower the amount.');
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at) VALUES (?2, ?1, 'reimbursement_of', ?3, ?4, ?5, 'user', ?6)`,
        newId(c),
        key,
        i.itemId,
        i.amount,
        now,
      ),
    );
  }
  w.push(s.q(`UPDATE txn_overlay SET wtm_state = 'matched' WHERE budget_id = ?1 AND txn_key = ?2`, key));
  return w;
}
