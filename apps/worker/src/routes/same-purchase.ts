// "Same purchase?" (docs/payee-names.md 9.1): the cards on Activity's Needs attention, Yes and No, and Not the same on
// a transaction's sheet. Yes pairs the rows exactly as processing would (sync/pairing.ts); No and Not the same
// remember the answer in not_same, so the pair is never asked about or paired again. Each change to bank rows' keys
// runs behind the processing watermark fence, as processing does, so the two never pair a row twice.
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { SamePurchaseAnswer, type ActivityView, type TxnSheet } from '@ledgerline/contracts';
import { cents, entryCandidate, formatCents } from '@ledgerline/domain';
import { editNow } from '../http/clock.js';
import { newId } from '../http/ids.js';
import type { AppEnv } from '../http/context.js';
import type { Scoped } from '../db/scoped.js';
import { ACK, CHANGED, HttpError, parse, scoped } from './api.js';
import { COVERING, TX_COLUMNS, chunks, uncovered, type TxRow } from '../ledger/ledger.js';
import { listRow, isHistory } from '../views/rows.js';
import { shortDate } from '../views/common.js';
import { conditionFence, isFenceAbort } from '../sync/lease.js';
import {
  ASK_TYPES,
  ackAsks,
  coverStmts,
  inheritStmts,
  loadNotSame,
  matchEntryOverStmts,
  matchEntryStmts,
  notSameStmt,
  ownKeyStmt,
  type Entry,
} from '../sync/pairing.js';
import { channel } from '../sync/pending-match.js';
import { loadBankRows } from '../sync/bank-rows.js';
import { planFresh } from '../sync/file-fresh.js';

export const samePurchaseRoutes = new Hono<AppEnv>();

interface AskRow {
  id: string;
  type: string;
  ref_key: string;
  data: string | null;
}

const candidatesOf = (a: AskRow): string[] =>
  ((a.data ? JSON.parse(a.data) : {}) as { candidates?: string[] }).candidates ?? [];

/**
 * The open "Same purchase?" cards, checked against the rows as they are now: a row that has paired since, or went
 * away, drops out, and so does a candidate you said No to or an entry that covers another row.
 */
export async function samePurchaseCards(
  s: Scoped,
  accts: ReadonlyMap<string, string>,
  cats: ReadonlyMap<string, string>,
): Promise<ActivityView['samePurchase']> {
  const asks = await s.all<AskRow>(
    `SELECT id, type, ref_key, data FROM alert WHERE budget_id = ?1 AND acked_at IS NULL AND type IN ${ASK_TYPES}
     ORDER BY created_at, id`,
  );
  if (!asks.length) return [];
  const keys = [...new Set(asks.flatMap((a) => [a.ref_key, ...candidatesOf(a)]))];
  const rows = new Map<string, TxRow>();
  const busy = new Set<string>();
  for (const k of chunks(keys)) {
    const ph = k.map((_, i) => `?${i + 2}`).join(',');
    const [t, b] = await s.batch([
      s.q(
        `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND key IN (${ph}) AND ${uncovered('v_transaction')}`,
        ...k,
      ),
      // Entries already covering a bank row: answering Yes for another pending row would leave the first uncovered.
      // (A posted row may take one: the row it covers is claimed with it.)
      s.q(
        `SELECT m.txn_key FROM manual_pending m WHERE m.budget_id = ?1 AND m.txn_key IN (${ph}) AND ${COVERING('m')}`,
        ...k,
      ),
    ]);
    for (const r of t!.results as TxRow[]) rows.set(r.key, r);
    for (const r of b!.results as { txn_key: string }[]) busy.add(r.txn_key);
  }
  const notSame = await loadNotSame(s);
  const out: ActivityView['samePurchase'] = [];
  for (const a of asks) {
    const ref = rows.get(a.ref_key);
    if (!ref || isHistory(ref)) continue;
    // A candidate that has paired since (its key now a posted row's) drops out.
    const cands = candidatesOf(a)
      .map((k) => rows.get(k))
      .filter(
        (r): r is TxRow =>
          !!r &&
          r.status !== 'posted' &&
          !(ref.status === 'pending' && busy.has(r.key)) &&
          !notSame(a.ref_key, r.key),
      );
    if (!cands.length) continue;
    out.push({
      id: a.id,
      row: listRow(ref, accts, cats),
      candidates: cands.map((r) => listRow(r, accts, cats)),
    });
  }
  return out;
}

export interface BankDb {
  provider_txn_id: string;
  txn_key: string;
  pending: number;
  amount: number;
  estimated_amount: number | null;
  /** A posted row has its key (the pending row is done). */
  claimed: number;
}

export const BANK_SQL = `SELECT b.provider_txn_id, b.txn_key, b.pending, b.amount, o.estimated_amount,
    EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL
      AND x.provider_txn_id != b.provider_txn_id) AS claimed
  FROM bank_txn b LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
  WHERE b.budget_id = ?1 AND b.removed_at IS NULL`;

export interface EntryDb extends Entry {
  account_id: string;
  date: string;
  payee_name: string;
  covering: number;
}

export const ENTRY_SQL = `SELECT m.txn_key, m.amount, m.covers_provider_txn_id, m.account_id, m.date, m.payee_name,
    (${COVERING('m')}) AS covering
  FROM manual_pending m WHERE m.budget_id = ?1 AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL
    AND m.kind IN ('pending', 'upcoming')`;

export const changed = () => new HttpError(409, 'changed', CHANGED);

/** Runs writes that move bank rows' keys behind the processing watermark, as processing does. */
export async function fenced(s: Scoped, stmts: Stmt[]): Promise<void> {
  const b = await s.first<{ processed_through: number }>(
    `SELECT processed_through FROM budget WHERE id = ?1`,
  );
  try {
    await s.batch([
      conditionFence(
        s.db,
        `SELECT processed_through = ?1 FROM budget WHERE id = ?2`,
        b?.processed_through ?? 0,
        s.budgetId,
      ),
      ...stmts,
    ]);
  } catch (e) {
    if (isFenceAbort(e)) throw changed();
    throw e;
  }
}

/** Yes or No for one candidate of a card. */
samePurchaseRoutes.post('/same-purchase/:id', async (c) => {
  const r = await parse(SamePurchaseAnswer, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const a = await s.first<AskRow>(
    `SELECT id, type, ref_key, data FROM alert WHERE budget_id = ?1 AND id = ?2 AND acked_at IS NULL AND type IN ${ASK_TYPES}`,
    c.req.param('id'),
  );
  if (!a) throw changed();
  const cands = candidatesOf(a);
  if (!cands.includes(r.key)) throw new HttpError(422, 'invalid', CHANGED);
  if (r.answer === 'no') {
    const left = cands.filter((k) => k !== r.key);
    await s.batch([
      notSameStmt(s, a.ref_key, r.key, now),
      left.length
        ? s.q(
            `UPDATE alert SET data = ?3 WHERE budget_id = ?1 AND id = ?2`,
            a.id,
            JSON.stringify({ candidates: left }),
          )
        : s.q(`UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND id = ?2`, a.id, now),
      s.audit('same_purchase.no', 'transaction', a.ref_key, null, { key: r.key }, now),
    ]);
    return c.json(ACK);
  }
  const entry = await s.first<EntryDb>(`${ENTRY_SQL} AND m.txn_key = ?2`, r.key);
  const stmts: Stmt[] = [];
  // Yes about a posted row that holds a bank pending row's key (D-92): your entry takes the pair.
  const holder = await s.first<{ provider_txn_id: string; amount: number }>(
    `SELECT provider_txn_id, amount FROM bank_txn
     WHERE budget_id = ?1 AND txn_key = ?2 AND pending = 0 AND removed_at IS NULL AND provider_txn_id != ?3`,
    a.ref_key,
    a.ref_key.slice(2),
  );
  // Otherwise the card's row is a bank row (its own key); the candidate an entry or a bank pending row.
  const ref = holder
    ? null
    : await s.first<BankDb>(`${BANK_SQL} AND b.provider_txn_id = ?2`, a.ref_key.slice(2));
  if (holder) {
    if (!entry || entry.covering) throw changed();
    stmts.push(
      ...matchEntryOverStmts(
        s,
        holder.provider_txn_id,
        a.ref_key,
        entry,
        holder.amount,
        'user',
        now,
        newId(c),
      ),
    );
  } else if (!ref || ref.claimed || (ref.pending === 0 && ref.txn_key !== a.ref_key)) throw changed();
  else if (entry) {
    if (ref.pending === 1) {
      if (entry.covering && entry.covers_provider_txn_id !== ref.provider_txn_id) throw changed();
      const covered = await s.first(
        `SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND covers_provider_txn_id = ?2 AND deleted_at IS NULL AND matched_txn_key IS NULL`,
        ref.provider_txn_id,
      );
      if (covered) throw changed();
      stmts.push(...coverStmts(s, entry.txn_key, ref.provider_txn_id, now));
    } else stmts.push(...matchEntryStmts(s, ref.provider_txn_id, entry, ref.amount, 'user', now, newId(c)));
  } else {
    // Another bank row: only a posted row can claim a pending one (several close candidates, ambiguous_match).
    const p = await s.first<BankDb>(`${BANK_SQL} AND b.txn_key = ?2 AND b.pending = 1`, r.key);
    if (ref.pending === 1 || !p || p.claimed) throw changed();
    const cover = await s.first<EntryDb>(`${ENTRY_SQL} AND m.covers_provider_txn_id = ?2`, p.provider_txn_id);
    if (cover)
      stmts.push(...matchEntryStmts(s, ref.provider_txn_id, cover, ref.amount, 'user', now, newId(c)));
    else
      stmts.push(
        ...inheritStmts(
          s,
          ref.provider_txn_id,
          p.txn_key,
          'user',
          ref.amount,
          p.estimated_amount ?? p.amount,
          now,
          newId(c),
        ),
      );
  }
  stmts.push(
    s.q(`UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND id = ?2`, a.id, now),
    s.audit('same_purchase.yes', 'transaction', a.ref_key, null, { key: r.key }, now),
  );
  await fenced(s, stmts);
  return c.json(ACK);
});

/**
 * The other row of a pair, for the sheet: your entry and a bank row, or a posted row and the bank pending row whose
 * key it took. Null when there's none, or when the provider linked them.
 */
export async function pairedWith(s: Scoped, t: TxRow): Promise<TxnSheet['pairedWith']> {
  if (t.source === 'manual') {
    const b = await s.first<{ payee: string; date: string; amount: number }>(
      `SELECT coalesce(b.merchant_name, b.plaid_name, b.raw_name) AS payee, b.date, b.amount
       FROM manual_pending m JOIN bank_txn b ON b.budget_id = m.budget_id AND b.provider_txn_id = m.covers_provider_txn_id
       WHERE m.budget_id = ?1 AND m.txn_key = ?2 AND ${COVERING('m')}`,
      t.key,
    );
    // The bank's own amount: your entry's can differ (a tip), and the bank's wins when it posts.
    return b
      ? { label: `Bank pending: ${b.payee} · ${shortDate(b.date)} · ${formatCents(Math.abs(b.amount))}` }
      : null;
  }
  if (t.status !== 'posted') return null;
  const m = await s.first<{ payee_name: string; date: string }>(
    `SELECT payee_name, date FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND matched_txn_key = ?2 AND deleted_at IS NULL`,
    t.key,
  );
  if (m) return { label: `Your entry: ${m.payee_name} · ${shortDate(m.date)}` };
  // A pair the provider linked isn't offered: its link wins (D-47), and the next sync would pair them again.
  const b = await bankPair(s, t.key);
  if (!b || b.byProvider) return null;
  return { label: `Bank pending: ${b.pending.payee} · ${shortDate(b.pending.date)}` };
}

/**
 * A posted row that took over a bank pending row's key (`key`), paired by the app (D-47, D-65) or by your Yes, or
 * by the provider's link (`byProvider`). Null when the key holds anything else: the posted row's own key, your
 * entry's (that pair is undone above), or a removed posted row's (a re-issue).
 */
async function bankPair(
  s: Scoped,
  key: string,
): Promise<{
  postedId: string;
  pending: { provider_txn_id: string; payee: string; date: string };
  byProvider: boolean;
} | null> {
  const q = await s.first<{ provider_txn_id: string; pending_provider_txn_id: string | null }>(
    `SELECT provider_txn_id, pending_provider_txn_id FROM bank_txn
     WHERE budget_id = ?1 AND txn_key = ?2 AND pending = 0 AND removed_at IS NULL`,
    key,
  );
  if (!q || key === `p:${q.provider_txn_id}`) return null;
  const [others, links, entries] = await s.batch([
    s.q(
      `SELECT provider_txn_id, pending, coalesce(merchant_name, plaid_name, raw_name) AS payee, date FROM bank_txn
       WHERE budget_id = ?1 AND txn_key = ?2 AND provider_txn_id != ?3 ORDER BY date, provider_txn_id`,
      key,
      q.provider_txn_id,
    ),
    s.q(
      `SELECT created_by FROM txn_link WHERE budget_id = ?1 AND kind = 'pending_match' AND from_key = ?2 AND to_key = ?3
         AND undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
      `p:${q.provider_txn_id}`,
      key,
    ),
    s.q(`SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2`, key),
  ]);
  const rows = others!.results as { provider_txn_id: string; pending: number; payee: string; date: string }[];
  const link = (links!.results as { created_by: string }[])[0];
  if (!link || entries!.results.length || !rows.length || rows.some((r) => r.pending !== 1)) return null;
  return {
    postedId: q.provider_txn_id,
    pending: rows[0]!,
    byProvider:
      link.created_by === 'provider' || rows.some((r) => r.provider_txn_id === q.pending_provider_txn_id),
  };
}

/**
 * Not the same on a posted row and the bank pending row whose key it took. The pending row keeps the key and its
 * overlay (what you set on the pair is on it); the posted row gets its own key back and is filed again as a new
 * posted row (sync/file-fresh.ts). The pair goes into not_same, so neither processing nor the heal step pairs them
 * again. A still-listed pending row counts again as pending; one the bank removed stays gone.
 */
async function undoBankPair(s: Scoped, key: string, now: number): Promise<boolean> {
  const b = await bankPair(s, key);
  if (!b) return false;
  if (b.byProvider)
    throw new HttpError(
      409,
      'provider_link',
      'Your bank paired these two itself, so they stay one purchase.',
    );
  const own = `p:${b.postedId}`;
  const fresh = await planFresh(
    s,
    (await loadBankRows(s, [b.postedId])).map((r) => ({ ...r, txn_key: own })),
    now,
  );
  await fenced(s, [
    ownKeyStmt(s, b.postedId, now),
    s.db.prepare(`DELETE FROM txn_key_move WHERE old_key = ?1 AND new_key = ?2`).bind(own, key),
    s.q(
      `UPDATE txn_link SET undone_at = ?4 WHERE budget_id = ?1 AND kind = 'pending_match' AND from_key = ?2 AND to_key = ?3 AND undone_at IS NULL`,
      own,
      key,
      now,
    ),
    // The posted amount's alert was about this pair.
    s.q(
      `UPDATE txn_overlay SET alert = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    notSameStmt(s, own, key, now),
    ackAsks(s, own, now),
    ...fresh,
    s.audit('txn.not_same', 'transaction', key, null, { posted: b.postedId }, now),
  ]);
  return true;
}

/**
 * Not the same: undoes a pair, and remembers No. A cover ends (the bank row counts again); a posted row that took your
 * entry's key gets its own key back, and so does the pending row it claimed with it, and the entry counts again on its
 * own (its cover, if any, back in force). A posted row that took a bank pending row's key: undoBankPair.
 */
samePurchaseRoutes.post('/transactions/:key/not-same', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const key = c.req.param('key');
  const m = await s.first<EntryDb & { matched_txn_key: string | null }>(
    `SELECT m.txn_key, m.amount, m.covers_provider_txn_id, m.account_id, m.date, m.payee_name, m.matched_txn_key,
       (${COVERING('m')}) AS covering
     FROM manual_pending m WHERE m.budget_id = ?1 AND m.txn_key = ?2 AND m.deleted_at IS NULL`,
    key,
  );
  if (!m) {
    if (await undoBankPair(s, key, now)) return c.json(ACK);
    throw new HttpError(422, 'not_paired', 'This isn’t paired with another transaction.');
  }
  if (m.matched_txn_key === null) {
    if (!m.covering || !m.covers_provider_txn_id)
      throw new HttpError(422, 'not_paired', 'This isn’t paired with another transaction.');
    await s.batch([
      s.q(
        `UPDATE manual_pending SET covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
      notSameStmt(s, key, `p:${m.covers_provider_txn_id}`, now),
      s.audit('txn.not_same', 'transaction', key, null, { cover: m.covers_provider_txn_id }, now),
    ]);
    return c.json(ACK);
  }
  const posted = await s.first<{ provider_txn_id: string }>(
    `SELECT provider_txn_id FROM bank_txn WHERE budget_id = ?1 AND txn_key = ?2 AND pending = 0 AND removed_at IS NULL`,
    key,
  );
  if (!posted) throw new HttpError(422, 'not_paired', 'This isn’t paired with another transaction.');
  // Every bank row holding the entry's key (the posted row, and a pending row claimed with it) gets its own back, as
  // when the provider's link wins over a pair made without it.
  const moved = await s.all<{ provider_txn_id: string }>(
    `SELECT provider_txn_id FROM bank_txn WHERE budget_id = ?1 AND txn_key = ?2`,
    key,
  );
  await fenced(s, [
    s.q(
      `UPDATE bank_txn SET txn_key = 'p:' || provider_txn_id, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    ...moved.map((b) =>
      s.db
        .prepare(`DELETE FROM txn_key_move WHERE old_key = ?1 AND new_key = ?2`)
        .bind(`p:${b.provider_txn_id}`, key),
    ),
    s.q(
      `UPDATE manual_pending SET matched_txn_key = NULL, matched_by = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    s.q(
      `UPDATE txn_link SET undone_at = ?4 WHERE budget_id = ?1 AND kind = 'pending_match' AND from_key = ?2 AND to_key = ?3 AND undone_at IS NULL`,
      `p:${posted.provider_txn_id}`,
      key,
      now,
    ),
    // The posted amount's alert was about this pair.
    s.q(
      `UPDATE txn_overlay SET alert = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
      now,
    ),
    notSameStmt(s, key, `p:${posted.provider_txn_id}`, now),
    ackAsks(s, `p:${posted.provider_txn_id}`, now),
    s.audit('txn.not_same', 'transaction', key, null, { posted: posted.provider_txn_id }, now),
  ]);
  return c.json(ACK);
});

/**
 * After an edit to your entry's amount: the cover ends when the bank row it covers is no longer a candidate (another
 * sign, or an amount out of tolerance). A statement for the edit's batch, or none.
 */
export async function coverAfterAmount(s: Scoped, key: string, amount: number, now: number): Promise<Stmt[]> {
  const r = await s.first<{
    account_id: string;
    date: string;
    payee_name: string;
    b_account: string | null;
    b_amount: number;
    b_date: string;
    raw_name: string;
    payment_channel: string | null;
    authorized_date: string | null;
  }>(
    `SELECT m.account_id, m.date, m.payee_name, a.id AS b_account, b.amount AS b_amount, b.date AS b_date, b.raw_name,
       b.payment_channel, b.authorized_date
     FROM manual_pending m JOIN bank_txn b ON b.budget_id = m.budget_id AND b.provider_txn_id = m.covers_provider_txn_id
     LEFT JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
     WHERE m.budget_id = ?1 AND m.txn_key = ?2 AND m.covers_provider_txn_id IS NOT NULL`,
    key,
  );
  if (!r) return [];
  const fits = entryCandidate(
    {
      key,
      accountId: r.account_id,
      amount: cents(amount),
      date: r.date,
      name: r.payee_name,
      channel: /check/i.test(r.payee_name) ? 'check' : 'card',
    },
    {
      key: '',
      accountId: r.b_account ?? '',
      amount: cents(r.b_amount),
      date: r.b_date,
      authorizedDate: r.authorized_date,
      names: [],
      channel: channel(r),
    },
  );
  return fits
    ? []
    : [
        s.q(
          `UPDATE manual_pending SET covers_provider_txn_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
          key,
          now,
        ),
      ];
}
