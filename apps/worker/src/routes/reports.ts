// Reports: the month's spending by category, the last six months, and net worth by month (split from accounts.ts).
import { Hono } from 'hono';
import type { ReportsView } from '@ledgerline/contracts';
import { type Month, addMonths, cents, isMonth, owedList, owedOut } from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { editNow } from '../http/clock.js';
import { HttpError, scoped, BAD_MONTH, inReach } from './api.js';
import { fresh, monthResult, structure } from '../views/common.js';
import { monthTotals } from '../ledger/totals.js';
import { FINAL_ROWS_BY_MONTH } from './account-close.js';
import { accountRows } from './accounts.js';

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.get('/reports', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const f = await fresh(s, now);
  const m = (c.req.query('month') ?? f.current) as Month;
  if (!isMonth(m) || !inReach(m, f.current)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const { categories } = await structure(s);
  const kinds = new Map(categories.map((x) => [x.id, x]));
  const months: Month[] = [];
  for (let i = 5; i >= 0; i--) {
    const mm = addMonths(m, -i);
    if (mm >= start) months.push(mm);
  }
  const results = new Map<Month, Awaited<ReturnType<typeof monthResult>>>();
  for (const mm of months) results.set(mm, await monthResult(s, mm, start));
  const [inc, rew, owedI, owedL] = await s.batch([
    s.q(
      `SELECT l.month, sum(l.amount) AS a FROM budget_line l LEFT JOIN txn_overlay o ON o.txn_key = l.txn_key
       WHERE l.budget_id = ?1 AND l.kind = 'rta' AND l.card = 0 AND l.txn_key NOT LIKE 'start:%' AND l.line != 'start' AND coalesce(o.income_tag, '') != 'rewards'
         AND l.txn_key NOT IN (SELECT from_key FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL)
         AND l.month >= ?2 AND l.month <= ?3 GROUP BY l.month`,
      months[0] ?? m,
      m,
    ),
    s.q(
      `SELECT l.month, sum(l.amount) AS a FROM budget_line l LEFT JOIN txn_overlay o ON o.txn_key = l.txn_key
       WHERE l.budget_id = ?1 AND l.kind = 'rta' AND (l.card = 1 OR o.income_tag = 'rewards') AND l.month >= ?2 AND l.month <= ?3 GROUP BY l.month`,
      months[0] ?? m,
      m,
    ),
    s.q(
      `SELECT id, txn_key, amount, expect_by, closed_at, canceled_at FROM expected_reimbursement e WHERE budget_id = ?1 AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
  ]);
  const income = new Map((inc!.results as { month: string; a: number }[]).map((r) => [r.month, r.a]));
  const rewards = new Map((rew!.results as { month: string; a: number }[]).map((r) => [r.month, r.a]));
  const spentOf = (mm: Month, kind: 'spending' | 'saving') =>
    Object.entries(results.get(mm)?.categories ?? {}).reduce(
      (a, [id, v]) => a + ((kinds.get(id)?.kind ?? 'spending') === kind ? v.spent : 0),
      0,
    );
  const cur = results.get(m);
  const byCategory = Object.entries(cur?.categories ?? {})
    .filter(([id, v]) => (kinds.get(id)?.kind ?? 'spending') === 'spending' && v.spent > 0)
    .map(([id, v]) => ({ categoryId: id, name: kinds.get(id)?.name ?? id, spent: v.spent }))
    .sort((a, b) => b.spent - a.spent);
  // Net worth at each month end: the bank's balances today minus everything posted after that month. This month's
  // point counts pending, as Accounts does (D-76); a finished month's pending has posted since, so it's in the bank.
  const { rows } = await accountRows(s, f.today, f.budget.time_zone, now);
  const nwNow = rows.reduce((a, r) => a + (r.kind === 'credit' ? -r.bank : r.bank), 0);
  const nwWorking = rows.reduce((a, r) => a + (r.kind === 'credit' ? -r.working : r.working), 0);
  // Posted totals per month over the last 13 months (ledger/totals.ts: stored for finished months).
  const totals = await monthTotals(s, addMonths(f.current, -12), f.current, now);
  const posted = [...totals].map(([mm, accts]) => ({
    m: mm,
    a: [...accts.values()].reduce((x, v) => x + v.all, 0),
  }));
  // Pending rows that stayed in closed accounts are final (D-93): they count in their month, as posted rows do.
  const finals = new Map(
    (await s.all<{ month: string; a: number }>(FINAL_ROWS_BY_MONTH)).map((r) => [r.month, r.a]),
  );
  const netWorth: ReportsView['netWorth'] = [];
  let after = 0;
  for (let i = 0; i < 12; i++) {
    const mm = addMonths(f.current, -i);
    netWorth.unshift({ month: mm, value: cents(i === 0 ? nwWorking : nwNow - after) });
    after += (posted.find((p) => p.m === mm)?.a ?? 0) + (finals.get(mm) ?? 0);
  }
  const stillOwed = owedOut(
    owedList(
      (
        owedI!.results as {
          id: string;
          txn_key: string;
          amount: number;
          expect_by: string | null;
          closed_at: number | null;
          canceled_at: number | null;
        }[]
      ).map((o) => ({
        id: o.id,
        txnKey: o.txn_key,
        amount: cents(o.amount),
        expectBy: o.expect_by,
        closedAt: o.closed_at ? 'x' : null,
        canceledAt: o.canceled_at ? 'x' : null,
      })),
      (owedL!.results as { from_key: string; to_key: string; amount: number }[]).map((l) => ({
        inflowKey: l.from_key,
        itemId: l.to_key,
        amount: cents(l.amount),
      })),
      f.today,
    ),
  );
  const view: ReportsView = {
    month: m,
    monthToDate: m === f.current,
    tiles: {
      spent: cents(spentOf(m, 'spending')),
      invested: cents(spentOf(m, 'saving')),
      income: cents(income.get(m) ?? 0),
      rewards: cents(rewards.get(m) ?? 0),
    },
    byCategory,
    stillOwed,
    trend: months.map((mm) => ({
      month: mm,
      spent: cents(spentOf(mm, 'spending')),
      income: cents(income.get(mm) ?? 0),
      invested: cents(spentOf(mm, 'saving')),
    })),
    netWorth,
  };
  return c.json(view);
});
