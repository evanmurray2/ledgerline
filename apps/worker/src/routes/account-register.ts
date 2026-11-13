// An account's register: its balances, and its transactions by day with a running balance (split from accounts.ts).
import { Hono } from 'hono';
import type { RegisterView } from '@ledgerline/contracts';
import { type Month, cents, formatCents, statementCovered } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { HttpError, scoped, GONE } from './api.js';
import { fresh, monthResult, shortDate, structure } from '../views/common.js';
import { hiddenFromLists, listRow } from '../views/rows.js';
import { TX_COLUMNS, needsCategory, uncovered, type TxRow } from '../ledger/ledger.js';
import { startSheet } from '../ledger/start-part.js';
import { closeBlocked } from './account-close.js';
import { accountRows } from './accounts.js';

export const registerRoutes = new Hono<AppEnv>();

/** The register lists at most this many of an account's newest rows (and says so when there are older ones). */
export const REGISTER_ROWS = 300;

/** "Dining out", "Dining out and Groceries", "Dining out, Groceries and Rent". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
  const { categories } = await structure(s);
  const cats = new Map(categories.map((x) => [x.id, x.name]));
  const accts = new Map(rows.map((r) => [r.id, r.name]));
  // One more than are listed, to know whether older rows are left out.
  const read = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2 AND ${uncovered('v_transaction')}
       ORDER BY date DESC, seq DESC LIMIT ${REGISTER_ROWS + 1}`,
    id,
  );
  const more = read.length > REGISTER_ROWS;
  const txs = more ? read.slice(0, REGISTER_ROWS) : read;
  // A row with no category says so, as on Activity; the bank's tags (a hold, a transfer) come first.
  const row = (t: TxRow) => {
    const r = listRow(t, accts, cats);
    return !r.badge && !r.categoryLabel && needsCategory(t)
      ? { ...r, badge: 'Needs a category', badgeKind: 'alert' as const }
      : r;
  };
  // "Before your budget" rows are never listed (D-62), but the running balance still walks through them.
  const keep = (t: TxRow) =>
    !hiddenFromLists(t) &&
    (show === 'all' ||
      (show === 'pending' && !dated(t)) ||
      (show === 'needs' && needsCategory(t)) ||
      (show === 'transfers' && t.transfer_state !== null));
  const credit = account.kind === 'credit';
  const days: RegisterView['days'] = [];
  // In a closed account pending rows are final (D-93): listed on their day, in the running balance.
  const dated = (t: TxRow) => t.status === 'posted' || (account.closed && t.status === 'pending');
  // Upcoming bills that aren't due yet count on their date: listed apart with their dates, as on Activity, and left
  // out of the balance after pending. One due today or earlier counts now, with the pending rows.
  const later = (t: TxRow) => t.status === 'upcoming' && t.date > f.today;
  const pend = txs.filter((t) => !dated(t) && !later(t) && keep(t));
  if (pend.length) days.push({ label: 'Pending', balance: null, rows: pend.map(row) });
  const upcoming = txs
    .filter((t) => !dated(t) && later(t) && keep(t))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (upcoming.length) days.push({ label: 'Upcoming', balance: null, rows: upcoming.map(row) });
  // Running balance backwards from the bank balance, over posted rows.
  let bal = account.bank;
  const byDay = new Map<string, TxRow[]>();
  for (const t of txs.filter(dated)) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [d, ts] of byDay) {
    const dayBal = bal;
    for (const t of ts.filter((x) => !x.wont_clear)) bal = credit ? bal + t.amount : bal - t.amount;
    const shown = ts.filter(keep);
    if (shown.length)
      days.push({
        // The year too when it isn't this year: two days a year apart would read (and key) the same.
        label: d.slice(0, 4) === f.today.slice(0, 4) ? shortDate(d) : `${shortDate(d)}, ${d.slice(0, 4)}`,
        balance: cents(dayBal),
        rows: shown.map(row),
      });
  }
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
    pending: txs.some((t) => t.status === 'pending'),
    upcoming: txs.some((t) => t.status === 'upcoming'),
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
    more,
  } satisfies RegisterView);
});
