// Activity, transaction sheets and every edit to a transaction's overlay; matching, transfers and Owed to you.
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import {
  CategorizeRequest,
  MatchRequest,
  NewTxnRequest,
  OwedAction,
  PendingCheckAction,
  TransferPick,
  TxnPatch,
  type ActivityView,
  type MatchView,
  type OwedView,
  type TxnSheet,
} from '@ledgerline/contracts';
import {
  type Month,
  addDays,
  cents,
  daysBetween,
  formatCents,
  fractionOf,
  localDate,
  monthOfDate,
  owedList,
  owedOut,
  projectedFronts,
  shouldOfferAlways,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { ACK, HttpError, parse, scoped } from './api.js';
import { editTime, liveKey } from './sync.js';
import { fresh, monthResult, shortDate, structure } from '../views/common.js';
import { categoryLabel, listRow } from '../views/rows.js';
import { RECENT_TX, TX_COLUMNS, chunks, txnCol, type TxRow } from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { accountNames } from '../views/category.js';

export const activityRoutes = new Hono<AppEnv>();

async function names(s: Scoped) {
  const { categories } = await structure(s);
  return { cats: new Map(categories.map((c) => [c.id, c.name])), accts: await accountNames(s) };
}

/** Runs the caller's writes as one batch; returns the mutation result. */
async function commit(c: Parameters<typeof scoped>[0], writes: D1PreparedStatement[]) {
  if (writes.length) await scoped(c).batch(writes);
  return ACK;
}

// ---------------------------------------------------------------- Activity

/** Rows that need you: Waiting to match, transfers to sort out, alerts, and uncategorized rows in the budget. */
const ATTENTION_SQL = `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1
         AND (date >= budget_from OR pending_at_link = 1 OR status != 'posted') AND (
         wtm_state IN ('waiting', 'send_back') OR transfer_state = 'unsorted' OR (alert IS NOT NULL AND reviewed_at IS NULL)
         OR (category_id IS NULL AND coalesce(to_rta, 0) = 0 AND transfer_state IS NULL AND wtm_state IS NULL AND wont_clear = 0
             AND status != 'upcoming'
             AND key NOT IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1)))
       ORDER BY date DESC, seq DESC LIMIT 200`;

/**
 * The tab badges, cheaply (they show on every screen): the Activity attention count and the Accounts connection
 * problems. The full Activity and Accounts views read every transaction, so badges must not use them.
 */
activityRoutes.get('/badges', async (c) => {
  const s = scoped(c);
  const tz = await s.first<{
    time_zone: string;
    rta: number;
    summary_month: string | null;
    summary_dirty_from: string | null;
  }>(`SELECT time_zone, rta, summary_month, summary_dirty_from FROM budget WHERE id = ?1`);
  const today = localDate(clock(c.env), tz?.time_zone ?? 'America/Los_Angeles');
  const [attn, stale, conns] = await s.batch([
    s.q(ATTENTION_SQL),
    s.q(
      `SELECT count(*) AS n FROM manual_pending m JOIN account a ON a.id = m.account_id WHERE m.budget_id = ?1 AND m.kind = 'pending' AND m.deleted_at IS NULL
         AND m.matched_txn_key IS NULL AND julianday(?2) - julianday(m.date) >= a.stale_pending_days AND (m.stale_snooze_until IS NULL OR m.stale_snooze_until <= ?2)`,
      today,
    ),
    s.q(
      `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND status IN ('login_required', 'error')`,
    ),
  ]);
  const rows = attn!.results as TxRow[];
  const activity =
    rows.filter((t) => t.wtm_state === 'waiting' || t.wtm_state === 'send_back').length +
    rows.filter((t) => t.transfer_state === 'unsorted' && t.amount < 0).length +
    rows.filter(
      (t) => !t.category_id && !t.to_rta && !t.transfer_state && !t.wtm_state && !(t.alert && !t.reviewed_at),
    ).length +
    rows.filter((t) => t.alert && !t.reviewed_at).length +
    ((stale!.results[0] as { n: number } | undefined)?.n ?? 0);
  return c.json({
    activity,
    accounts: (conns!.results[0] as { n: number } | undefined)?.n ?? 0,
    // The cached Ready to Assign for the current month, for the desktop sidebar.
    rta: tz?.rta ?? 0,
    // Not final yet: a recompute is running, or the month rolled over since it was computed.
    rtaUpdating: !!tz?.summary_dirty_from || tz?.summary_month !== today.slice(0, 7),
  });
});

/** Start of the first window the Activity list reads: 45 days before the page's cursor (or today). */
function windowStart(cursor: string | undefined, today: string): string {
  const from = cursor ? cursor.slice(0, 10) : today;
  return shiftDate(from, -45);
}

function shiftDate(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** A search matches a row's category name too (Reports opens Activity searching for a category), split lines included. */
const CATEGORY_MATCH = `category_id IN (SELECT id FROM category WHERE budget_id = ?1 AND lower(name) LIKE ?3)
         OR key IN (SELECT sp.txn_key FROM txn_split sp JOIN category c ON c.id = sp.category_id
                    WHERE sp.budget_id = ?1 AND lower(c.name) LIKE ?3)`;

/**
 * One page of posted rows, newest first. With a window start, only rows dated (and so posted) on or after it are
 * read, through bank_txn_budget_date; 'all' reads every row (searches); 'none' reads nothing (the attention view).
 */
function postedQuery(
  s: Scoped,
  from: string | 'all' | 'none',
  cursor: string | null,
  q: string,
): D1PreparedStatement {
  const window = from !== 'all' && from !== 'none';
  return s.q(
    `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND ${from === 'none' ? '0 AND ' : ''}status = 'posted'
       ${window ? 'AND posted_date >= ?4 AND date >= ?4' : ''}
       AND (?2 IS NULL OR date || '|' || printf('%015d', seq) < ?2)
       ${q ? `AND (lower(payee) LIKE ?3 OR printf('%.2f', abs(amount) / 100.0) LIKE ?3 OR ${CATEGORY_MATCH})` : 'AND ?3 IS NULL'}
     ORDER BY date DESC, seq DESC LIMIT 50`,
    cursor,
    q ? `%${q}%` : null,
    ...(window ? [from] : []),
  );
}

activityRoutes.get('/activity', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  const filter = c.req.query('filter') ?? 'all';
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const cursor = c.req.query('cursor');
  const { cats, accts } = await names(s);
  const [attn, pend, upc, posted, splits, owed, links, stale] = await s.batch([
    s.q(ATTENTION_SQL),
    s.q(
      `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1 AND status = 'pending' ORDER BY date DESC, seq DESC LIMIT 200`,
    ),
    // The attention view shows no upcoming or posted rows: skip those scans (they cost reads on every visit).
    s.q(
      `SELECT ${TX_COLUMNS} FROM v_txn_manual WHERE budget_id = ?1 AND ?3 = 0 AND status = 'upcoming' AND date > ?2 ORDER BY date LIMIT 100`,
      f.today,
      filter === 'attention' ? 1 : 0,
    ),
    // Posted rows are bank rows only. Without a search, the first try reads only a recent window (see postedPage).
    postedQuery(
      s,
      filter === 'attention' ? 'none' : q ? 'all' : windowStart(cursor, f.today),
      cursor ?? null,
      q,
    ),
    s.q(`SELECT txn_key, category_id FROM txn_split WHERE budget_id = ?1`),
    s.q(
      `SELECT txn_key, amount, fraction_num, fraction_den, canceled_at, closed_at FROM expected_reimbursement WHERE budget_id = ?1`,
    ),
    s.q(
      `SELECT from_key FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
    s.q(
      `SELECT m.txn_key FROM manual_pending m JOIN account a ON a.id = m.account_id WHERE m.budget_id = ?1 AND m.kind = 'pending' AND m.deleted_at IS NULL
         AND m.matched_txn_key IS NULL AND julianday(?2) - julianday(m.date) >= a.stale_pending_days AND (m.stale_snooze_until IS NULL OR m.stale_snooze_until <= ?2)`,
      f.today,
    ),
  ]);
  const splitRows = splits!.results as { txn_key: string; category_id: string | null }[];
  const splitKeys = new Set(splitRows.map((r) => r.txn_key));
  // Categories whose name matches the search, and the split transactions with a line in one of them.
  const qCats = new Set(q ? [...cats].filter(([, n]) => n.toLowerCase().includes(q)).map(([id]) => id) : []);
  const qSplits = new Set(
    splitRows.filter((r) => r.category_id && qCats.has(r.category_id)).map((r) => r.txn_key),
  );
  const owedBy = new Map<string, { amount: number; label: string }>();
  for (const o of owed!.results as {
    txn_key: string;
    amount: number;
    fraction_num: number | null;
    fraction_den: number | null;
    canceled_at: number | null;
    closed_at: number | null;
  }[]) {
    if (o.canceled_at) continue;
    const label =
      o.fraction_num === 1 && o.fraction_den === 2
        ? 'Half'
        : o.fraction_num && o.fraction_den
          ? `${o.fraction_num}/${o.fraction_den}`
          : 'Owed';
    owedBy.set(o.txn_key, { amount: o.amount, label });
  }
  const paid = new Set((links!.results as { from_key: string }[]).map((r) => r.from_key));
  const staleKeys = new Set((stale!.results as { txn_key: string }[]).map((r) => r.txn_key));
  const row = (t: TxRow) =>
    listRow(t, accts, cats, {
      owed: owedBy.get(t.key) ?? null,
      paidBack: paid.has(t.key),
      stale: staleKeys.has(t.key),
      split: splitKeys.has(t.key),
    });
  const match = (t: TxRow) =>
    !q ||
    t.payee.toLowerCase().includes(q) ||
    formatCents(Math.abs(t.amount)).includes(q) ||
    (!!t.category_id && qCats.has(t.category_id)) ||
    qSplits.has(t.key);
  const attnRows = (attn!.results as TxRow[]).filter(match);
  const moneyToMatch = attnRows
    .filter((t) => t.wtm_state === 'waiting' || t.wtm_state === 'send_back')
    .map(row);
  const transfersToSort = attnRows.filter((t) => t.transfer_state === 'unsorted' && t.amount < 0).map(row);
  const uncats = attnRows.filter(
    (t) => !t.category_id && !t.to_rta && !t.transfer_state && !t.wtm_state && !(t.alert && !t.reviewed_at),
  );
  // Past categories of each payee, for the picker ("You’ve used for Amazon") and the Always offer.
  const payeeIds = [...new Set(uncats.map((t) => t.payee_id).filter((x): x is string => !!x))];
  const hist = new Map<string, (string | null)[]>();
  for (const ids of chunks(payeeIds)) {
    const h = await s.all<{ payee_id: string; category_id: string | null }>(
      `SELECT payee_id, category_id FROM txn_overlay WHERE budget_id = ?1 AND categorized_by = 'user' AND payee_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
      ...ids,
    );
    for (const r of h) hist.set(r.payee_id, [...(hist.get(r.payee_id) ?? []), r.category_id]);
  }
  const needsCategory = uncats.map((t) => {
    const hs = t.payee_id ? (hist.get(t.payee_id) ?? []) : [];
    const consistent = shouldOfferAlways(hs);
    const list = [...new Set(hs.filter((x): x is string => !!x))].map((id) => cats.get(id) ?? id);
    return {
      ...row(t),
      history: list.length
        ? {
            title: consistent ? `Every past ${t.payee}` : `You’ve used for ${t.payee}`,
            categories: list,
            consistent: consistent !== null,
          }
        : null,
    };
  });
  const checkThese = [
    ...attnRows
      .filter((t) => t.alert && !t.reviewed_at)
      .map((t) => ({ ...row(t), action: 'dismiss' as const })),
    ...(pend!.results as TxRow[])
      .filter((t) => staleKeys.has(t.key))
      .filter(match)
      .map((t) => ({ ...row(t), action: 'review' as const })),
  ];
  const pending = (pend!.results as TxRow[]).filter(match).map(row);
  const pendingTotal = (pend!.results as TxRow[])
    .filter((t) => !t.wont_clear)
    .reduce((a, t) => a - t.amount, 0);
  const upcoming = (upc!.results as TxRow[]).filter(match).map(row);
  let postedTx = posted!.results as TxRow[];
  if (filter === 'all' && !q && postedTx.length < 50) {
    // The recent window had fewer than 50 rows: widen it, then read everything.
    const run = async (from: string) => (await postedQuery(s, from, cursor ?? null, q).all<TxRow>()).results;
    const wider = await run(shiftDate(windowStart(cursor, f.today), -180));
    postedTx = wider.length < 50 ? await run('all') : wider;
  }
  const postedRows = postedTx.map(row);
  const last = postedTx[49];
  const { categories, groups } = await structure(s);
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const mr = await monthResult(s, f.current, start);
  const picker = groups
    .filter((g) => !g.archived_at)
    .map((g) => ({
      group: g.name,
      categories: categories
        .filter((cat) => cat.group_id === g.id && !cat.archived_at && cat.kind !== 'cc_payment')
        .map((cat) => ({
          id: cat.id,
          name: cat.name,
          available: cents(mr?.categories[cat.id]?.available ?? 0),
        })),
    }))
    .filter((g) => g.categories.length);
  const view: ActivityView = {
    attentionCount: moneyToMatch.length + transfersToSort.length + needsCategory.length + checkThese.length,
    moneyToMatch,
    transfersToSort,
    needsCategory,
    checkThese,
    pending: filter === 'attention' ? [] : pending,
    pendingTotal: cents(pendingTotal),
    upcoming: filter === 'attention' ? [] : upcoming,
    posted: filter === 'all' ? postedRows : [],
    nextCursor: last ? `${last.date}|${String(last.seq).padStart(15, '0')}` : null,
    categoryPicker: picker,
  };
  return c.json(view);
});

// ---------------------------------------------------------------- transaction sheet

async function loadTx(s: Scoped, key: string): Promise<TxRow> {
  const t = await s.first<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND key = ?2`,
    key,
  );
  if (!t) throw new HttpError(404, 'not_found', 'transaction');
  return t;
}

activityRoutes.get('/transactions/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const t = await loadTx(s, key);
  const { cats, accts } = await names(s);
  const [sp, ow, pb, rf, rule] = await s.batch([
    s.q(
      `SELECT id, category_id, amount, memo, absorbs_remainder FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2 ORDER BY sort`,
      key,
    ),
    s.q(
      `SELECT id, amount, expect_by, closed_at, canceled_at FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2`,
      key,
    ),
    s.q(
      `SELECT l.from_key, l.to_key, l.amount, coalesce(${txnCol('l.from_key', 'payee')}, '') AS label FROM txn_link l
       WHERE l.budget_id = ?1 AND l.kind = 'reimbursement_of' AND l.undone_at IS NULL AND (l.from_key = ?2 OR l.to_key IN (SELECT id FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key = ?2))`,
      key,
    ),
    s.q(
      `SELECT l.to_key, coalesce(${txnCol('l.to_key', 'payee')}, '') AS label, ${txnCol('l.to_key', 'date')} AS date FROM txn_link l
       WHERE l.budget_id = ?1 AND l.kind = 'refund_of' AND l.undone_at IS NULL AND l.from_key = ?2`,
      key,
    ),
    s.q(`SELECT name FROM rule WHERE budget_id = ?1 AND id = ?2`, t.rule_id ?? ''),
  ]);
  const splits = sp!.results as {
    id: string;
    category_id: string | null;
    amount: number;
    memo: string | null;
    absorbs_remainder: number;
  }[];
  const pbs = pb!.results as { from_key: string; to_key: string; amount: number; label: string }[];
  const owedRows = ow!.results as {
    id: string;
    amount: number;
    expect_by: string | null;
    closed_at: number | null;
    canceled_at: number | null;
  }[];
  const today = new Date().toISOString().slice(0, 10);
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
  const kind: TxnSheet['kind'] =
    t.transfer_state === 'paired' || t.transfer_state === 'unsorted'
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
  const sheet: TxnSheet = {
    key,
    kind,
    payee: t.payee,
    rawName: t.raw_name,
    accountId: t.account_id,
    accountName: accts.get(t.account_id) ?? t.account_name,
    date: t.date,
    postedDate: t.posted_date,
    amount: cents(t.amount),
    bankAmount: t.bank_amount === null ? null : cents(t.bank_amount),
    estimatedAmount: t.estimated_amount === null ? null : cents(t.estimated_amount),
    status: t.status,
    wontClear: t.wont_clear === 1,
    categoryId: t.category_id,
    categoryLabel: categoryLabel(t, cats, splits.length > 0),
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
      amount: o.amount,
      matched: o.matched,
      expectBy: o.expectBy,
      status: o.status,
    })),
    paybacks: pbs.map((p) => ({
      inflowKey: p.from_key,
      itemId: p.to_key,
      amount: cents(p.amount),
      label: p.label,
    })),
    refundOf: refund ? { key: refund.to_key, label: `${refund.label} · ${shortDate(refund.date)}` } : null,
    alerts,
  };
  return c.json(sheet);
});

const OVERLAY_UPSERT = `INSERT INTO txn_overlay (txn_key, budget_id, created_at, updated_at) VALUES (?2, ?1, ?3, ?3) ON CONFLICT (txn_key) DO NOTHING`;

activityRoutes.patch('/transactions/:key', async (c) => {
  const p = await parse(TxnPatch, c.req.raw);
  const s = scoped(c);
  const key = await liveKey(s, c.req.param('key'));
  const t = await loadTx(s, key);
  const now = clock(c.env);
  // Most-recent-edit-wins uses when the edit was made, which for an offline edit is before it arrives.
  const editAt = editTime(c, now);
  const w: D1PreparedStatement[] = [s.q(OVERLAY_UPSERT, key, now)];
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
      if (!ok) throw new HttpError(404, 'not_found', 'category');
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
        throw new HttpError(422, 'split_total', `Split lines must add up to ${formatCents(t.amount)}`);
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
      throw new HttpError(422, 'not_pending', 'Only a bank pending amount can be estimated');
    set('estimated_amount', p.estimatedAmount);
    edits.estimated_amount = editAt;
  }
  if (p.amount !== undefined) {
    if (t.source !== 'manual')
      throw new HttpError(422, 'not_manual', 'Only a transaction you added can change its amount');
    if (p.amount === 0) throw new HttpError(422, 'zero_amount', 'Enter an amount');
    w.push(
      s.q(
        `UPDATE manual_pending SET amount = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        p.amount,
        now,
      ),
    );
    edits.amount = editAt;
  }
  if (p.wontClear !== undefined) {
    // Only something not posted yet can fail to clear: a posted charge always counts.
    if (p.wontClear && t.status === 'posted')
      throw new HttpError(422, 'posted', 'This has posted, so it counts; it can’t be marked won’t clear');
    set('wont_clear', p.wontClear ? 1 : 0);
  }
  if (p.budgetMonth !== undefined) set('budget_month', p.budgetMonth);
  if (p.payeeName !== undefined) {
    if (t.payee_id)
      w.push(
        s.q(
          `UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
          t.payee_id,
          p.payeeName,
          now,
        ),
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
      if (t.amount >= 0) throw new HttpError(422, 'not_outflow', 'Only money going out can be owed to you');
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
      if (amount <= 0) throw new HttpError(422, 'invalid', 'Owed amount must be more than zero');
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

activityRoutes.post('/transactions/categorize', async (c) => {
  const r = await parse(CategorizeRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  if (r.categoryId) {
    const ok = await s.first(
      `SELECT id FROM category WHERE budget_id = ?1 AND id = ?2 AND kind != 'cc_payment'`,
      r.categoryId,
    );
    if (!ok) throw new HttpError(404, 'not_found', 'category');
  }
  const w: D1PreparedStatement[] = [];
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

activityRoutes.post('/transactions', async (c) => {
  const r = await parse(NewTxnRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const acct = await s.first(`SELECT id FROM account WHERE budget_id = ?1 AND id = ?2`, r.accountId);
  if (!acct) throw new HttpError(404, 'not_found', 'account');
  if (r.categoryId) {
    const ok = await s.first(
      `SELECT id FROM category WHERE budget_id = ?1 AND id = ?2 AND kind != 'cc_payment'`,
      r.categoryId,
    );
    if (!ok) throw new HttpError(404, 'not_found', 'category');
  }
  // Only money in can go to Ready to Assign.
  const toRta = r.toRta === true && r.amount > 0;
  const key = `m:${ulid(now)}`;
  const w = [
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

activityRoutes.post('/transactions/:key/pending', async (c) => {
  const r = await parse(PendingCheckAction, c.req.raw);
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const m = await s.first<{ date: string }>(
    `SELECT date FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
    key,
  );
  if (!m) throw new HttpError(404, 'not_found', 'expected transaction');
  const today = new Date(now).toISOString().slice(0, 10);
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
            `UPDATE manual_pending SET deleted_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
            key,
            now,
          ),
        ];
  w.push(s.audit(`pending.${r.action}`, 'transaction', key, null, null, now));
  return c.json(await commit(c, w));
});

activityRoutes.delete('/transactions/:key', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const m = await s.first(
    `SELECT id FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2 AND deleted_at IS NULL`,
    key,
  );
  if (!m)
    throw new HttpError(422, 'bank_row', 'Bank transactions can’t be deleted; mark them won’t clear instead');
  return c.json(
    await commit(c, [
      s.q(
        `UPDATE manual_pending SET deleted_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
      s.audit('txn.delete', 'transaction', key, null, null, now),
    ]),
  );
});

activityRoutes.post('/transactions/:key/review', async (c) => {
  const s = scoped(c);
  const key = c.req.param('key');
  const now = clock(c.env);
  const o = await s.first(`SELECT 1 FROM txn_overlay WHERE budget_id = ?1 AND txn_key = ?2`, key);
  if (!o) throw new HttpError(404, 'not_found', 'transaction');
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

// ---------------------------------------------------------------- matching money back

async function openItems(s: Scoped, today: string) {
  const [items, links] = await s.batch([
    s.q(
      `SELECT e.id, e.txn_key, e.amount, e.expect_by, e.closed_at, e.canceled_at, coalesce(${txnCol('e.txn_key', 'payee')}, '') AS payee,
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
  if (t.amount <= 0) throw new HttpError(422, 'not_inflow', 'Only money coming in can be matched');
  const total = r.items.reduce((a, i) => a + i.amount, 0);
  if (total > t.amount) throw new HttpError(422, 'too_much', 'More matched than came in');
  const today = new Date(now).toISOString().slice(0, 10);
  const { rows } = await openItems(s, today);
  for (const i of r.items) {
    const o = rows.find((x) => x.id === i.itemId);
    if (!o || (o.status !== 'open' && o.status !== 'late'))
      throw new HttpError(404, 'not_found', 'owed item');
    if (i.amount > o.stillOwed) throw new HttpError(422, 'too_much', 'More than is still owed');
  }
  const w: D1PreparedStatement[] = [s.q(OVERLAY_UPSERT, r.inflowKey, now)];
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
  const out = await loadTx(s, key);
  if (out.transfer_state !== 'unsorted' || out.amount >= 0)
    throw new HttpError(422, 'not_unclear', 'Not a transfer to sort out');
  const cands = await s.all<{ key: string; account_id: string }>(
    `SELECT key, account_id FROM ${RECENT_TX} WHERE budget_id = ?1 AND transfer_state = 'unsorted' AND amount = ?2 AND account_id != ?3
       AND abs(julianday(date) - julianday(?4)) <= 5`,
    -out.amount,
    out.account_id,
    out.date,
  );
  const w: D1PreparedStatement[] = [];
  if (r.otherKey) {
    const other = cands.find((x) => x.key === r.otherKey);
    if (!other) throw new HttpError(404, 'not_found', 'other side');
    w.push(
      s.q(
        `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3, categorized_by = 'user', updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        other.account_id,
        now,
      ),
      s.q(
        `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3, categorized_by = 'user', updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
        other.key,
        out.account_id,
        now,
      ),
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'transfer', ?3, ?4, 'user', ?5)`,
        ulid(now),
        key,
        other.key,
        now,
      ),
    );
  } else {
    // Neither: it was a payment and needs a category.
    w.push(
      s.q(
        `UPDATE txn_overlay SET transfer_state = NULL, transfer_account_id = NULL, updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
        key,
        now,
      ),
    );
  }
  // The deposits that weren't the other side are income (Ready to Assign).
  for (const x of cands) {
    if (x.key === r.otherKey) continue;
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
  const link = await s.first<{ from_key: string; to_key: string }>(
    `SELECT from_key, to_key FROM txn_link WHERE budget_id = ?1 AND kind = 'transfer' AND undone_at IS NULL AND (from_key = ?2 OR to_key = ?2)`,
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
  if (!o) throw new HttpError(404, 'not_found', 'owed item');
  let w: D1PreparedStatement[];
  if (r.action === 'close') {
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
    if (!r.expectBy) throw new HttpError(400, 'invalid', 'expectBy');
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
