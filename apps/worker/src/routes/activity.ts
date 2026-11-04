// Activity; matching, transfers and Owed to you. The transaction sheet and its edits are in transactions.ts.
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import {
  MatchRequest,
  OwedAction,
  TransferPick,
  type ActivityView,
  type MatchView,
  type OwedView,
} from '@ledgerline/contracts';
import {
  type Month,
  addMonths,
  cents,
  daysBetween,
  formatCents,
  isMonth,
  localDate,
  owedList,
  owedOut,
  projectedFronts,
  rankPastUses,
  suggestCategory,
  type PastUse,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped } from './api.js';
import { fresh, monthResult, shortDate, structure } from '../views/common.js';
import { listRow } from '../views/rows.js';
import { RECENT_TX, TX_COLUMNS, chunks, txnCol, type TxRow } from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { OVERLAY_UPSERT, commit, loadTx, names, refuseHistory } from './txn-common.js';
export const activityRoutes = new Hono<AppEnv>();

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

/** Which posted rows a page reads: a recent window from a date, 'all' (searches), 'none' (the attention view), or one budget month. */
type PostedScope = string | 'all' | 'none' | { month: Month; start: Month };

/**
 * The budget month a row counts in, as Budget's Spent counts it (`linesForTxn`): its own month override or its
 * date's month, never before the budget's first month. Only for rows the budget counts (IN_BUDGET).
 */
const ROW_MONTH = `max(coalesce(budget_month, substr(date, 1, 7)), ?5)`;

/**
 * Posted rows the budget counts: dated from the account's budget start, or pending when it was linked. Activity's
 * lists leave out the rest ("Before your budget", D-61); a search still finds them, and so does the account's register.
 */
const IN_BUDGET = `(date >= budget_from OR pending_at_link = 1)`;

/**
 * One page of posted rows, newest first. With a window start, only rows dated (and so posted) on or after it are
 * read, through bank_txn_budget_date; 'all' reads every row (searches); 'none' reads nothing (the attention view).
 * A month reads only posted dates that can hold it: a row's date is at most a month from its budget month (the
 * override is the month before or after), and it posts within POST_LAG of its date. The budget's first month has
 * no lower bound, since rows pending when a bank was linked count there.
 */
function postedQuery(s: Scoped, from: PostedScope, cursor: string | null, q: string): Stmt {
  if (typeof from === 'object') {
    const first = from.month === from.start;
    return s.q(
      `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted'
         ${first ? 'AND ?4 IS NOT NULL' : 'AND posted_date >= ?4'}
         AND posted_date < date(?6, '+4 months') AND ${IN_BUDGET} AND ${ROW_MONTH} = ?7
         AND (?2 IS NULL OR date || '|' || printf('%015d', seq) < ?2)
         ${q ? `AND (lower(payee) LIKE ?3 OR printf('%.2f', abs(amount) / 100.0) LIKE ?3 OR ${CATEGORY_MATCH})` : 'AND ?3 IS NULL'}
       ORDER BY date DESC, seq DESC LIMIT 50`,
      cursor,
      q ? `%${q}%` : null,
      `${addMonths(from.month, -1)}-01`,
      from.start,
      `${addMonths(from.month, 2)}-01`,
      from.month,
    );
  }
  const window = from !== 'all' && from !== 'none';
  return s.q(
    `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND ${from === 'none' ? '0 AND ' : ''}status = 'posted'
       ${window ? 'AND posted_date >= ?4 AND date >= ?4' : ''}
       ${q ? '' : `AND ${IN_BUDGET}`}
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
  // A month (Activity's month bar) shows that budget month's posted rows; a search looks through every month.
  const monthQ = c.req.query('month');
  if (monthQ !== undefined && !isMonth(monthQ)) throw new HttpError(400, 'invalid', 'month');
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const month = monthQ && !q ? (monthQ < start ? start : monthQ) : undefined;
  // Pending and upcoming rows are waiting now: they show on this month, whatever their date, and never on a past one.
  const past = !!month && month < f.current;
  const { cats, accts } = await names(s);
  const [attn, pend, upc, posted, splits, owed, links, stale] = await s.batch([
    s.q(ATTENTION_SQL),
    s.q(
      `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1 AND status = 'pending' ORDER BY date DESC, seq DESC LIMIT 200`,
    ),
    // Upcoming rows are read in every view (a small manual table): they count toward notPostedCount.
    s.q(
      `SELECT ${TX_COLUMNS} FROM v_txn_manual WHERE budget_id = ?1 AND status = 'upcoming' AND date > ?2 ORDER BY date LIMIT 100`,
      f.today,
    ),
    // The attention view shows no posted rows: skip that scan (it costs reads on every visit).
    // Posted rows are bank rows only. Without a search, the first try reads only a recent window (see postedPage).
    postedQuery(
      s,
      filter === 'attention' ? 'none' : q ? 'all' : month ? { month, start } : windowStart(cursor, f.today),
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
  // Your past categories for each payee, by direction: the suggestion and the picker's list (docs/payees.md 2.1).
  const payeeIds = [...new Set(uncats.map((t) => t.payee_id).filter((x): x is string => !!x))];
  const uses = new Map<string, PastUse[]>();
  for (const ids of chunks(payeeIds)) {
    const h = await s.all<{
      payee_id: string;
      money_in: number;
      category_id: string | null;
      to_rta: number;
      n: number;
      last: number;
    }>(
      `SELECT o.payee_id, b.amount > 0 AS money_in, o.category_id, o.to_rta, count(*) AS n, max(o.updated_at) AS last
       FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key AND b.removed_at IS NULL
       WHERE o.budget_id = ?1 AND o.categorized_by = 'user' AND (o.category_id IS NOT NULL OR o.to_rta = 1)
         AND o.payee_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})
       GROUP BY o.payee_id, money_in, o.category_id, o.to_rta`,
      ...ids,
    );
    for (const r of h) {
      const k = `${r.payee_id}:${r.money_in ? 'in' : 'out'}`;
      uses.set(k, [
        ...(uses.get(k) ?? []),
        { categoryId: r.category_id, toRta: r.to_rta === 1, n: r.n, last: r.last },
      ]);
    }
  }
  const { categories, groups } = await structure(s);
  const usable = new Set(
    categories.filter((c) => !c.archived_at && c.kind !== 'cc_payment').map((c) => c.id),
  );
  const canUse = (id: string) => usable.has(id);
  const needsCategory = uncats.map((t) => {
    const moneyIn = t.amount > 0;
    const past = t.payee_id ? (uses.get(`${t.payee_id}:${moneyIn ? 'in' : 'out'}`) ?? []) : [];
    const ranked = rankPastUses(past, false, canUse);
    const sug = suggestCategory(past, moneyIn, canUse);
    return {
      ...row(t),
      history: ranked.length
        ? {
            title: `You’ve used for ${t.payee}`,
            categories: ranked.map((u) => ({
              id: u.categoryId!,
              name: cats.get(u.categoryId!) ?? '',
              count: u.n,
            })),
          }
        : null,
      suggestion: sug
        ? {
            ...sug,
            name: sug.toRta ? 'Ready to Assign' : (cats.get(sug.categoryId!) ?? 'category'),
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
  if (filter === 'all' && !q && !month && postedTx.length < 50) {
    // The recent window had fewer than 50 rows: widen it, then read everything.
    const run = async (from: string) => (await postedQuery(s, from, cursor ?? null, q).all<TxRow>()).results;
    const wider = await run(shiftDate(windowStart(cursor, f.today), -180));
    postedTx = wider.length < 50 ? await run('all') : wider;
  }
  const postedRows = postedTx.map(row);
  const last = postedTx[49];
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
    notPostedCount: pend!.results.length + upc!.results.length,
    moneyToMatch,
    transfersToSort,
    needsCategory,
    checkThese,
    pending: filter === 'attention' || past ? [] : pending,
    pendingTotal: cents(pendingTotal),
    upcoming: filter === 'attention' || past ? [] : upcoming,
    posted: filter === 'all' ? postedRows : [],
    nextCursor: last ? `${last.date}|${String(last.seq).padStart(15, '0')}` : null,
    categoryPicker: picker,
  };
  return c.json(view);
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
  refuseHistory(t);
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
  const out = await loadTx(s, key);
  refuseHistory(out);
  if (out.transfer_state !== 'unsorted' || out.amount >= 0)
    throw new HttpError(422, 'not_unclear', 'Not a transfer to sort out');
  const cands = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1 AND transfer_state = 'unsorted' AND amount = ?2 AND account_id != ?3
       AND abs(julianday(date) - julianday(?4)) <= 5`,
    -out.amount,
    out.account_id,
    out.date,
  );
  const w: Stmt[] = [];
  if (r.otherKey) {
    const other = cands.find((x) => x.key === r.otherKey);
    if (!other) throw new HttpError(404, 'not_found', 'other side');
    refuseHistory(other);
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
  let w: Stmt[];
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
