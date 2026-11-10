// The Activity screen and the tab badges: Needs attention, Not posted yet and posted rows.
import type { Stmt } from '@ledgerline/db/sql';
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import { type ActivityView } from '@ledgerline/contracts';
import {
  type Month,
  addMonths,
  cents,
  isIsoDate,
  isMonth,
  localDate,
  owedList,
  type OwedStatus,
  payeeNameKey,
  rankPastUses,
  suggestCategory,
  type PastUse,
} from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { BAD_MONTH, HttpError, TRY_AGAIN, scoped } from './api.js';
import { fresh, monthResult, structure } from '../views/common.js';
import { IN_BUDGET_ROWS, listRow } from '../views/rows.js';
import {
  NOT_RTA_BY_DEFAULT,
  RECENT_TX,
  TX_COLUMNS,
  chunks,
  needsCategory as waitsForCategory,
  type TxRow,
} from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { names } from './txn-common.js';
import { samePurchaseCards } from './same-purchase.js';
import { removedByBank } from './removed-by-bank.js';
export const activityViewRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- Activity

/**
 * Rows that need you: Waiting to match, transfers to sort out, alerts, uncategorized rows in the budget, and splits
 * whose lines no longer add up.
 */
const ATTENTION_SQL = `SELECT ${TX_COLUMNS} FROM ${RECENT_TX} WHERE budget_id = ?1
         AND ${IN_BUDGET_ROWS} AND (
         wtm_state IN ('waiting', 'send_back') OR transfer_state = 'unsorted' OR (alert IS NOT NULL AND reviewed_at IS NULL)
         OR (category_id IS NULL AND coalesce(to_rta, 0) = 0 AND transfer_state IS NULL AND wtm_state IS NULL AND wont_clear = 0
             AND status != 'upcoming' AND ${NOT_RTA_BY_DEFAULT}
             AND key NOT IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1))
         -- A split whose lines no longer add up to the amount: you fix it (D-82).
         OR (key IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1)
             AND amount != (SELECT sum(sp.amount) FROM txn_split sp WHERE sp.budget_id = ?1 AND sp.txn_key = key)))
       ORDER BY date DESC, seq DESC LIMIT 200`;

/**
 * The tab badges, cheaply (they show on every screen): the Activity attention count and the Accounts connection
 * problems. The full Activity and Accounts views read every transaction, so badges must not use them.
 */
activityViewRoutes.get('/badges', async (c) => {
  const s = scoped(c);
  const tz = await s.first<{
    time_zone: string;
    rta: number;
    summary_month: string | null;
    summary_dirty_from: string | null;
  }>(`SELECT time_zone, rta, summary_month, summary_dirty_from FROM budget WHERE id = ?1`);
  const today = localDate(clock(c.env), tz?.time_zone ?? 'America/Los_Angeles');
  const [attn, stale, conns, removed] = await s.batch([
    s.q(ATTENTION_SQL),
    s.q(
      `SELECT count(*) AS n FROM manual_pending m JOIN account a ON a.id = m.account_id WHERE m.budget_id = ?1 AND m.kind = 'pending' AND m.deleted_at IS NULL
         AND m.matched_txn_key IS NULL AND julianday(?2) - julianday(m.date) >= a.stale_pending_days AND (m.stale_snooze_until IS NULL OR m.stale_snooze_until <= ?2)`,
      today,
    ),
    s.q(
      `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND status IN ('login_required', 'error')`,
    ),
    s.q(
      `SELECT count(*) AS n FROM alert WHERE budget_id = ?1 AND type = 'vanished_pending' AND acked_at IS NULL`,
    ),
  ]);
  const rows = attn!.results as TxRow[];
  const activity =
    rows.filter((t) => t.wtm_state === 'waiting' || t.wtm_state === 'send_back').length +
    rows.filter((t) => t.transfer_state === 'unsorted' && t.amount < 0).length +
    rows.filter((t) => waitsForCategory(t) && !(t.alert && !t.reviewed_at)).length +
    rows.filter((t) => t.alert && !t.reviewed_at).length +
    ((stale!.results[0] as { n: number } | undefined)?.n ?? 0) +
    ((removed!.results[0] as { n: number } | undefined)?.n ?? 0) +
    // One query when nothing is asked (the usual case).
    (await samePurchaseCards(s, new Map(), new Map())).length;
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
const CATEGORY_MATCH = `category_id IN (SELECT id FROM category WHERE budget_id = ?1 AND lower(name) LIKE ?3 ESCAPE '\\')
         OR key IN (SELECT sp.txn_key FROM txn_split sp JOIN category c ON c.id = sp.category_id
                    WHERE sp.budget_id = ?1 AND lower(c.name) LIKE ?3 ESCAPE '\\')`;

/**
 * A search's posted-row filter: ?3 is the text as a LIKE pattern (its % and _ are letters, not wildcards), `amt`
 * the parameter holding the amount pattern (`amountPattern`), NULL when the search isn't an amount.
 */
const searchMatch = (amt: string) =>
  `AND (lower(payee) LIKE ?3 ESCAPE '\\' OR (${amt} IS NOT NULL AND printf('%.2f', abs(amount) / 100.0) LIKE ${amt}) OR ${CATEGORY_MATCH})`;

/** The search as a LIKE pattern for the text: % and _ match only themselves. */
function textPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The search as a plain amount ("$1,018" → "1018", "−38.10" → "38.10"), or null when it isn't one. */
function searchAmount(q: string): string | null {
  const a = q.replace(/[\s$,−-]/g, '');
  return /\d/.test(a) && /^\d*\.?\d*$/.test(a) ? a : null;
}

/** An amount as the search compares it: 101800 → "1018.00", sign dropped. */
function plainAmount(c: number): string {
  const a = Math.abs(c);
  return `${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Which posted rows a page reads: a recent window from a date, 'all' (searches), 'none' (the attention view), or one budget month. */
type PostedScope = string | 'all' | 'none' | { month: Month; start: Month };

/**
 * The budget month a row counts in, as Budget's Spent counts it (`linesForTxn`): its own month override or its
 * date's month, never before the budget's first month. Only for rows the budget counts (IN_BUDGET).
 */
const ROW_MONTH = `max(coalesce(budget_month, substr(date, 1, 7)), ?5)`;

/**
 * Posted rows the budget counts: dated from the account's budget start. Activity leaves out the rest ("Before your
 * budget", D-61, and the starting balance's own rows, D-67), searches included (D-62).
 */
const IN_BUDGET = `(date >= budget_from)`;

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
         ${q ? searchMatch('?8') : 'AND ?3 IS NULL AND ?8 IS NULL'}
       ORDER BY date DESC, seq DESC LIMIT 50`,
      cursor,
      q ? textPattern(q) : null,
      `${addMonths(from.month, -1)}-01`,
      from.start,
      `${addMonths(from.month, 2)}-01`,
      from.month,
      q && searchAmount(q) !== null ? `%${searchAmount(q)}%` : null,
    );
  }
  const window = from !== 'all' && from !== 'none';
  return s.q(
    `SELECT ${TX_COLUMNS} FROM v_txn_bank WHERE budget_id = ?1 AND ${from === 'none' ? '0 AND ' : ''}status = 'posted'
       ${window ? 'AND posted_date >= ?5 AND date >= ?5' : ''}
       AND ${IN_BUDGET}
       AND (?2 IS NULL OR date || '|' || printf('%015d', seq) < ?2)
       ${q ? searchMatch('?4') : 'AND ?3 IS NULL AND ?4 IS NULL'}
     ORDER BY date DESC, seq DESC LIMIT 50`,
    cursor,
    q ? textPattern(q) : null,
    q && searchAmount(q) !== null ? `%${searchAmount(q)}%` : null,
    ...(window ? [from] : []),
  );
}

/**
 * What a search looks for: at most 48 bytes, since a Durable Object's SQLite refuses a LIKE pattern over 50 bytes
 * (the search goes between two `%`). A longer search looks for its start.
 */
function searchText(raw: string): string {
  const chars = [...raw.trim().toLowerCase()];
  const enc = new TextEncoder();
  while (enc.encode(chars.join('')).length > 48) chars.pop();
  return chars.join('').trim();
}

activityViewRoutes.get('/activity', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  const filter = c.req.query('filter') ?? 'all';
  const q = searchText(c.req.query('q') ?? '');
  const cursor = c.req.query('cursor');
  // The cursor is the `nextCursor` of an earlier page: a date and a sequence number.
  if (cursor !== undefined && !(/^.{10}\|\d{15}$/.test(cursor) && isIsoDate(cursor.slice(0, 10))))
    throw new HttpError(400, 'invalid', TRY_AGAIN);
  // A month (Activity's month bar) shows that budget month's posted rows; a search looks through every month.
  const monthQ = c.req.query('month');
  if (monthQ !== undefined && !isMonth(monthQ)) throw new HttpError(400, 'invalid', BAD_MONTH);
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
    s.q(`SELECT txn_key, category_id, amount FROM txn_split WHERE budget_id = ?1`),
    s.q(
      `SELECT id, txn_key, amount, canceled_at, closed_at FROM expected_reimbursement WHERE budget_id = ?1`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
    s.q(
      `SELECT m.txn_key FROM manual_pending m JOIN account a ON a.id = m.account_id WHERE m.budget_id = ?1 AND m.kind = 'pending' AND m.deleted_at IS NULL
         AND m.matched_txn_key IS NULL AND julianday(?2) - julianday(m.date) >= a.stale_pending_days AND (m.stale_snooze_until IS NULL OR m.stale_snooze_until <= ?2)`,
      f.today,
    ),
  ]);
  const splitRows = splits!.results as { txn_key: string; category_id: string | null; amount: number }[];
  const splitKeys = new Set(splitRows.map((r) => r.txn_key));
  const splitTotals = new Map<string, number>();
  for (const r of splitRows) splitTotals.set(r.txn_key, (splitTotals.get(r.txn_key) ?? 0) + r.amount);
  /** What a split's lines leave out of its amount (D-82): 0 when they add up, or for a row with no split. */
  const splitOff = (t: TxRow) => (splitTotals.has(t.key) ? t.amount - splitTotals.get(t.key)! : 0);
  // Categories whose name matches the search, and the split transactions with a line in one of them.
  const qCats = new Set(q ? [...cats].filter(([, n]) => n.toLowerCase().includes(q)).map(([id]) => id) : []);
  const qSplits = new Set(
    splitRows.filter((r) => r.category_id && qCats.has(r.category_id)).map((r) => r.txn_key),
  );
  // What each owed purchase still has owed, so its row says "$25 owed", then "Paid" once money back matches it.
  const linkRows = links!.results as { from_key: string; to_key: string; amount: number }[];
  const owedRows = owed!.results as {
    id: string;
    txn_key: string;
    amount: number;
    canceled_at: number | null;
    closed_at: number | null;
  }[];
  const owedBy = new Map<string, { still: number; status: OwedStatus }>();
  for (const o of owedList(
    owedRows.map((o) => ({
      id: o.id,
      txnKey: o.txn_key,
      amount: cents(o.amount),
      expectBy: null,
      closedAt: o.closed_at ? 'x' : null,
      canceledAt: o.canceled_at ? 'x' : null,
    })),
    linkRows.map((l) => ({ inflowKey: l.from_key, itemId: l.to_key, amount: cents(l.amount) })),
    f.today,
  )) {
    if (o.status !== 'canceled') owedBy.set(o.txnKey, { still: o.stillOwed, status: o.status });
  }
  const paid = new Set(linkRows.map((r) => r.from_key));
  const staleKeys = new Set((stale!.results as { txn_key: string }[]).map((r) => r.txn_key));
  const row = (t: TxRow) =>
    listRow(t, accts, cats, {
      owed: owedBy.get(t.key) ?? null,
      paidBack: paid.has(t.key),
      stale: staleKeys.has(t.key),
      split: splitKeys.has(t.key),
      splitOff: splitOff(t),
    });
  const qAmount = searchAmount(q);
  const match = (t: TxRow) =>
    !q ||
    t.payee.toLowerCase().includes(q) ||
    (qAmount !== null && plainAmount(t.amount).includes(qAmount)) ||
    (!!t.category_id && qCats.has(t.category_id)) ||
    qSplits.has(t.key);
  const attnRows = (attn!.results as TxRow[]).filter(match);
  const moneyToMatch = attnRows
    .filter((t) => t.wtm_state === 'waiting' || t.wtm_state === 'send_back')
    .map(row);
  const transfersToSort = attnRows.filter((t) => t.transfer_state === 'unsorted' && t.amount < 0).map(row);
  const uncats = attnRows.filter(
    (t) => waitsForCategory(t) && !(t.alert && !t.reviewed_at) && !splitKeys.has(t.key),
  );
  // Payees you've categorized, by name: a payee you haven't is new, and one with the same name as yours gets
  // "Same as your …?" (docs/payees.md 4.2, 4.3).
  const known = uncats.length
    ? await s.all<{ id: string; name: string }>(
        `SELECT p.id, p.name FROM payee p WHERE p.budget_id = ?1 AND p.merged_into IS NULL
           AND EXISTS (SELECT 1 FROM txn_overlay o WHERE o.budget_id = ?1 AND o.payee_id = p.id AND o.categorized_by = 'user')`,
      )
    : [];
  const knownIds = new Set(known.map((p) => p.id));
  const knownByName = new Map(known.map((p) => [payeeNameKey(p.name), p]));
  const sameAsOf = (t: TxRow) => {
    if (!t.payee_id || knownIds.has(t.payee_id)) return null;
    const p = knownByName.get(payeeNameKey(t.payee));
    return p && p.id !== t.payee_id ? p : null;
  };
  // Your past categories for each payee, by direction: the suggestion and the picker's list (docs/payees.md 2.1).
  const payeeIds = [
    ...new Set(uncats.flatMap((t) => [t.payee_id, sameAsOf(t)?.id]).filter((x): x is string => !!x)),
  ];
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
  // "Same purchase?" asks only when nothing is searched for: its rows are the bank's and your entries.
  const samePurchase = q ? [] : await samePurchaseCards(s, accts, cats);
  const removed = q ? [] : await removedByBank(s);
  const usable = new Set(
    categories.filter((c) => !c.archived_at && c.kind !== 'cc_payment').map((c) => c.id),
  );
  const canUse = (id: string) => usable.has(id);
  const needsCategory = uncats.map((t) => {
    const moneyIn = t.amount > 0;
    const sameAs = sameAsOf(t);
    // A "Same as" row suggests what you use for your payee of that name.
    const from = sameAs?.id ?? t.payee_id;
    const past = from ? (uses.get(`${from}:${moneyIn ? 'in' : 'out'}`) ?? []) : [];
    const ranked = rankPastUses(past, false, canUse);
    const sug = suggestCategory(past, moneyIn, canUse);
    return {
      ...row(t),
      payeeId: t.payee_id,
      rawName: t.raw_name,
      newPayee: !!t.payee_id && !knownIds.has(t.payee_id),
      sameAs: sameAs ? { id: sameAs.id, name: sameAs.name } : null,
      history: ranked.length
        ? {
            title: `Past categories for ${sameAs?.name ?? t.payee}`,
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
    // A split that no longer adds up opens its sheet, where you fix the lines (D-82).
    ...attnRows
      .filter((t) => splitOff(t) !== 0 && !(t.alert && !t.reviewed_at))
      .map((t) => ({ ...row(t), action: 'review' as const })),
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
    attentionCount:
      moneyToMatch.length +
      transfersToSort.length +
      needsCategory.length +
      checkThese.length +
      samePurchase.length +
      removed.length,
    notPostedCount: pend!.results.length + upc!.results.length,
    moneyToMatch,
    transfersToSort,
    needsCategory,
    checkThese,
    samePurchase,
    removedByBank: removed,
    pending: filter === 'attention' || past ? [] : pending,
    pendingTotal: cents(pendingTotal),
    upcoming: filter === 'attention' || past ? [] : upcoming,
    posted: filter === 'all' ? postedRows : [],
    nextCursor: last ? `${last.date}|${String(last.seq).padStart(15, '0')}` : null,
    categoryPicker: picker,
  };
  return c.json(view);
});
