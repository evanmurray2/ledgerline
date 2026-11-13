// An account's register: its balances, and its transactions by day with a running balance (split from accounts.ts).
// The first page holds every row still waiting and about REGISTER_ROWS of the newest posted ones; Show older reads
// the posted days before them, a page at a time (`/register/older`).
import { Hono } from 'hono';
import type {
  RegisterCursor,
  RegisterDay,
  RegisterPage,
  RegisterView,
  TxnListRow,
} from '@ledgerline/contracts';
import { type Month, cents, formatCents, isIsoDate, statementCovered } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import type { Scoped } from '../db/scoped.js';
import { editNow } from '../http/clock.js';
import { HttpError, scoped, GONE, TRY_AGAIN } from './api.js';
import { fresh, monthResult, shortDate, structure } from '../views/common.js';
import { hiddenFromLists, listRow } from '../views/rows.js';
import {
  ENTRIES_AT_BANK,
  TX_COLUMNS,
  atBankMap,
  needsCategory,
  uncovered,
  type TxRow,
} from '../ledger/ledger.js';
import { startSheet } from '../ledger/start-part.js';
import { closeBlocked } from './account-close.js';
import { accountRows } from './accounts.js';

export const registerRoutes = new Hono<AppEnv>();

/** A register page lists about this many rows (whole days, so a little more when its oldest day goes on). */
export const REGISTER_ROWS = 300;

/** "Dining out", "Dining out and Groceries", "Dining out, Groceries and Rent". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** How a register lists its rows. `show` is the old filter links' parameter (the app sends none now). */
async function lister(s: Scoped, accounts: Map<string, string>, show: string) {
  const { categories } = await structure(s);
  const cats = new Map(categories.map((x) => [x.id, x.name]));
  const atBank = atBankMap(await s.all(ENTRIES_AT_BANK));
  // A row with no category says so, as on Activity; the bank's tags (a hold, a transfer) come first.
  const row = (t: TxRow): TxnListRow => {
    const r = listRow(t, accounts, cats, { atBank: atBank.get(t.key) ?? null });
    return !r.badge && !r.categoryLabel && needsCategory(t)
      ? { ...r, badge: 'Needs a category', badgeKind: 'alert' as const }
      : r;
  };
  // "Before your budget" rows are never listed (D-62), but the running balance still walks through them.
  const keep = (t: TxRow, dated: boolean) =>
    !hiddenFromLists(t) &&
    (show === 'all' ||
      (show === 'pending' && !dated) ||
      (show === 'needs' && needsCategory(t)) ||
      (show === 'transfers' && t.transfer_state !== null));
  return { categories, cats, row, keep };
}

/**
 * Rows that count on their date: posted, and in a closed account pending ones too, which are final there (D-93).
 * `?3` is 1 for a closed account.
 */
const DATED = `(status = 'posted' OR (?3 = 1 AND status = 'pending'))`;

/**
 * One page of an account's dated rows, newest first, dated before `before` when given: about REGISTER_ROWS of them,
 * in whole days, so the next page starts on a day of its own and every day's balance is right. Indexed reads that
 * stop at the page (`LIMIT`), plus two small ones when the page ends inside a day.
 */
async function datedPage(
  s: Scoped,
  id: string,
  closed: boolean,
  before: string | null,
): Promise<{ txs: TxRow[]; more: boolean }> {
  const where = `budget_id = ?1 AND account_id = ?2 AND ${uncovered('v_transaction')} AND ${DATED}`;
  const shut = closed ? 1 : 0;
  const read = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE ${where} AND (?4 IS NULL OR date < ?4)
       ORDER BY date DESC, seq DESC LIMIT ${REGISTER_ROWS + 1}`,
    id,
    shut,
    before,
  );
  if (read.length <= REGISTER_ROWS) return { txs: read, more: false };
  // The page's last day may go on past it: list that whole day, then see whether any older day is left.
  const last = read[REGISTER_ROWS - 1]!.date;
  if (read[REGISTER_ROWS]!.date !== last) return { txs: read.slice(0, REGISTER_ROWS), more: true };
  const day = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE ${where} AND date = ?4 ORDER BY seq DESC`,
    id,
    shut,
    last,
  );
  const older = await s.first(
    `SELECT 1 FROM v_transaction WHERE ${where} AND date < ?4 LIMIT 1`,
    id,
    shut,
    last,
  );
  return { txs: [...read.filter((t) => t.date > last), ...day], more: older !== null };
}

/**
 * Dated rows (newest first) as days, each with its end-of-day running balance, walked back from `balance`: the bank
 * balance on the first page, the cursor's on an older one. Also returns where the walk ended, for the next page.
 */
function datedDays(
  txs: readonly TxRow[],
  balance: number,
  credit: boolean,
  thisYear: string,
  keep: (t: TxRow) => boolean,
  row: (t: TxRow) => TxnListRow,
): { days: RegisterDay[]; balance: number } {
  const days: RegisterDay[] = [];
  let bal = balance;
  const byDay = new Map<string, TxRow[]>();
  for (const t of txs) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [d, ts] of byDay) {
    const dayBal = bal;
    for (const t of ts.filter((x) => !x.wont_clear)) bal = credit ? bal + t.amount : bal - t.amount;
    const shown = ts.filter(keep);
    if (shown.length)
      days.push({
        // The year too when it isn't this year: two days a year apart would read (and key) the same.
        label: d.slice(0, 4) === thisYear ? shortDate(d) : `${shortDate(d)}, ${d.slice(0, 4)}`,
        balance: cents(dayBal),
        rows: shown.map(row),
      });
  }
  return { days, balance: bal };
}

/** Where the page after one ending on `txs`' oldest day starts; null when nothing older is left. */
function cursorAfter(txs: readonly TxRow[], more: boolean, balance: number): RegisterCursor | null {
  const oldest = txs[txs.length - 1];
  return more && oldest ? { before: oldest.date, balance: cents(balance) } : null;
}

registerRoutes.get('/accounts/:id/register', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const f = await fresh(s, now);
  const id = c.req.param('id');
  const show = c.req.query('show') ?? 'all';
  const { rows, raw, recent } = await accountRows(s, f.today, f.budget.time_zone, now, true);
  const account = rows.find((r) => r.id === id);
  const rawAccount = raw.find((r) => r.id === id);
  if (!account || !rawAccount) throw new HttpError(404, 'not_found', GONE);
  const { categories, cats, row, keep } = await lister(s, new Map(rows.map((r) => [r.id, r.name])), show);
  // Rows still waiting (pending, upcoming) are few: every one is on the first page, whatever its date.
  const waiting = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2 AND ${uncovered('v_transaction')}
       AND NOT ${DATED} ORDER BY date DESC, seq DESC`,
    id,
    account.closed ? 1 : 0,
  );
  const page = await datedPage(s, id, account.closed, null);
  const credit = account.kind === 'credit';
  const days: RegisterView['days'] = [];
  // Upcoming bills that aren't due yet count on their date: listed apart with their dates, as on Activity, and left
  // out of the balance after pending. One due today or earlier counts now, with the pending rows.
  const later = (t: TxRow) => t.status === 'upcoming' && t.date > f.today;
  const pend = waiting.filter((t) => !later(t) && keep(t, false));
  if (pend.length) days.push({ label: 'Pending', balance: null, rows: pend.map(row) });
  const upcoming = waiting
    .filter((t) => later(t) && keep(t, false))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (upcoming.length) days.push({ label: 'Upcoming', balance: null, rows: upcoming.map(row) });
  // Running balance backwards from the bank balance, over the dated rows.
  const walked = datedDays(page.txs, account.bank, credit, f.today.slice(0, 4), (t) => keep(t, true), row);
  days.push(...walked.days);
  let note: string | null = null;
  let cardAvailable: number | null = null;
  if (credit) {
    const start = (f.budget.budget_start_month ?? f.current) as Month;
    const mr = await monthResult(s, f.current, start);
    cardAvailable = mr?.cards[id]?.available ?? 0;
    // Covered as Accounts says it: the payment category against the statement.
    if (account.statement)
      account.statement = {
        ...account.statement,
        covered: statementCovered(cents(cardAvailable), cents(account.statement.balance)),
      };
    const over = Object.entries(mr?.categories ?? {}).filter(([, v]) => (v.creditOverspent[id] ?? 0) > 0);
    if (over.length) {
      const amt = over.reduce((a, [, v]) => a + (v.creditOverspent[id] ?? 0), 0);
      const names = over.map(([k]) => cats.get(k) ?? k);
      const one = names.length === 1;
      note = `${nameList(names)} ${one ? 'is' : 'are'} overspent by ${formatCents(amt)} on this card. Cover ${one ? 'it' : 'them'} on Budget to fix the card payment too.`;
    }
  }
  const start = await startSheet(s, rawAccount, recent.get(id) ?? null, now, f.budget.time_zone);
  const open = {
    pending: waiting.some((t) => t.status === 'pending'),
    upcoming: waiting.some((t) => t.status === 'upcoming'),
  };
  const closeBlock = account.closed ? null : closeBlocked(account, open, cardAvailable);
  // A card held back only by money in its payment category: the Close sheet offers to move it to Ready to Assign.
  const payCat =
    credit && closeBlock !== null && (cardAvailable ?? 0) > 0 && closeBlocked(account, open, 0) === null
      ? categories.find((x) => x.kind === 'cc_payment' && x.card_account_id === id && !x.archived_at)
      : undefined;
  return c.json({
    account,
    days,
    note,
    start,
    closeBlock,
    cardAvailable: cardAvailable === null ? null : cents(cardAvailable),
    closeMove: payCat ? { categoryId: payCat.id, amount: cents(cardAvailable!) } : null,
    more: page.more,
    older: cursorAfter(page.txs, page.more, walked.balance),
  } satisfies RegisterView);
});

/** An older page of the register (Show older): its posted days, from the cursor the page before it gave. */
registerRoutes.get('/accounts/:id/register/older', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  const id = c.req.param('id');
  const before = c.req.query('before');
  const balance = Number(c.req.query('balance') ?? '');
  if (!isIsoDate(before) || c.req.query('balance') === '' || !Number.isSafeInteger(balance))
    throw new HttpError(400, 'invalid', TRY_AGAIN);
  const accounts = await s.all<{ id: string; name: string; kind: string; closed_at: number | null }>(
    `SELECT id, name, kind, closed_at FROM account WHERE budget_id = ?1`,
  );
  const account = accounts.find((a) => a.id === id);
  if (!account) throw new HttpError(404, 'not_found', GONE);
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const { row, keep } = await lister(s, accountNames, c.req.query('show') ?? 'all');
  const page = await datedPage(s, id, account.closed_at !== null, before);
  const credit = account.kind === 'credit';
  const walked = datedDays(page.txs, balance, credit, f.today.slice(0, 4), (t) => keep(t, true), row);
  return c.json({
    days: walked.days,
    older: cursorAfter(page.txs, page.more, walked.balance),
  } satisfies RegisterPage);
});
