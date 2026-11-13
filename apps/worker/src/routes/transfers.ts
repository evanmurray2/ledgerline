// Transfers: which account a transfer went to or came from (Pick), and Unpair. Split from activity.ts.
import { newId } from '../http/ids.js';
import type { Stmt } from '@ledgerline/db/sql';
import { editNow } from '../http/clock.js';
import { Hono } from 'hono';
import { TransferPick } from '@ledgerline/contracts';

import type { AppEnv } from '../http/context.js';
import { CHANGED, GONE, HttpError, parse, scoped } from './api.js';
import { isHistory } from '../views/rows.js';
import { RECENT_TX, TX_COLUMNS, type TxRow } from '../ledger/ledger.js';
import { OVERLAY_UPSERT, commit, loadTx, refuseHistory } from './txn-common.js';
import { reopenForEntry } from './account-close.js';

export const transferRoutes = new Hono<AppEnv>();

transferRoutes.post('/transfers/:key/pick', async (c) => {
  const r = await parse(TransferPick, c.req.raw);
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
  const me = await loadTx(s, key);
  refuseHistory(me);
  // Any row that isn't a transfer yet can be called one, not only one filing left to sort out: a deposit whose name
  // doesn't look like a transfer is in Ready to Assign (D-85) and is never asked about. Money matched to what you're
  // owed is unlinked first. "It was income / a payment" answers a question, so it needs a row that asks one.
  const unclear = me.transfer_state === 'unsorted';
  const answers = !!r.otherKey || !!r.accountId || !!r.unlinked;
  if (
    me.amount === 0 ||
    !(unclear || (me.transfer_state === null && answers)) ||
    !(me.wtm_state === null || me.wtm_state === 'waiting' || me.wtm_state === 'income')
  )
    throw new HttpError(422, 'not_unclear', CHANGED);
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
        newId(c),
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
    const entry = `m:${newId(c)}`;
    w.push(
      s.q(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'pending', ?5, ?6, ?7, 'never', ?8, ?8)`,
        newId(c),
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
        newId(c),
        me.amount < 0 ? me.key : entry,
        me.amount < 0 ? entry : me.key,
        now,
      ),
    );
  } else if (r.unlinked) {
    // An account that isn't linked (Venmo, say): the money leaves (or enters) the budget accounts with no category,
    // so it comes out of (or goes into) Ready to Assign (D-20).
    w.push(
      s.q(OVERLAY_UPSERT, key, now),
      s.q(
        `UPDATE txn_overlay SET transfer_state = 'manual', transfer_account_id = NULL, wtm_state = NULL, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
    );
  } else {
    // Neither: a payment (or a credit on a card) needs a category. A deposit into checking or savings is income: you
    // said so, so it goes to Ready to Assign even when its name looks like a transfer (D-85).
    const income = me.amount > 0 && me.account_kind !== 'credit';
    w.push(
      s.q(
        income
          ? `UPDATE txn_overlay SET transfer_state = NULL, transfer_account_id = NULL, to_rta = 1, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`
          : // The person's own answer (D-90): filing never pairs this row again.
            `UPDATE txn_overlay SET transfer_state = NULL, transfer_account_id = NULL, categorized_by = 'user', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
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

transferRoutes.post('/transfers/:key/unpair', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = editNow(c);
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
        // Before the entry goes: one that stayed in a closed account leaves it off $0 (D-93).
        ...reopenForEntry(
          s,
          k,
          now,
          `created_at = ${Number(link.created_at)} AND matched_txn_key IS NULL AND deleted_at IS NULL`,
        ),
        s.q(
          `UPDATE manual_pending SET deleted_at = ?4, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2 AND created_at = ?3
             AND matched_txn_key IS NULL AND deleted_at IS NULL`,
          k,
          link.created_at,
          now,
        ),
      );
  w.push(s.audit('transfer.unpair', 'transaction', key, null, null, now));
  // The other side, for Undo (a pick of it pairs the two again). Not an entry the pick added: it goes with the pair.
  const undo = other && !(link && other.startsWith('m:')) ? { otherKey: other } : {};
  return c.json({ ...(await commit(c, w)), ...undo });
});
