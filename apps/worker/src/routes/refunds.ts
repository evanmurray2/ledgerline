// A card refund and the purchase it gives back (docs/design.md, Credit card refunds). Linked, the card's payment
// category gives back the funded part of that purchase (Money rule 3, packages/domain computeBudget); unlinked, as
// much as it holds up to the refund. Only you link one: nothing links a refund by itself. The link is a txn_link row
// of kind refund_of (from the refund's key to the purchase's), which the budget lines read (ledger/ledger.ts).
// D-109 (docs/decisions/D-109-refund-links.md).
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { RefundLink, type RefundCandidate, type RefundOfView } from '@ledgerline/contracts';
import { addDays, cents, type IsoDate } from '@ledgerline/domain';

import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { newId } from '../http/ids.js';
import type { Scoped } from '../db/scoped.js';
import { HttpError, parse, scoped } from './api.js';
import { RECENT_TX, TX_COLUMNS, chunks, type TxRow } from '../ledger/ledger.js';
import { categoryLabel, isHistory } from '../views/rows.js';
import { commit, loadTx, names, refuseHistory } from './txn-common.js';
import { liveKey } from './transactions.js';

export const refundRoutes = new Hono<AppEnv>();

/** How far back a purchase can be offered: the design's 90 days. */
export const REFUND_WINDOW_DAYS = 90;
/** At most this many purchases are offered, newest first. */
const MAX_CANDIDATES = 40;

const isTransfer = (t: TxRow) =>
  t.transfer_state === 'paired' || t.transfer_state === 'unsorted' || t.transfer_state === 'manual';

/** Money in on a card that can be a refund: not a transfer, not from before the budget. */
function refuseNotRefund(t: TxRow): void {
  refuseHistory(t);
  if (t.account_kind !== 'credit' || t.amount <= 0)
    throw new HttpError(422, 'not_refund', 'Only money back on a card can be a refund.');
  if (isTransfer(t))
    throw new HttpError(
      422,
      'transfer',
      'This is a transfer. Undo the transfer first, then pick the purchase.',
    );
}

/** Same payee: the same payee row, or else the same name (a manual entry has only a name). */
function samePayee(a: TxRow, b: TxRow): boolean {
  if (a.payee_id && b.payee_id) return a.payee_id === b.payee_id;
  return a.payee.trim().toLowerCase() === b.payee.trim().toLowerCase();
}

/** The refund's link in force, if any: the purchase's key. */
async function linkedPurchase(s: Scoped, key: string): Promise<string | null> {
  const r = await s.first<{ to_key: string }>(
    `SELECT to_key FROM txn_link WHERE budget_id = ?1 AND kind = 'refund_of' AND from_key = ?2 AND undone_at IS NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    key,
  );
  return r?.to_key ?? null;
}

refundRoutes.get('/transactions/:key/refund-of', async (c) => {
  const s = scoped(c);
  const t = await loadTx(s, await liveKey(s, c.req.param('key')));
  refuseNotRefund(t);
  const rows = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1 AND account_id = ?2 AND amount < 0 AND key != ?3
       AND date >= ?4 AND date <= ?5 AND status != 'upcoming' AND wont_clear = 0
     ORDER BY date DESC, seq DESC LIMIT ${MAX_CANDIDATES}`,
    t.account_id,
    t.key,
    addDays(t.date as IsoDate, -REFUND_WINDOW_DAYS),
    t.date,
  );
  const picks = rows.filter((p) => !isHistory(p) && !isTransfer(p));
  const split = new Set<string>();
  for (const k of chunks(picks.map((p) => p.key))) {
    const r = await s.all<{ txn_key: string }>(
      `SELECT DISTINCT txn_key FROM txn_split WHERE budget_id = ?1 AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
      ...k,
    );
    for (const x of r) split.add(x.txn_key);
  }
  const { cats } = await names(s);
  const row = (p: TxRow): RefundCandidate => ({
    key: p.key,
    payee: p.payee,
    date: p.date,
    amount: cents(p.amount),
    categoryLabel: categoryLabel(p, cats, split.has(p.key)),
  });
  const view: RefundOfView = {
    suggested: picks.filter((p) => samePayee(p, t)).map(row),
    others: picks.filter((p) => !samePayee(p, t)).map(row),
  };
  return c.json(view);
});

refundRoutes.post('/transactions/:key/refund-of', async (c) => {
  const r = await parse(RefundLink, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const key = await liveKey(s, c.req.param('key'));
  const t = await loadTx(s, key);
  refuseNotRefund(t);
  const was = await linkedPurchase(s, key);
  // "Not this purchase" on a refund that has no link (sent twice, or from another device): nothing to do.
  if (r.purchaseKey === null && was === null) return c.json(await commit(c, []));
  const w: Stmt[] = [];
  let to: string | null = null;
  if (r.purchaseKey !== null) {
    to = await liveKey(s, r.purchaseKey);
    if (to === was) return c.json(await commit(c, []));
    // Money in that pays back what's owed to you is in Ready to Assign: it can't also be a refund (rule 3, rule 12).
    const pays = await s.first(
      `SELECT 1 FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND from_key = ?2 AND undone_at IS NULL LIMIT 1`,
      key,
    );
    if (pays)
      throw new HttpError(
        422,
        'linked',
        'This pays back what’s owed to you. Undo the match first, then pick the purchase.',
      );
    const p = await loadTx(s, to);
    if (p.key === t.key || p.account_id !== t.account_id || p.amount >= 0 || isTransfer(p))
      throw new HttpError(422, 'not_purchase', 'Pick a purchase on the same card.');
    if (isHistory(p) || p.status === 'upcoming')
      throw new HttpError(422, 'not_purchase', 'Pick a purchase from your budget that has happened.');
  }
  // One purchase per refund: a new pick replaces the old link.
  if (was !== null)
    w.push(
      s.q(
        `UPDATE txn_link SET undone_at = ?3 WHERE budget_id = ?1 AND kind = 'refund_of' AND from_key = ?2 AND undone_at IS NULL`,
        key,
        now,
      ),
    );
  if (to !== null)
    w.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'refund_of', ?3, ?4, 'user', ?5)`,
        newId(c),
        key,
        to,
        now,
      ),
    );
  w.push(s.audit(to ? 'refund.link' : 'refund.unlink', 'transaction', key, was, to, now));
  return c.json(await commit(c, w));
});
