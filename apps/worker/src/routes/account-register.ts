// An account's register: its balances, and its transactions by day with a running balance (split from accounts.ts).
import { Hono } from 'hono';
import type { RegisterView } from '@ledgerline/contracts';
import { type Month, cents, formatCents } from '@ledgerline/domain';
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
  const txs = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2 AND ${uncovered('v_transaction')}
       ORDER BY date DESC, seq DESC LIMIT 300`,
    id,
  );
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
  const pend = txs.filter((t) => !dated(t) && keep(t));
  if (pend.length)
    days.push({ label: 'Pending', balance: null, rows: pend.map((t) => listRow(t, accts, cats)) });
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
        rows: shown.map((t) => listRow(t, accts, cats)),
      });
  }
  let note: string | null = null;
  let cardAvailable: number | null = null;
  if (credit) {
    const start = (f.budget.budget_start_month ?? f.current) as Month;
    const mr = await monthResult(s, f.current, start);
    cardAvailable = mr?.cards[id]?.available ?? 0;
    const over = Object.entries(mr?.categories ?? {}).filter(([, v]) => (v.creditOverspent[id] ?? 0) > 0);
    if (over.length) {
      const amt = over.reduce((a, [, v]) => a + (v.creditOverspent[id] ?? 0), 0);
      const names = over.map(([k]) => cats.get(k) ?? k).join(', ');
      note = `${names} is overspent by ${formatCents(amt)} on this card. Cover it on Budget to fix the card payment too.`;
    }
  }
  const start = await startSheet(s, rawAccount, recent.get(id) ?? null, now, f.budget.time_zone);
  const closeBlock = account.closed
    ? null
    : closeBlocked(
        account,
        {
          pending: txs.some((t) => t.status === 'pending'),
          upcoming: txs.some((t) => t.status === 'upcoming'),
        },
        cardAvailable,
      );
  return c.json({
    account,
    days,
    note,
    start,
    closeBlock,
    cardAvailable: cardAvailable === null ? null : cents(cardAvailable),
  } satisfies RegisterView);
});
