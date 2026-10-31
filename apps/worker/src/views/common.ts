// Shared reads for the views: freshness (recompute before answering), month rows, categories, targets, cards.
import {
  type Cents,
  type Month,
  type MonthResult,
  type StoredMonth,
  type Target,
  type TargetVersion,
  addMonths,
  cents,
  currentMonth,
  decodeMonth,
  localDate,
  computeBudget,
} from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { recompute } from '../budget/recompute.js';
import type { Env } from '../env.js';

export interface BudgetRow {
  id: string;
  name: string;
  time_zone: string;
  budget_start_month: string | null;
  rta: number;
  summary_dirty_from: string | null;
  summary_month: string | null;
}

export interface Fresh {
  budget: BudgetRow;
  current: Month;
  today: string;
  rtaUpdating: boolean;
}

/** Recomputes (at most one chunk) before answering, as the design requires; older edits finish in the Workflow. */
export async function fresh(
  env: Env,
  s: Scoped,
  now: number,
  startRecompute?: () => Promise<void>,
): Promise<Fresh> {
  const r = await recompute(s.db, s.budgetId, now);
  if (!r.done && startRecompute) await startRecompute();
  const budget = (await s.first<BudgetRow>(
    `SELECT id, name, time_zone, budget_start_month, rta, summary_dirty_from, summary_month FROM budget WHERE id = ?1`,
  ))!;
  void env;
  return {
    budget,
    current: currentMonth(now, budget.time_zone),
    today: localDate(now, budget.time_zone),
    rtaUpdating: budget.summary_dirty_from !== null,
  };
}

export interface CategoryInfo {
  id: string;
  name: string;
  kind: 'spending' | 'saving' | 'cc_payment';
  group_id: string | null;
  card_account_id: string | null;
  low_threshold: number | null;
  due_day: number | null;
  sort: number;
  archived_at: number | null;
}

export interface GroupInfo {
  id: string;
  name: string;
  is_bills: number;
  sort: number;
  archived_at: number | null;
}

export async function structure(
  s: Scoped,
): Promise<{ categories: CategoryInfo[]; groups: GroupInfo[]; targets: Map<string, TargetVersion[]> }> {
  const [c, g, t] = await s.batch([
    s.q(
      `SELECT id, name, kind, group_id, card_account_id, low_threshold, due_day, sort, archived_at FROM category WHERE budget_id = ?1 ORDER BY sort, name`,
    ),
    s.q(
      `SELECT id, name, is_bills, sort, archived_at FROM category_group WHERE budget_id = ?1 ORDER BY sort, name`,
    ),
    s.q(
      `SELECT category_id, type, amount, period_months, period_anchor, target_month, monthly_contribution, effective_from FROM target WHERE budget_id = ?1`,
    ),
  ]);
  const targets = new Map<string, TargetVersion[]>();
  for (const r of t!.results as {
    category_id: string;
    type: string;
    amount: number;
    period_months: number;
    period_anchor: string | null;
    target_month: string | null;
    monthly_contribution: number | null;
    effective_from: string;
  }[]) {
    const v: TargetVersion = { effectiveFrom: r.effective_from as Month, target: toTarget(r) };
    targets.set(r.category_id, [...(targets.get(r.category_id) ?? []), v]);
  }
  return { categories: c!.results as CategoryInfo[], groups: g!.results as GroupInfo[], targets };
}

export function toTarget(r: {
  type: string;
  amount: number;
  period_months: number;
  period_anchor: string | null;
  target_month: string | null;
  monthly_contribution: number | null;
  effective_from: string;
}): Target | null {
  switch (r.type) {
    case 'refill':
      return {
        type: 'refill',
        amount: cents(r.amount),
        periodMonths: r.period_months,
        anchor: (r.period_anchor ?? r.effective_from) as Month,
      };
    case 'set_aside':
      return { type: 'set_aside', amount: cents(r.amount) };
    case 'by_date':
      return { type: 'by_date', amount: cents(r.amount), targetMonth: r.target_month as Month };
    case 'no_date':
      return {
        type: 'no_date',
        amount: cents(r.amount),
        monthly: r.monthly_contribution === null ? null : cents(r.monthly_contribution),
      };
    default:
      return null;
  }
}

/**
 * The computed month (cells + snapshot). Months after the last computed one carry forward with no activity; months
 * before the budget start are empty.
 */
export async function monthResult(s: Scoped, m: Month, start: Month): Promise<MonthResult | null> {
  if (m < start) return null;
  const row = await s.first<{ state: string }>(
    `SELECT state FROM month_snapshot WHERE budget_id = ?1 AND month = ?2`,
    m,
  );
  if (row) return decodeMonth(JSON.parse(row.state) as StoredMonth);
  const last = await s.first<{ month: string; state: string }>(
    `SELECT month, state FROM month_snapshot WHERE budget_id = ?1 AND month < ?2 ORDER BY month DESC LIMIT 1`,
    m,
  );
  if (!last) return null;
  const cats = await s.all<{
    id: string;
    kind: 'spending' | 'saving' | 'cc_payment';
    card_account_id: string | null;
  }>(`SELECT id, kind, card_account_id FROM category WHERE budget_id = ?1`);
  const snap = (JSON.parse(last.state) as StoredMonth).s;
  const r = computeBudget({
    startMonth: start,
    currentMonth: addMonths(snap.month, 1),
    categories: cats.map((c) => ({ id: c.id, kind: c.kind, cardAccountId: c.card_account_id })),
    assignments: [],
    lines: [],
    snapshot: snap,
    through: m,
  });
  return r.months.find((x) => x.month === m) ?? null;
}

export interface CardInfo {
  accountId: string;
  name: string;
  /** Bank-reported amount owed (positive). */
  bank: Cents;
  /** Working debt: bank + budgeted pending (won't-clear excluded). */
  working: Cents;
  pending: Cents;
  uncategorized: Cents;
  statement: { balance: Cents; due: string | null } | null;
}

/** Card accounts with what rule 7 needs: working debt, budgeted pending, uncategorized card spending, statement. */
export async function cards(s: Scoped, today: string): Promise<CardInfo[]> {
  const [acc, pend, uncat, stmt] = await s.batch([
    s.q(
      `SELECT a.id, a.name, coalesce(pa.current_balance, 0) AS bank, a.starting_balance, a.budget_from, a.provider_account_id
       FROM account a LEFT JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
       WHERE a.budget_id = ?1 AND a.kind = 'credit' AND a.closed_at IS NULL ORDER BY a.sort, a.name`,
    ),
    s.q(
      `SELECT account_id, sum(-amount) AS pending FROM v_transaction WHERE budget_id = ?1 AND account_kind = 'credit' AND status IN ('pending', 'upcoming')
         AND wont_clear = 0 AND (status != 'upcoming' OR date <= ?2) GROUP BY account_id`,
      today,
    ),
    s.q(
      `SELECT account_id, sum(-amount) AS u FROM budget_line WHERE budget_id = ?1 AND kind = 'uncat' AND card = 0 GROUP BY account_id`,
    ),
    s.q(
      `SELECT l.provider_account_id, l.statement_balance, l.due_date FROM liability_snapshot l
       WHERE l.budget_id = ?1 AND l.created_at = (SELECT max(created_at) FROM liability_snapshot x WHERE x.budget_id = l.budget_id AND x.provider_account_id = l.provider_account_id)`,
    ),
  ]);
  const pending = new Map(
    (pend!.results as { account_id: string; pending: number }[]).map((r) => [r.account_id, r.pending]),
  );
  const unc = new Map(
    (uncat!.results as { account_id: string; u: number }[]).map((r) => [r.account_id, r.u]),
  );
  const st = new Map(
    (
      stmt!.results as {
        provider_account_id: string;
        statement_balance: number | null;
        due_date: string | null;
      }[]
    ).map((r) => [r.provider_account_id, r]),
  );
  return (
    acc!.results as {
      id: string;
      name: string;
      bank: number;
      provider_account_id: string | null;
      starting_balance: number;
    }[]
  ).map((a) => {
    const p = pending.get(a.id) ?? 0;
    const sb = a.provider_account_id ? st.get(a.provider_account_id) : undefined;
    const bank = a.provider_account_id ? a.bank : -a.starting_balance;
    return {
      accountId: a.id,
      name: a.name,
      bank: cents(bank),
      working: cents(bank + p),
      pending: cents(p),
      uncategorized: cents(unc.get(a.id) ?? 0),
      statement:
        sb && sb.statement_balance !== null
          ? { balance: cents(sb.statement_balance), due: sb.due_date }
          : null,
    };
  });
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function shortDate(d: string | null): string {
  if (!d) return '';
  return `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(d.slice(8, 10))}`;
}

export function monthLong(m: string): string {
  return MONTH_NAMES[Number(m.slice(5, 7)) - 1]!;
}
