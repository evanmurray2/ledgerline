// Matching money back, transfers and Owed to you. The Activity screen and its badges are in activity-view.ts; the
// transaction sheet and its edits in transactions.ts.
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import { MatchRequest, OwedAction, TransferPick, type MatchView, type OwedView } from '@ledgerline/contracts';
import { cents, daysBetween, formatCents, owedList, owedOut, projectedFronts } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { CHANGED, GONE, HttpError, parse, scoped } from './api.js';
import { fresh, shortDate } from '../views/common.js';
import { isHistory, listRow } from '../views/rows.js';
import { RECENT_TX, TX_COLUMNS, txnCol, type TxRow } from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { OVERLAY_UPSERT, commit, loadTx, names, refuseHistory } from './txn-common.js';
export const activityRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- matching money back

async function openItems(s: Scoped, today: string) {
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

activityRoutes.get('/match/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const t = await loadTx(s, key);
  const f = await fresh(s, clock(c.env));
  const { cats, accts } = await names(s);
  const { rows, raw } = await openItems(s, f.today);
  let left = t.amount;
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
  const view: MatchView = { inflow: listRow(t, accts, cats), open };
  return c.json(view);
});

activityRoutes.post('/match', async (c) => {
  const r = await parse(MatchRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const t = await loadTx(s, r.inflowKey);
  refuseHistory(t);
  if (t.amount <= 0) throw new HttpError(422, 'not_inflow', 'Only money coming in can be matched.');
  const total = r.items.reduce((a, i) => a + i.amount, 0);
  if (total > t.amount) throw new HttpError(422, 'too_much', 'That’s more than came in. Lower an amount.');
  const today = new Date(now).toISOString().slice(0, 10);
  const { rows } = await openItems(s, today);
  for (const i of r.items) {
    const o = rows.find((x) => x.id === i.itemId);
    if (!o || (o.status !== 'open' && o.status !== 'late')) throw new HttpError(404, 'not_found', GONE);
    if (i.amount > o.stillOwed)
      throw new HttpError(422, 'too_much', 'That’s more than is still owed. Lower the amount.');
  }
  const w: Stmt[] = [s.q(OVERLAY_UPSERT, r.inflowKey, now)];
  for (const i of r.items) {
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, amount, created_by, created_at) VALUES (?2, ?1, 'reimbursement_of', ?3, ?4, ?5, 'user', ?6)`,
        ulid(now),
        r.inflowKey,
        i.itemId,
        i.amount,
        now,
      ),
    );
  }
  // Rule 9/12: Match moves the matched part to RTA; the rest follows your choice.
  const rest = t.amount - total;
  const state =
    rest > 0 && r.rest !== 'income'
      ? r.rest === 'send_back'
        ? 'send_back'
        : 'waiting'
      : total > 0
        ? 'matched'
        : 'income';
  w.push(
    s.q(
      `UPDATE txn_overlay SET wtm_state = ?3, to_rta = ?4, updated_at = ?5 WHERE budget_id = ?1 AND txn_key = ?2`,
      r.inflowKey,
      state,
      state === 'matched' || state === 'income' ? 1 : 0,
      now,
    ),
  );
  w.push(s.audit('match', 'transaction', r.inflowKey, null, r, now));
  return c.json(await commit(c, w));
});

activityRoutes.post('/match/:key/unlink', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const t = await loadTx(s, key);
  // Rule 12: a person-to-person payback returns to Waiting to match; part of a paycheck stays in RTA.
  const p2p = t.wtm_state !== null;
  const w = [
    s.q(
      `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL`,
      key,
      now,
    ),
    ...(p2p
      ? [
          s.q(
            `UPDATE txn_overlay SET wtm_state = 'waiting', to_rta = 0, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
            key,
            now,
          ),
        ]
      : []),
    s.audit('match.unlink', 'transaction', key, null, null, now),
  ];
  return c.json(await commit(c, w));
});

// ---------------------------------------------------------------- transfers

activityRoutes.post('/transfers/:key/pick', async (c) => {
  const r = await parse(TransferPick, c.req.raw);
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const me = await loadTx(s, key);
  refuseHistory(me);
  if (me.transfer_state !== 'unsorted' || me.amount === 0) throw new HttpError(422, 'not_unclear', CHANGED);
  // The other side: a row of the opposite amount in another account within 5 days that isn't already a transfer
  // and isn't matched to what you're owed. A deposit from another bank comes in its own sync, so it is often not
  // marked unsorted itself; the sheet offers it all the same (it reads the other registers), so it is accepted.
  const sides = (amount: number, accountId: string, date: string) =>
    s.all<TxRow>(
      `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1 AND amount = ?2 AND account_id != ?3
         AND abs(julianday(date) - julianday(?4)) <= 5
         AND (transfer_state IS NULL OR transfer_state = 'unsorted') AND (wtm_state IS NULL OR wtm_state IN ('waiting', 'income'))`,
      amount,
      accountId,
      date,
    );
  const cands = (await sides(-me.amount, me.account_id, me.date)).filter((x) => !isHistory(x));
  const w: Stmt[] = [];
  // The outflow of the pair: its unsorted deposits that weren't the other side become income below.
  let out: TxRow | null = me.amount < 0 ? me : null;
  if (r.otherKey) {
    const other = cands.find((x) => x.key === r.otherKey);
    if (!other) throw new HttpError(404, 'not_found', GONE);
    const [from, to] = me.amount < 0 ? [me, other] : [other, me];
    out = from;
    for (const [t, o] of [
      [me, other],
      [other, me],
    ] as const)
      w.push(
        s.q(OVERLAY_UPSERT, t.key, now),
        s.q(
          `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3, wtm_state = NULL, categorized_by = 'user', updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
          t.key,
          o.account_id,
          now,
        ),
      );
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'transfer', ?3, ?4, 'user', ?5)`,
        ulid(now),
        from.key,
        to.key,
        now,
      ),
    );
  } else if (r.accountId) {
    // The other side hasn't arrived yet (D-83): a pending entry of the opposite amount in that account, paired with
    // this row. It counts like any entry of yours until the bank's row takes it over (sync, same-purchase.ts).
    const acct = await s.first<{ name: string; budget_from: string }>(
      `SELECT name, budget_from FROM account WHERE budget_id = ?1 AND id = ?2 AND role = 'budget' AND closed_at IS NULL`,
      r.accountId,
    );
    if (!acct || r.accountId === me.account_id) throw new HttpError(404, 'not_found', GONE);
    if (me.date < acct.budget_from)
      throw new HttpError(
        422,
        'before_start',
        `${acct.name}’s budget starts after this date. Pick another answer.`,
      );
    const entry = `m:${ulid(now)}`;
    w.push(
      s.q(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'pending', ?5, ?6, ?7, 'never', ?8, ?8)`,
        ulid(now),
        entry,
        r.accountId,
        me.date,
        -me.amount,
        `Transfer ${me.amount < 0 ? 'from' : 'to'} ${me.account_name}`,
        now,
      ),
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, transfer_state, transfer_account_id, categorized_by, created_at, updated_at)
         VALUES (?2, ?1, 'paired', ?3, 'user', ?4, ?4)`,
        entry,
        me.account_id,
        now,
      ),
      s.q(OVERLAY_UPSERT, me.key, now),
      s.q(
        `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3, wtm_state = NULL, categorized_by = 'user', updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        me.key,
        r.accountId,
        now,
      ),
      // The link and the entry share created_at: Undo (unpair) removes an entry made this way while it is still yours.
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'transfer', ?3, ?4, 'user', ?5)`,
        ulid(now),
        me.amount < 0 ? me.key : entry,
        me.amount < 0 ? entry : me.key,
        now,
      ),
    );
  } else if (r.unlinked) {
    // An account that isn't linked (Venmo, say): the money leaves (or enters) the budget accounts with no category,
    // so it comes out of (or goes into) Ready to Assign (D-20).
    w.push(
      s.q(
        `UPDATE txn_overlay SET transfer_state = 'manual', transfer_account_id = NULL, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
    );
  } else {
    // Neither: it was a payment (or, for a deposit, income) and needs a category.
    w.push(
      s.q(
        `UPDATE txn_overlay SET transfer_state = NULL, transfer_account_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
    );
  }
  // The outflow's unsorted deposits that weren't the other side are income (Ready to Assign).
  const deposits = out === me ? cands : out ? await sides(-out.amount, out.account_id, out.date) : [];
  for (const x of deposits) {
    if (x.key === me.key || x.key === r.otherKey || x.transfer_state !== 'unsorted' || isHistory(x)) continue;
    w.push(
      s.q(
        `UPDATE txn_overlay SET transfer_state = NULL, to_rta = 1, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        x.key,
        now,
      ),
    );
  }
  w.push(s.audit('transfer.pick', 'transaction', key, null, r, now));
  return c.json(await commit(c, w));
});

activityRoutes.post('/transfers/:key/unpair', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const link = await s.first<{ from_key: string; to_key: string; created_at: number }>(
    `SELECT from_key, to_key, created_at FROM txn_link WHERE budget_id = ?1 AND kind = 'transfer' AND undone_at IS NULL AND (from_key = ?2 OR to_key = ?2)`,
    key,
  );
  const t = await loadTx(s, key);
  const other =
    link?.from_key === key
      ? link.to_key
      : (link?.from_key ??
        (
          await s.first<{ key: string }>(
            `SELECT key FROM ${RECENT_TX} WHERE budget_id = ?1 AND transfer_state = 'paired' AND account_id = ?2 AND amount = ?3 AND abs(julianday(date) - julianday(?4)) <= 5`,
            t.transfer_account_id ?? '',
            -t.amount,
            t.date,
          )
        )?.key);
  const keys = [key, ...(other ? [other] : [])];
  const w = keys.map((k) =>
    s.q(
      `UPDATE txn_overlay SET transfer_state = NULL, transfer_account_id = NULL, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      k,
      now,
    ),
  );
  if (link)
    w.push(
      s.q(
        `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'transfer' AND (from_key = ?2 OR to_key = ?2)`,
        key,
        now,
      ),
    );
  // The pending entry the pick added for an other side that hadn't arrived (D-83) goes with the pair, while the bank
  // hasn't taken it over.
  for (const k of keys)
    if (link && k.startsWith('m:'))
      w.push(
        s.q(
          `UPDATE manual_pending SET deleted_at = ?4, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2 AND created_at = ?3
             AND matched_txn_key IS NULL AND deleted_at IS NULL`,
          k,
          link.created_at,
          now,
        ),
      );
  w.push(s.audit('transfer.unpair', 'transaction', key, null, null, now));
  return c.json(await commit(c, w));
});

// ---------------------------------------------------------------- Owed to you

activityRoutes.get('/owed', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  const { cats } = await names(s);
  const { rows, raw } = await openItems(s, f.today);
  const fr = await s.all<{ txn_key: string; date: string; payee_name: string; amount: number }>(
    `SELECT m.txn_key, m.date, m.payee_name, e.amount FROM manual_pending m JOIN expected_reimbursement e ON e.budget_id = m.budget_id AND e.txn_key = m.txn_key
     WHERE m.budget_id = ?1 AND m.kind = 'upcoming' AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL AND e.canceled_at IS NULL`,
  );
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
  };
  return c.json(view);
});

activityRoutes.post('/owed/:id', async (c) => {
  const r = await parse(OwedAction, c.req.raw);
  const s = scoped(c);
  const id = c.req.param('id');
  const now = clock(c.env);
  const f = await fresh(s, now);
  const { rows } = await openItems(s, f.today);
  const o = rows.find((x) => x.id === id);
  if (!o) throw new HttpError(404, 'not_found', GONE);
  let w: Stmt[];
  if (r.action === 'reopen') w = await reopen(s, id, f.current, now);
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
async function reopen(s: Scoped, id: string, current: string, now: number): Promise<Stmt[]> {
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
        ulid(now),
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
