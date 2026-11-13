// Matching money back and Owed to you. The Activity screen and its badges are in activity-view.ts, transfers in
// transfers.ts, the transaction sheet and its edits in transactions.ts.
import { newId } from '../http/ids.js';
import type { Stmt } from '@ledgerline/db/sql';
import { editNow } from '../http/clock.js';
import { Hono } from 'hono';
import { MatchRequest, OwedAction, type MatchView, type OwedView } from '@ledgerline/contracts';
import { cents, daysBetween, formatCents, owedList, owedOut, projectedFronts } from '@ledgerline/domain';

import type { AppEnv } from '../http/context.js';
import { CHANGED, GONE, HttpError, parse, scoped } from './api.js';
import { fresh, shortDate } from '../views/common.js';
import { listRow } from '../views/rows.js';
import { txnCol } from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { OVERLAY_UPSERT, commit, loadTx, names, refuseHistory } from './txn-common.js';
import { recentPaybacks } from '../views/owed-paybacks.js';
export const activityRoutes = new Hono<AppEnv>();

/** An owed item already closed out or unmarked: Reopen first. */
const OWED_DONE = 'This item is already closed out. Pull down to refresh.';

// ---------------------------------------------------------------- matching money back

export async function openItems(s: Scoped, today: string) {
  const [items, links] = await s.batch([
    s.q(
      `SELECT e.id, e.txn_key, e.amount, e.expect_by, e.closed_at, e.closed_month, e.closed_amount, e.canceled_at, coalesce(${txnCol('e.txn_key', 'payee')}, '') AS payee,
         ${txnCol('e.txn_key', 'date')} AS date, ${txnCol('e.txn_key', 'category_id')} AS category_id, ${txnCol('e.txn_key', 'amount')} AS txn_amount
       FROM expected_reimbursement e WHERE e.budget_id = ?1
         AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)
       ORDER BY e.created_at, e.id`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
  ]);
  const raw = items!.results as {
    id: string;
    txn_key: string;
    amount: number;
    expect_by: string | null;
    closed_at: number | null;
    closed_month: string | null;
    closed_amount: number | null;
    canceled_at: number | null;
    payee: string;
    date: string | null;
    category_id: string | null;
    txn_amount: number | null;
  }[];
  const rows = owedList(
    raw.map((o) => ({
      id: o.id,
      txnKey: o.txn_key,
      amount: cents(o.amount),
      expectBy: o.expect_by,
      closedAt: o.closed_at ? 'x' : null,
      canceledAt: o.canceled_at ? 'x' : null,
    })),
    (links!.results as { from_key: string; to_key: string; amount: number }[]).map((l) => ({
      inflowKey: l.from_key,
      itemId: l.to_key,
      amount: cents(l.amount),
    })),
    today,
  );
  return { rows, raw };
}

const NOT_INFLOW = 'Only money coming in can be matched.';

/** What an inflow already pays back: its links to owed items that are still in place. */
async function linkedFrom(s: Scoped, key: string): Promise<number> {
  const r = await s.first<{ n: number | null }>(
    `SELECT sum(amount) AS n FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL`,
    key,
  );
  return r?.n ?? 0;
}

activityRoutes.get('/match/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const t = await loadTx(s, key);
  const f = await fresh(s, editNow(c));
  const { cats, accts } = await names(s);
  // Only money coming in can pay something back (an outflow opened here by its link has nothing to match).
  if (t.amount <= 0) throw new HttpError(422, 'not_inflow', NOT_INFLOW);
  const { rows, raw } = await openItems(s, f.today);
  // What this money already pays back is spoken for: only the rest can match more (rule 12).
  const left0 = t.amount - (await linkedFrom(s, key));
  let left = left0;
  const open = rows
    .filter((o) => o.status === 'open' || o.status === 'late')
    .map((o) => {
      const r = raw.find((x) => x.id === o.id)!;
      return { o, r, near: r.date ? Math.abs(daysBetween(r.date, t.date)) : 999 };
    })
    .sort((a, b) => a.near - b.near)
    .map(({ o, r }) => {
      const suggested = Math.max(0, Math.min(o.stillOwed, left));
      left -= suggested;
      return {
        id: o.id,
        label: `${r.payee} · ${shortDate(r.date)}`,
        still: o.stillOwed,
        expectBy: o.expectBy,
        late: o.status === 'late',
        suggested: cents(suggested),
      };
    });
  const view: MatchView = { inflow: listRow(t, accts, cats), left: cents(Math.max(0, left0)), open };
  return c.json(view);
});

activityRoutes.post('/match', async (c) => {
  const r = await parse(MatchRequest, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const t = await loadTx(s, r.inflowKey);
  refuseHistory(t);
  if (t.amount <= 0) throw new HttpError(422, 'not_inflow', NOT_INFLOW);
  const total = r.items.reduce((a, i) => a + i.amount, 0);
  // Links this money already has count too: together they can't pay back more than came in (rule 12).
  const already = await linkedFrom(s, r.inflowKey);
  if (total > 0 && already + total > t.amount)
    throw new HttpError(422, 'too_much', 'That’s more than came in. Lower an amount.');
  const today = new Date(now).toISOString().slice(0, 10);
  const { rows } = await openItems(s, today);
  for (const i of r.items) {
    const o = rows.find((x) => x.id === i.itemId);
    if (!o || (o.status !== 'open' && o.status !== 'late')) throw new HttpError(404, 'not_found', GONE);
    if (i.amount > o.stillOwed)
      throw new HttpError(422, 'too_much', 'That’s more than is still owed. Lower the amount.');
  }
  const w: Stmt[] = [s.q(OVERLAY_UPSERT, r.inflowKey, now)];
  // "It's income": the money pays back nothing, so what it was matched to before is owed again.
  if (total === 0 && already > 0)
    w.push(
      s.q(
        `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL`,
        r.inflowKey,
        now,
      ),
    );
  for (const i of r.items) {
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at) VALUES (?2, ?1, 'reimbursement_of', ?3, ?4, ?5, 'user', ?6)`,
        newId(c),
        r.inflowKey,
        i.itemId,
        i.amount,
        now,
      ),
    );
  }
  // Rule 12: a matched inflow is in RTA, all of it; what it pays back is settled. Nothing is held back (D-98).
  w.push(
    s.q(
      `UPDATE txn_overlay SET wtm_state = ?3, to_rta = 1, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
      r.inflowKey,
      total > 0 ? 'matched' : 'income',
      now,
    ),
  );
  w.push(s.audit('match', 'transaction', r.inflowKey, null, r, now));
  return c.json(await commit(c, w));
});

activityRoutes.post('/match/:key/unlink', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
  await loadTx(s, key);
  // Rule 12: the owed items open again, and the inflow goes back to where the usual rules put it (D-98): Ready to Assign
  // for money into checking or savings (D-85), Needs category for a card credit or a deposit that looks like a transfer.
  const w = [
    s.q(
      `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL`,
      key,
      now,
    ),
    s.q(
      `UPDATE txn_overlay SET wtm_state = NULL, to_rta = 0, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    s.audit('match.unlink', 'transaction', key, null, null, now),
  ];
  return c.json(await commit(c, w));
});

// ---------------------------------------------------------------- Owed to you

/** Names of person-to-person payments: the money in that Match money back offers first (D-98). */
const PERSON_TO_PERSON = ['ZELLE', 'VENMO', 'CASH APP', 'CASHAPP', 'PAYPAL', 'APPLE CASH'];

/**
 * The newest money in from a person in the last 30 days that pays back nothing yet and that you haven't called income
 * or a transfer. It is only offered: nothing is held for it (D-98).
 */
async function possiblePayback(s: Scoped, today: string): Promise<OwedView['payback']> {
  const r = await s.first<{ key: string; payee: string; amount: number; date: string }>(
    `SELECT v.key, v.payee, v.amount, v.date FROM v_txn_bank v
     WHERE v.budget_id = ?1 AND v.amount > 0 AND v.posted_date >= date(?2, '-30 days')
       AND (v.budget_from IS NULL OR v.date >= v.budget_from)
       AND v.wtm_state IS NULL AND v.transfer_state IS NULL AND v.category_id IS NULL AND coalesce(v.to_rta, 0) = 0
       AND (${PERSON_TO_PERSON.map((w) => `v.raw_name LIKE '%${w}%'`).join(' OR ')})
       AND NOT EXISTS (SELECT 1 FROM txn_link l WHERE l.budget_id = ?1 AND l.from_key = v.key AND l.undone_at IS NULL)
     ORDER BY v.posted_date DESC, v.seq DESC LIMIT 1`,
    today,
  );
  return r ? { key: r.key, payee: r.payee, amount: cents(r.amount), date: r.date } : null;
}

activityRoutes.get('/owed', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  const { cats } = await names(s);
  const { rows, raw } = await openItems(s, f.today);
  const fr = await s.all<{ txn_key: string; date: string; payee_name: string; amount: number }>(
    `SELECT m.txn_key, m.date, m.payee_name, e.amount FROM manual_pending m JOIN expected_reimbursement e ON e.budget_id = m.budget_id AND e.txn_key = m.txn_key
     WHERE m.budget_id = ?1 AND m.kind = 'upcoming' AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL AND e.canceled_at IS NULL`,
  );
  const open = rows.some((o) => o.status === 'open' || o.status === 'late');
  const view: OwedView = {
    out: owedOut(rows),
    items: rows
      .filter((o) => o.status !== 'canceled')
      .map((o) => {
        const r = raw.find((x) => x.id === o.id)!;
        return {
          id: o.id,
          txnKey: r.txn_key,
          label: r.payee,
          sub: `${shortDate(r.date)}${r.txn_amount !== null ? ` · ${formatCents(r.txn_amount)}` : ''}`,
          categoryName: r.category_id ? (cats.get(r.category_id) ?? null) : null,
          amount: o.amount,
          matched: o.matched,
          still: o.stillOwed,
          expectBy: o.expectBy,
          status: o.status,
          ...(o.status === 'closed'
            ? {
                closedMonth: r.closed_month,
                closedAmount: r.closed_amount === null ? null : cents(r.closed_amount),
              }
            : {}),
        };
      }),
    projected: projectedFronts(
      cents(f.budget.rta),
      fr.map((r) => ({ key: r.txn_key, date: r.date, owed: cents(r.amount) })),
      f.today,
    ).map((p) => ({
      ...p,
      label: fr.find((x) => x.txn_key === p.key)!.payee_name,
    })),
    payback: open ? await possiblePayback(s, f.today) : null,
    paidBack: await recentPaybacks(s, f.today, new Map(raw.map((r) => [r.id, r.payee]))),
  };
  return c.json(view);
});

activityRoutes.post('/owed/:id', async (c) => {
  const r = await parse(OwedAction, c.req.raw);
  const s = scoped(c);
  const id = c.req.param('id');
  const now = editNow(c);
  const f = await fresh(s, now);
  const { rows } = await openItems(s, f.today);
  const o = rows.find((x) => x.id === id);
  if (!o) throw new HttpError(404, 'not_found', GONE);
  // Close out, Remove the mark and a new date act on an item still owed; Remove the mark also on one paid back in
  // part or in full. Not on one already closed out or unmarked (Reopen undoes those, D-80).
  const open = o.status === 'open' || o.status === 'late';
  if (r.action !== 'reopen' && !(open || (r.action === 'cancel' && o.status === 'paid_back')))
    throw new HttpError(409, 'changed', OWED_DONE);
  if (r.action === 'snooze' && r.expectBy && r.expectBy < f.today)
    throw new HttpError(422, 'invalid', 'Choose today or a later date.');
  let w: Stmt[];
  if (r.action === 'reopen') w = await reopen(s, id, f.current, now, () => newId(c));
  else if (r.action === 'close') {
    // Rule 11: charge what's left to the original category this month; RTA gets it back.
    w = [
      s.q(
        `UPDATE expected_reimbursement SET closed_at = ?3, closed_month = ?4, closed_amount = ?5, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
        id,
        now,
        f.current,
        o.stillOwed,
      ),
    ];
  } else if (r.action === 'cancel') {
    w = [
      s.q(
        `UPDATE expected_reimbursement SET canceled_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
        id,
        now,
      ),
    ];
  } else {
    if (!r.expectBy) throw new HttpError(400, 'invalid', 'Pick a date.');
    w = [
      s.q(
        `UPDATE expected_reimbursement SET expect_by = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
        id,
        r.expectBy,
        now,
      ),
    ];
  }
  w.push(s.audit(`owed.${r.action}`, 'owed', id, null, r, now));
  return c.json(await commit(c, w));
});

/**
 * Undoes Close out or Remove the mark (D-80). Remove the mark is undone as if it never happened (rule 11 counts it in
 * the transaction's own month either way). A close undone in the month it was made goes as if it never happened; one
 * made in an earlier month stays there as a close line (owed_close), and the undo is a line of the opposite amount
 * this month, so the earlier month stays as it was.
 */
async function reopen(
  s: Scoped,
  id: string,
  current: string,
  now: number,
  /** The next new id of the request (http/ids.ts): the two undo lines each take one. */
  nextId: () => string,
): Promise<Stmt[]> {
  const e = await s.first<{
    txn_key: string;
    closed_at: number | null;
    closed_month: string | null;
    closed_amount: number | null;
    canceled_at: number | null;
  }>(
    `SELECT txn_key, closed_at, closed_month, closed_amount, canceled_at FROM expected_reimbursement WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!e) throw new HttpError(404, 'not_found', GONE);
  if (e.canceled_at)
    return [
      s.q(
        `UPDATE expected_reimbursement SET canceled_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
        id,
        now,
      ),
    ];
  if (!e.closed_at) throw new HttpError(409, 'changed', CHANGED);
  const w: Stmt[] = [];
  if (e.closed_month && e.closed_amount && e.closed_month < current) {
    const add = (month: string, amount: number) =>
      s.q(
        `INSERT INTO owed_close (id, budget_id, item_id, txn_key, month, amount, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
        nextId(),
        id,
        e.txn_key,
        month,
        amount,
        now,
      );
    w.push(add(e.closed_month, e.closed_amount), add(current, -e.closed_amount));
  }
  w.push(
    s.q(
      `UPDATE expected_reimbursement SET closed_at = NULL, closed_month = NULL, closed_amount = NULL, updated_at = ?3
       WHERE budget_id = ?1 AND id = ?2`,
      id,
      now,
    ),
  );
  return w;
}
