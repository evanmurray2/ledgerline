// The transaction sheet and every edit to one transaction's overlay: categorize, add, check pending, delete, review.
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import {
  CategorizeRequest,
  NewTxnRequest,
  PendingCheckAction,
  TxnPatch,
  type TxnSheet,
} from '@ledgerline/contracts';
import {
  type Month,
  addDays,
  cents,
  formatCents,
  fractionOf,
  localDate,
  monthOfDate,
  owedList,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import type { Scoped } from '../db/scoped.js';
import { HttpError, parse, scoped, GONE } from './api.js';
import { reopenStmts } from './account-close.js';
import { editTime, liveKey } from './sync.js';
import { shortDate } from '../views/common.js';
import { categoryLabel, isHistory } from '../views/rows.js';
import { TX_COLUMNS, chunks, txnCol, type TxRow } from '../ledger/ledger.js';
import { linkInfo, roleOf } from '../ledger/link.js';
import { OVERLAY_UPSERT, commit, loadTx, names, refuseHistory } from './txn-common.js';
import { claimName } from '../sync/payee-keys.js';
import { coverAfterAmount, pairedWith } from './same-purchase.js';

export const transactionRoutes = new Hono<AppEnv>();

transactionRoutes.get('/transactions/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const t = await loadTx(s, key);
  const { cats, accts } = await names(s);
  const [sp, ow, pb, rf, rule, bz] = await s.batch([
    s.q(
      `SELECT id, category_id, amount, memo, absorbs_remainder FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2 ORDER BY sort`,
      key,
    ),
    s.q(
      `SELECT id, amount, fraction_num, fraction_den, expect_by, closed_at, canceled_at FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
    ),
    // Each payback is labelled by the other side: on the money in, the purchase it paid back; on the purchase,
    // the money in that paid it.
    s.q(
      `SELECT l.from_key, l.to_key, l.amount,
         coalesce(CASE WHEN l.from_key = ?2 THEN ${txnCol('e.txn_key', 'payee')} ELSE ${txnCol('l.from_key', 'payee')} END, '') AS label,
         CASE WHEN l.from_key = ?2 THEN ${txnCol('e.txn_key', 'date')} ELSE ${txnCol('l.from_key', 'date')} END AS date
       FROM txn_link l LEFT JOIN expected_reimbursement e ON e.budget_id = l.budget_id AND e.id = l.to_key
       WHERE l.budget_id = ?1 AND l.kind = 'reimbursement_of' AND l.undone_at IS NULL AND (l.from_key = ?2 OR l.to_key IN (SELECT id FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2))`,
      key,
    ),
    s.q(
      `SELECT l.to_key, coalesce(${txnCol('l.to_key', 'payee')}, '') AS label, ${txnCol('l.to_key', 'date')} AS date FROM txn_link l
       WHERE l.budget_id = ?1 AND l.kind = 'refund_of' AND l.undone_at IS NULL AND l.from_key = ?2`,
      key,
    ),
    s.q(`SELECT name FROM rule WHERE budget_id = ?1 AND id = ?2`, t.rule_id ?? ''),
    s.q(`SELECT time_zone FROM budget WHERE id = ?1`),
  ]);
  const splits = sp!.results as {
    id: string;
    category_id: string | null;
    amount: number;
    memo: string | null;
    absorbs_remainder: number;
  }[];
  const pbs = pb!.results as {
    from_key: string;
    to_key: string;
    amount: number;
    label: string;
    date: string | null;
  }[];
  const owedRows = ow!.results as {
    id: string;
    amount: number;
    fraction_num: number | null;
    fraction_den: number | null;
    expect_by: string | null;
    closed_at: number | null;
    canceled_at: number | null;
  }[];
  const zone = (bz!.results[0] as { time_zone: string } | undefined)?.time_zone ?? 'America/Los_Angeles';
  const today = localDate(clock(c.env), zone);
  const owedView = owedList(
    owedRows.map((o) => ({
      id: o.id,
      txnKey: key,
      amount: cents(o.amount),
      expectBy: o.expect_by,
      closedAt: o.closed_at ? 'x' : null,
      canceledAt: o.canceled_at ? 'x' : null,
    })),
    pbs
      .filter((p) => owedRows.some((o) => o.id === p.to_key))
      .map((p) => ({ inflowKey: p.from_key, itemId: p.to_key, amount: cents(p.amount) })),
    today,
  );
  const refund = (rf!.results[0] as { to_key: string; label: string; date: string } | undefined) ?? null;
  const kind: TxnSheet['kind'] = isHistory(t)
    ? 'history'
    : t.transfer_state === 'paired' || t.transfer_state === 'unsorted'
      ? 'transfer'
      : t.status === 'upcoming'
        ? 'upcoming'
        : t.source === 'manual'
          ? 'manual'
          : pbs.some((p) => p.from_key === key) || owedView.some((o) => o.status === 'paid_back')
            ? 'paidBack'
            : refund || (t.account_kind === 'credit' && t.amount > 0)
              ? 'refund'
              : t.amount > 0
                ? 'income'
                : t.status === 'pending'
                  ? 'pending'
                  : 'posted';
  const alerts: string[] = [];
  if (t.alert && !t.reviewed_at)
    for (const a of JSON.parse(t.alert) as string[])
      alerts.push(
        a.startsWith('amount_changed')
          ? 'Amount changed on clearing'
          : a === 'cleared_despite_wont_clear'
            ? 'Cleared despite won’t clear'
            : a,
      );
  const ruleName = (rule!.results[0] as { name: string } | undefined)?.name;
  // A row before the budget start may be part of the starting balance rather than plain history (D-67).
  const inStart = kind === 'history' && roleOf(t, await linkInfo(s)) === 'before';
  const sheet: TxnSheet = {
    key,
    kind,
    ...(inStart ? { inStartingBalance: true } : {}),
    payee: t.payee,
    payeeId: t.payee_id,
    rawName: t.raw_name,
    accountId: t.account_id,
    accountName: accts.get(t.account_id) ?? t.account_name,
    otherAccountName:
      t.transfer_state === 'paired' && t.transfer_account_id
        ? (accts.get(t.transfer_account_id) ?? null)
        : null,
    date: t.date,
    postedDate: t.posted_date,
    amount: cents(t.amount),
    bankAmount: t.bank_amount === null ? null : cents(t.bank_amount),
    estimatedAmount: t.estimated_amount === null ? null : cents(t.estimated_amount),
    status: t.status,
    wontClear: t.wont_clear === 1,
    categoryId: t.category_id,
    categoryLabel: categoryLabel(t, cats, splits.length > 0),
    // 'rule' and 'payee' are only on rows categorized before D-60; they keep their label.
    categorizedBy:
      t.categorized_by === 'rule'
        ? `Rule: ${ruleName ?? 'rule'}`
        : t.categorized_by === 'payee'
          ? 'Remembered for this payee'
          : t.categorized_by === 'user'
            ? 'You'
            : null,
    split: splits.length
      ? splits.map((x) => ({
          id: x.id,
          categoryId: x.category_id,
          amount: cents(x.amount),
          memo: x.memo,
          absorbsRemainder: x.absorbs_remainder === 1,
        }))
      : null,
    memo: t.memo,
    budgetMonth: (t.budget_month ?? monthOfDate(t.date)) as Month,
    budgetMonthOverridden: t.budget_month !== null,
    owed: owedView.map((o) => ({
      id: o.id,
      share: owedShare(owedRows.find((r) => r.id === o.id)),
      amount: o.amount,
      matched: o.matched,
      expectBy: o.expectBy,
      status: o.status,
    })),
    paybacks: pbs.map((p) => ({
      inflowKey: p.from_key,
      itemId: p.to_key,
      amount: cents(p.amount),
      label: p.date ? `${p.label} · ${shortDate(p.date)}` : p.label,
    })),
    refundOf: refund ? { key: refund.to_key, label: `${refund.label} · ${shortDate(refund.date)}` } : null,
    pairedWith: kind === 'history' ? null : await pairedWith(s, t),
    alerts,
  };
  return c.json(sheet);
});

transactionRoutes.patch('/transactions/:key', async (c) => {
  const p = await parse(TxnPatch, c.req.raw);
  const s = scoped(c);
  const key = await liveKey(s, c.req.param('key'));
  const t = await loadTx(s, key);
  refuseHistory(t);
  const now = clock(c.env);
  // Most-recent-edit-wins uses when the edit was made, which for an offline edit is before it arrives.
  const editAt = editTime(c, now);
  const w: Stmt[] = [s.q(OVERLAY_UPSERT, key, now)];
  const set = (col: string, v: unknown) =>
    w.push(
      s.q(
        `UPDATE txn_overlay SET ${col} = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        v,
        now,
      ),
    );
  const edits: Record<string, number> = {};
  if (p.categoryId !== undefined || p.toRta !== undefined) {
    if (p.categoryId) {
      const ok = await s.first(
        `SELECT id FROM category WHERE budget_id = ?1 AND id = ?2 AND kind != 'cc_payment'`,
        p.categoryId,
      );
      if (!ok) throw new HttpError(404, 'not_found', GONE);
    }
    set('category_id', p.categoryId ?? null);
    set('to_rta', p.toRta ? 1 : 0);
    set('categorized_by', 'user');
    set('transfer_state', null);
    if (t.wtm_state === 'waiting' && p.toRta) set('wtm_state', 'income');
    w.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key));
    edits.category_id = editAt;
  }
  if (p.split !== undefined) {
    w.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key));
    if (p.split) {
      const total = p.split.reduce((a, l) => a + l.amount, 0);
      if (total !== t.amount)
        throw new HttpError(422, 'split_total', `The lines must add up to ${formatCents(t.amount)}.`);
      p.split.forEach((l, i) =>
        w.push(
          s.q(
            `INSERT INTO txn_split (id, budget_id, txn_key, category_id, amount, memo, absorbs_remainder, sort, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
            `${key}:s${i}`,
            key,
            l.categoryId,
            l.amount,
            l.memo,
            l.absorbsRemainder ? 1 : 0,
            i,
            now,
          ),
        ),
      );
      set('category_id', null);
      set('categorized_by', 'user');
    }
    edits.split = editAt;
  }
  if (p.memo !== undefined) set('memo', p.memo);
  if (p.estimatedAmount !== undefined) {
    if (t.status !== 'pending' || t.source !== 'bank')
      throw new HttpError(422, 'not_pending', 'Only a pending bank charge can have an estimate.');
    set('estimated_amount', p.estimatedAmount);
    edits.estimated_amount = editAt;
  }
  if (p.amount !== undefined) {
    if (t.source !== 'manual')
      throw new HttpError(422, 'not_manual', 'You can change the amount only on a transaction you added.');
    if (p.amount === 0) throw new HttpError(422, 'zero_amount', 'Enter an amount.');
    w.push(
      s.q(
        `UPDATE manual_pending SET amount = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        p.amount,
        now,
      ),
      // A new amount that no longer fits the bank row it covers ends the cover (docs/payee-names.md 9.2).
      ...(await coverAfterAmount(s, key, p.amount, now)),
    );
    edits.amount = editAt;
  }
  if (p.wontClear !== undefined) {
    // Only something not posted yet can fail to clear: a posted charge always counts.
    if (p.wontClear && t.status === 'posted')
      throw new HttpError(422, 'posted', 'This has posted, so it can’t be marked won’t clear.');
    set('wont_clear', p.wontClear ? 1 : 0);
  }
  if (p.budgetMonth !== undefined) set('budget_month', p.budgetMonth);
  if (p.payeeName !== undefined) {
    // A name you typed is yours: sync never renames it, and the payee gets the key of that name
    // (docs/payee-names.md 4, 6).
    if (t.payee_id)
      w.push(
        s.q(
          `UPDATE payee SET name = ?3, named_by = 'user', updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
          t.payee_id,
          p.payeeName,
          now,
        ),
        claimName(s, t.payee_id, p.payeeName, now),
      );
    else if (t.source === 'manual')
      w.push(
        s.q(
          `UPDATE manual_pending SET payee_name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
          key,
          p.payeeName,
          now,
        ),
      );
  }
  if (p.markOwed !== undefined) {
    if (p.markOwed === null) {
      w.push(
        s.q(
          `UPDATE expected_reimbursement SET canceled_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2 AND canceled_at IS NULL`,
          key,
          now,
        ),
      );
    } else {
      if (t.amount >= 0) throw new HttpError(422, 'not_outflow', 'Only money going out can be owed to you.');
      const x = cents(-t.amount);
      const m = p.markOwed;
      const [num, den] =
        m.mode === 'half'
          ? [1, 2]
          : m.mode === 'even'
            ? [(m.n ?? 2) - 1, m.n ?? 2]
            : m.mode === 'all'
              ? [1, 1]
              : m.mode === 'fraction'
                ? [m.num ?? 1, m.den ?? 2]
                : [null, null];
      const amount = num !== null && den ? fractionOf(x, num, den) : cents(Math.min(m.amount ?? 0, x));
      if (amount <= 0) throw new HttpError(422, 'invalid', 'Enter how much is owed to you.');
      w.push(
        s.q(
          `INSERT INTO expected_reimbursement (id, budget_id, txn_key, amount, fraction_num, fraction_den, expect_by, created_at, updated_at)
           VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
           ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, fraction_num = excluded.fraction_num, fraction_den = excluded.fraction_den,
             expect_by = excluded.expect_by, canceled_at = NULL, closed_at = NULL, updated_at = excluded.updated_at`,
          `${key}:owed`,
          key,
          amount,
          num,
          den,
          m.expectBy,
          now,
        ),
      );
    }
  }
  if (Object.keys(edits).length) {
    w.push(
      s.q(
        `UPDATE txn_overlay SET field_edits = json_patch(coalesce(field_edits, '{}'), ?3) WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        JSON.stringify(edits),
      ),
    );
  }
  w.push(s.audit('txn.edit', 'transaction', key, null, p, now));
  return c.json(await commit(c, w));
});

transactionRoutes.post('/transactions/categorize', async (c) => {
  const r = await parse(CategorizeRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  if (r.categoryId) {
    const ok = await s.first(
      `SELECT id FROM category WHERE budget_id = ?1 AND id = ?2 AND kind != 'cc_payment' AND archived_at IS NULL`,
      r.categoryId,
    );
    if (!ok) throw new HttpError(404, 'not_found', GONE);
  }
  if (r.toRta) {
    // Only money in can go to Ready to Assign.
    for (const k of chunks(r.keys)) {
      const ph = k.map((_, i) => `?${i + 2}`).join(',');
      const out = await s.first(
        `SELECT 1 FROM bank_txn WHERE budget_id = ?1 AND txn_key IN (${ph}) AND amount < 0 AND removed_at IS NULL
         UNION ALL SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key IN (${ph}) AND amount < 0 LIMIT 1`,
        ...k,
      );
      if (out) throw new HttpError(422, 'not_inflow', 'Only money coming in can go to Ready to Assign.');
    }
  }
  for (const ids of chunks(r.keys)) {
    const rows = await s.all<TxRow>(
      `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND key IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
      ...ids,
    );
    rows.forEach(refuseHistory);
  }
  const w: Stmt[] = [];
  for (const key of r.keys) {
    w.push(
      s.q(OVERLAY_UPSERT, key, now),
      s.q(
        `UPDATE txn_overlay SET category_id = ?3, to_rta = ?4, categorized_by = 'user', transfer_state = NULL, updated_at = ?5,
           wtm_state = CASE WHEN wtm_state = 'waiting' AND ?4 = 1 THEN 'income' ELSE wtm_state END,
           field_edits = json_patch(coalesce(field_edits, '{}'), json_object('category_id', ?5))
         WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        r.categoryId,
        r.toRta ? 1 : 0,
        now,
      ),
      s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key),
    );
  }
  w.push(s.audit('txn.categorize', 'transaction', null, null, r, now));
  return c.json(await commit(c, w));
});

transactionRoutes.post('/transactions', async (c) => {
  const r = await parse(NewTxnRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
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
  const key = `m:${ulid(now)}`;
  const w = [
    // An entry for a closed account opens it again (D-73).
    ...reopenStmts(s, r.accountId, now),
    s.q(
      `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      ulid(now),
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
});

transactionRoutes.post('/transactions/:key/pending', async (c) => {
  const r = await parse(PendingCheckAction, c.req.raw);
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const m = await s.first<{ date: string }>(
    `SELECT date FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
    key,
  );
  if (!m) throw new HttpError(404, 'not_found', GONE);
  const b = await s.first<{ time_zone: string }>(`SELECT time_zone FROM budget WHERE id = ?1`);
  const today = localDate(now, b?.time_zone ?? 'America/Los_Angeles');
  const w =
    r.action === 'keep_waiting'
      ? [
          s.q(
            `UPDATE manual_pending SET stale_snooze_until = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
            key,
            addDays(today, 14),
            now,
          ),
        ]
      : [
          s.q(
            `UPDATE manual_pending SET deleted_at = ?3, covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
            key,
            now,
          ),
          cancelOwed(s, key, now),
        ];
  w.push(s.audit(`pending.${r.action}`, 'transaction', key, null, null, now));
  return c.json(await commit(c, w));
});

transactionRoutes.delete('/transactions/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const m = await s.first(
    `SELECT id FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
    key,
  );
  if (!m)
    throw new HttpError(422, 'bank_row', 'Bank transactions can’t be deleted. Mark it won’t clear instead.');
  return c.json(
    await commit(c, [
      s.q(
        `UPDATE manual_pending SET deleted_at = ?3, covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
      cancelOwed(s, key, now),
      s.audit('txn.delete', 'transaction', key, null, null, now),
    ]),
  );
});

transactionRoutes.post('/transactions/:key/review', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const o = await s.first(`SELECT 1 FROM txn_overlay WHERE budget_id = ?1 AND txn_key = ?2`, key);
  if (!o) throw new HttpError(404, 'not_found', GONE);
  const w = [
    s.q(
      `UPDATE txn_overlay SET reviewed_at = ?3, alert = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    s.audit('txn.review', 'transaction', key, null, null, now),
  ];
  return c.json(await commit(c, w));
});

/**
 * A deleted entry takes what was owed to you on it along: the purchase is gone, so nothing is out with others
 * (Owed to you, net worth). What was already closed stays as it was.
 */
function cancelOwed(s: Scoped, key: string, now: number): Stmt {
  return s.q(
    `UPDATE expected_reimbursement SET canceled_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2 AND canceled_at IS NULL AND closed_at IS NULL`,
    key,
    now,
  );
}

/** Which share the sheet shows as picked: a fraction of the amount (half, all) or a fixed amount. */
function owedShare(
  r: { fraction_num: number | null; fraction_den: number | null } | undefined,
): 'half' | 'all' | 'custom' {
  if (!r || r.fraction_num === null || !r.fraction_den) return 'custom';
  if (r.fraction_num * 2 === r.fraction_den) return 'half';
  if (r.fraction_num === r.fraction_den) return 'all';
  return 'custom';
}
