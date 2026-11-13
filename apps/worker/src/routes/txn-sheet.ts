// The transaction sheet (GET /api/transactions/:key): what one transaction is, how it counts and what it is linked to.
// Split from transactions.ts, which keeps the edits.
import type { Context } from 'hono';
import type { TxnSheet } from '@ledgerline/contracts';
import { type Month, cents, formatCents, localDate, monthOfDate, owedList } from '@ledgerline/domain';

import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { scoped } from './api.js';
import { shortDate } from '../views/common.js';
import { categoryLabel, isHistory, listRow, transferName } from '../views/rows.js';
import { txnCol } from '../ledger/ledger.js';
import { linkInfo, roleOf } from '../ledger/link.js';
import { loadTx, names } from './txn-common.js';
import { pairedWith } from './same-purchase.js';
import { canPick, transferCandidates } from './transfers.js';

export async function txnSheet(c: Context<AppEnv, '/transactions/:key'>) {
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
      `SELECT id, split_id, amount, fraction_num, fraction_den, expect_by, closed_at, canceled_at FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2`,
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
      `SELECT l.to_key, coalesce(${txnCol('l.to_key', 'payee')}, '') AS label, ${txnCol('l.to_key', 'date')} AS date,
         ${txnCol('l.to_key', 'category_id')} AS category_id,
         EXISTS (SELECT 1 FROM txn_split x WHERE x.budget_id = l.budget_id AND x.txn_key = l.to_key) AS split
       FROM txn_link l
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
  const allOwed = ow!.results as {
    id: string;
    split_id: string | null;
    amount: number;
    fraction_num: number | null;
    fraction_den: number | null;
    expect_by: string | null;
    closed_at: number | null;
    canceled_at: number | null;
  }[];
  // A split line owed to you shows on its line; Owed to you on the sheet is the whole purchase's mark.
  const owedRows = allOwed.filter((o) => !o.split_id);
  const owedLines = new Set(allOwed.filter((o) => o.split_id && !o.canceled_at).map((o) => o.split_id!));
  const zone = (bz!.results[0] as { time_zone: string } | undefined)?.time_zone ?? 'America/Los_Angeles';
  const today = localDate(editNow(c), zone);
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
  const refund =
    (rf!.results[0] as
      | { to_key: string; label: string; date: string; category_id: string | null; split: number }
      | undefined) ?? null;
  // The purchase's own category, which the refund can go back to (a split purchase has none).
  const refundCat = refund && !refund.split ? refund.category_id : null;
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
  // The lines no longer add up to the amount (it changed after the split): the gap counts as uncategorized (D-82).
  const splitTotal = splits.reduce((a, x) => a + x.amount, 0);
  if (splits.length && splitTotal !== t.amount)
    alerts.push(
      `The split adds up to ${formatCents(Math.abs(splitTotal))}, not ${formatCents(Math.abs(t.amount))}. Edit the split to fix it.`,
    );
  const ruleName = (rule!.results[0] as { name: string } | undefined)?.name;
  // A row before the budget start may be part of the starting balance rather than plain history (D-67).
  const inStart = kind === 'history' && roleOf(t, await linkInfo(s)) === 'before';
  // A transfer has no payee: the sheet names it by the other account, and offers no Rename payee (D-107).
  const xfer = transferName(t, accts);
  const sheet: TxnSheet = {
    key,
    kind,
    ...(inStart ? { inStartingBalance: true } : {}),
    ...(xfer ? { transfer: true } : {}),
    payee: xfer ?? t.payee,
    payeeId: xfer ? null : t.payee_id,
    // Your own entry's raw name is a name you typed, not the bank's: a transfer shows none.
    rawName: xfer && t.source === 'manual' ? '' : t.raw_name,
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
        ? ruleName
          ? `the rule “${ruleName}”`
          : 'a rule'
        : t.categorized_by === 'payee'
          ? 'your past choice for this payee'
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
          ...(owedLines.has(x.id) ? { owed: true } : {}),
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
    refundOf: refund
      ? {
          key: refund.to_key,
          label: refund.date ? `${refund.label} · ${shortDate(refund.date)}` : refund.label,
          categoryId: refundCat,
          categoryName: refundCat ? (cats.get(refundCat) ?? null) : null,
        }
      : null,
    pairedWith: kind === 'history' ? null : await pairedWith(s, t),
    alerts,
    // What "Which account got this money?" offers: only for a row that can still be called a transfer.
    ...(canPick(t)
      ? { candidates: (await transferCandidates(s, t)).map((x) => listRow(x, accts, cats)) }
      : {}),
  };
  return c.json(sheet);
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
