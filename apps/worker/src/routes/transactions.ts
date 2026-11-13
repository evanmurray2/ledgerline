// Every edit to one transaction's overlay: categorize, check pending, delete, review. The sheet is in txn-sheet.ts,
// adding one in new-txn.ts.
import type { Stmt } from '@ledgerline/db/sql';
import { editNow } from '../http/clock.js';
import { Hono } from 'hono';
import { CategorizeRequest, PendingCheckAction, TxnPatch } from '@ledgerline/contracts';
import { addDays, cents, formatCents, localDate } from '@ledgerline/domain';

import type { AppEnv } from '../http/context.js';
import type { Scoped } from '../db/scoped.js';
import { HttpError, parse, scoped, GONE, FAR_MONTH, inReach, thisMonth } from './api.js';
import { reopenForEntry, reopenStmts } from './account-close.js';
import { TX_COLUMNS, chunks, type TxRow } from '../ledger/ledger.js';
import { OVERLAY_UPSERT, commit, loadTx, owedStmt, refuseHistory } from './txn-common.js';
import { claimName } from '../sync/payee-keys.js';
import { coverAfterAmount } from './same-purchase.js';
import { txnSheet } from './txn-sheet.js';
import { addTxn } from './new-txn.js';

export const transactionRoutes = new Hono<AppEnv>();

/** The key a transaction has now: an edit made to a key that has since moved lands on the new one. */
export async function liveKey(s: Scoped, key: string): Promise<string> {
  let k = key;
  for (let i = 0; i < 4; i++) {
    const here = await s.first(
      `SELECT 1 AS x FROM bank_txn WHERE budget_id = ?1 AND txn_key = ?2 AND removed_at IS NULL
       UNION ALL SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
      k,
    );
    if (here) return k;
    const m = await s.db
      .prepare(`SELECT new_key FROM txn_key_move WHERE old_key = ?1`)
      .bind(k)
      .first<{ new_key: string }>();
    if (!m) return k;
    k = m.new_key;
  }
  return k;
}

transactionRoutes.get('/transactions/:key', txnSheet);

transactionRoutes.patch('/transactions/:key', async (c) => {
  const p = await parse(TxnPatch, c.req.raw);
  const s = scoped(c);
  const key = await liveKey(s, c.req.param('key'));
  const t = await loadTx(s, key);
  refuseHistory(t);
  const now = editNow(c);
  // Most-recent-edit-wins uses when the edit was made, which for an offline edit is before it arrives: `now` is
  // already that time (http/clock.ts editNow).
  const editAt = now;
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
    w.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key));
    if (p.split === undefined) w.push(dropSplitOwed(s, key, [], now));
    edits.category_id = editAt;
  }
  if (p.split !== undefined) {
    w.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key));
    const owedIds: string[] = [];
    if (p.split) {
      const total = p.split.reduce((a, l) => a + l.amount, 0);
      if (total !== (p.amount ?? t.amount))
        throw new HttpError(
          422,
          'split_total',
          `The lines must add up to ${formatCents(p.amount ?? t.amount)}.`,
        );
      p.split.forEach((l, i) => {
        const lineId = `${key}:s${i}`;
        // A line owed to you has no category: an owed item of its amount takes it out of Ready to Assign until
        // it is paid back (rule 11, as for a whole purchase marked owed).
        const owed = !!l.owed && l.amount < 0;
        if (l.owed && l.amount > 0)
          throw new HttpError(422, 'not_outflow', 'Only money going out can be owed to you.');
        w.push(
          s.q(
            `INSERT INTO txn_split (id, budget_id, txn_key, category_id, amount, memo, absorbs_remainder, sort, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
            lineId,
            key,
            owed ? null : l.categoryId,
            l.amount,
            l.memo,
            l.absorbsRemainder ? 1 : 0,
            i,
            now,
          ),
        );
        if (owed) {
          owedIds.push(lineId);
          w.push(
            s.q(
              `INSERT INTO expected_reimbursement (id, budget_id, txn_key, split_id, amount, created_at, updated_at)
               VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?6)
               ON CONFLICT (id) DO UPDATE SET split_id = excluded.split_id, amount = excluded.amount, canceled_at = NULL,
                 updated_at = excluded.updated_at`,
              `${key}:owed:s${i}`,
              key,
              lineId,
              -l.amount,
              now,
            ),
          );
        }
      });
      set('category_id', null);
      set('categorized_by', 'user');
    }
    w.push(dropSplitOwed(s, key, owedIds, now));
    edits.split = editAt;
  }
  if (p.memo !== undefined) set('memo', p.memo);
  if (p.estimatedAmount !== undefined) {
    if (t.status !== 'pending' || t.source !== 'bank')
      throw new HttpError(422, 'not_pending', 'Only a pending bank charge can have an estimate.');
    if (p.estimatedAmount === 0) throw new HttpError(422, 'zero_amount', 'Enter an estimate above $0.00.');
    set('estimated_amount', p.estimatedAmount);
    // A pending row that stayed in a closed account no longer adds up to $0 there (D-93).
    w.push(...reopenStmts(s, t.account_id, now));
    edits.estimated_amount = editAt;
  }
  if (p.amount !== undefined) {
    if (t.source !== 'manual')
      throw new HttpError(422, 'not_manual', 'You can change the amount only on a transaction you added.');
    if (p.amount === 0) throw new HttpError(422, 'zero_amount', 'Enter an amount.');
    // Money in you added can pay back what's owed to you: it can't come to less than it pays back (rule 12).
    if (p.amount > 0 && t.amount > 0) {
      const paid = await s.first<{ n: number }>(
        `SELECT coalesce(sum(amount), 0) AS n FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL`,
        key,
      );
      if (paid && paid.n > p.amount)
        throw new HttpError(
          422,
          'too_little',
          `This pays back ${formatCents(cents(paid.n))}. Undo the match first, then lower the amount.`,
        );
    }
    // Out to In or back: what only fits the old direction goes with it.
    if (p.amount < 0 !== t.amount < 0) w.push(...(await flipStmts(s, t, p, now)));
    w.push(
      s.q(
        `UPDATE manual_pending SET amount = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        p.amount,
        now,
      ),
      // A new amount that no longer fits the bank row it covers ends the cover (docs/payee-names.md 9.2).
      ...(await coverAfterAmount(s, key, p.amount, now)),
      // An entry that stayed in a closed account no longer adds up to $0 there (D-93).
      ...reopenForEntry(s, key, now),
    );
    edits.amount = editAt;
  }
  if (p.wontClear !== undefined) {
    // Only something not posted yet can fail to clear: a posted charge always counts.
    if (p.wontClear && t.status === 'posted')
      throw new HttpError(422, 'posted', 'This has posted, so it can’t be marked won’t clear.');
    set('wont_clear', p.wontClear ? 1 : 0);
    w.push(...reopenStmts(s, t.account_id, now));
  }
  if (p.budgetMonth !== undefined) {
    if (p.budgetMonth !== null && !inReach(p.budgetMonth, await thisMonth(s, now)))
      throw new HttpError(422, 'too_far', FAR_MONTH);
    set('budget_month', p.budgetMonth);
  }
  if (p.payeeName !== undefined) {
    // A transfer has no payee (D-107).
    if (t.transfer_state === 'paired' || t.transfer_state === 'manual')
      throw new HttpError(422, 'invalid', 'A transfer has no payee.');
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
      w.push(owedStmt(s, key, p.amount ?? t.amount, p.markOwed, now));
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
  const now = editNow(c);
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
        `SELECT 1 FROM bank_txn WHERE +budget_id = ?1 AND txn_key IN (${ph}) AND amount < 0 AND removed_at IS NULL
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
           field_edits = json_patch(coalesce(field_edits, '{}'), json_object('category_id', ?5))
         WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        r.categoryId,
        r.toRta ? 1 : 0,
        now,
      ),
      s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, key),
      dropSplitOwed(s, key, [], now),
    );
  }
  w.push(s.audit('txn.categorize', 'transaction', null, null, r, now));
  return c.json(await commit(c, w));
});

transactionRoutes.post('/transactions', addTxn);

transactionRoutes.post('/transactions/:key/pending', async (c) => {
  const r = await parse(PendingCheckAction, c.req.raw);
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
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
          undoPaybacks(s, key, now),
          s.q(
            `UPDATE manual_pending SET deleted_at = ?3, covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
            key,
            now,
          ),
          cancelOwed(s, key, now),
          ...reopenForEntry(s, key, now),
        ];
  w.push(s.audit(`pending.${r.action}`, 'transaction', key, null, null, now));
  return c.json(await commit(c, w));
});

transactionRoutes.delete('/transactions/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
  const m = await s.first(
    `SELECT id FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
    key,
  );
  if (!m)
    throw new HttpError(422, 'bank_row', 'Bank transactions can’t be deleted. Mark it won’t clear instead.');
  return c.json(
    await commit(c, [
      undoPaybacks(s, key, now),
      s.q(
        `UPDATE manual_pending SET deleted_at = ?3, covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
      cancelOwed(s, key, now),
      ...reopenForEntry(s, key, now),
      s.audit('txn.delete', 'transaction', key, null, null, now),
    ]),
  );
});

transactionRoutes.post('/transactions/:key/review', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
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
 * Your entry changes direction (Out to In, or In to Out). A split and what's owed to you were made for the old
 * direction, so they go; money out can't stay in Ready to Assign. A transfer or a match is undone first, by you.
 */
async function flipStmts(
  s: Scoped,
  t: TxRow,
  p: { amount?: number | undefined; split?: unknown },
  now: number,
): Promise<Stmt[]> {
  const linked = await s.first(
    `SELECT 1 FROM txn_link WHERE budget_id = ?1 AND undone_at IS NULL AND kind IN ('reimbursement_of', 'refund_of')
       AND (from_key = ?2 OR to_key = ?2 OR to_key IN (SELECT id FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2))
     LIMIT 1`,
    t.key,
  );
  if (t.transfer_state === 'paired' || linked)
    throw new HttpError(
      422,
      'linked',
      t.transfer_state === 'paired'
        ? 'This is a transfer. Undo the transfer first, then change Out or In.'
        : 'This is matched to another transaction. Undo the match first, then change Out or In.',
    );
  const w: Stmt[] = [cancelOwed(s, t.key, now)];
  // A split sent with the flip is for the new amount: it stays.
  if (!p.split) w.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, t.key));
  w.push(
    s.q(
      `UPDATE txn_overlay SET wtm_state = NULL, to_rta = CASE WHEN ?3 < 0 THEN 0 ELSE to_rta END, updated_at = ?4
       WHERE budget_id = ?1 AND txn_key = ?2`,
      t.key,
      p.amount ?? 0,
      now,
    ),
  );
  return w;
}

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

/**
 * A deleted entry pays back nothing: what it was matched to is owed again (rule 12). Run before the entry is marked
 * deleted. A bank row that took the entry's key keeps its matches: only an entry still on its own is touched.
 */
function undoPaybacks(s: Scoped, key: string, now: number): Stmt {
  return s.q(
    `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL
       AND EXISTS (SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL AND matched_txn_key IS NULL)`,
    key,
    now,
  );
}

/**
 * Removes the mark from split lines no longer owed to you (the split changed or went away): an owed item for a line
 * that isn't there would take its amount out of Ready to Assign a second time.
 */
export function dropSplitOwed(s: Scoped, key: string, keep: readonly string[], now: number): Stmt {
  return s.q(
    `UPDATE expected_reimbursement SET canceled_at = ?3, updated_at = ?3
     WHERE budget_id = ?1 AND txn_key = ?2 AND split_id IS NOT NULL AND canceled_at IS NULL
       AND split_id NOT IN (SELECT value FROM json_each(?4))`,
    key,
    now,
    JSON.stringify(keep),
  );
}
