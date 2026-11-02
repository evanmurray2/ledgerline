import type { AssignView, CategorySheet, TxnListRow } from '@ledgerline/contracts';
import {
  type Month,
  addMonths,
  cents,
  elapsedShare,
  formatCents,
  monthOfDate,
  targetFor,
} from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { categoryRows } from './budget.js';
import { cards as loadCards, monthLong, structure, type Fresh } from './common.js';
import { listRow, type ListSource } from './rows.js';
import { TX_COLUMNS } from '../ledger/ledger.js';

const fmt = (c: number) => formatCents(c);

const STATUS_WORD: Record<string, string> = {
  overspent: 'Overspent',
  underfunded: 'Underfunded',
  funded: 'Funded',
  overfunded: 'Overfunded',
  low: 'Low',
  invested: 'Invested',
  no_target: 'No target',
};

export async function categorySheet(
  s: Scoped,
  f: Fresh,
  id: string,
  month: Month,
): Promise<CategorySheet | null> {
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const { rows } = await categoryRows(s, month, start, f.today);
  const r = rows.find((x) => x.row.id === id);
  if (!r) return null;
  const { targets } = await structure(s);
  const target = targetFor(targets.get(id) ?? [], month);
  const [last, recent, count] = await s.batch([
    s.q(
      `SELECT amount FROM assignment WHERE budget_id = ?1 AND category_id = ?2 AND month = ?3`,
      id,
      addMonths(month, -1),
    ),
    s.q(
      `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND (category_id = ?2 OR key IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1 AND category_id = ?2))
         AND coalesce(budget_month, substr(date, 1, 7)) = ?3 ORDER BY date DESC, seq DESC LIMIT 3`,
      id,
      month,
    ),
    s.q(
      `SELECT count(*) AS n FROM v_transaction WHERE budget_id = ?1 AND (category_id = ?2 OR key IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1 AND category_id = ?2))
         AND coalesce(budget_month, substr(date, 1, 7)) = ?3`,
      id,
      month,
    ),
  ]);
  const spentPct =
    r.row.spent + r.row.available > 0 ? Math.round((r.row.spent * 100) / (r.row.spent + r.row.available)) : 0;
  const gone = Math.round(elapsedShare(month, f.today) * 100);
  let statusText = STATUS_WORD[r.row.status]!;
  if (r.row.status === 'low') statusText += ` · ${spentPct}% spent, ${gone}% of month gone`;
  if (r.row.status === 'underfunded') statusText += ` · needs ${fmt(r.row.need)}`;
  if (r.row.status === 'overspent') statusText += ` · ${fmt(-r.row.available)} over`;
  const others = rows.filter((x) => x.row.id !== id && !x.info.archived_at);
  const moveOptions = [
    ...others
      .filter((x) => x.row.status === 'overspent' || x.row.status === 'underfunded')
      .map((x) => ({
        id: x.row.id,
        label:
          x.row.status === 'overspent'
            ? `${x.row.name} (${fmt(x.row.available)}, overspent)`
            : `${x.row.name} (needs ${fmt(x.row.need)})`,
      })),
    { id: 'rta' as const, label: 'Ready to Assign' },
    ...others
      .filter((x) => x.row.status !== 'overspent' && x.row.status !== 'underfunded')
      .map((x) => ({ id: x.row.id, label: x.row.name })),
  ];
  const help =
    target?.type === 'refill'
      ? 'Leftover rolls over and lowers next month’s need'
      : target?.type === 'by_date'
        ? `Funded by the start of ${monthLong(target.targetMonth)}`
        : target?.type === 'set_aside'
          ? 'Assign the same amount every month'
          : target?.type === 'no_date'
            ? 'No date; contribute monthly if you like'
            : 'Add a target to see what this category needs';
  const accts = await accountNames(s);
  return {
    id,
    name: r.row.name,
    month,
    status: r.row.status,
    statusText,
    assigned: r.row.assigned,
    spent: r.row.spent,
    available: r.row.available,
    target: (target ?? { type: 'none' }) as CategorySheet['target'],
    targetText: r.row.targetText,
    targetHelp: help,
    lastMonthAssigned: cents((last!.results[0] as { amount: number } | undefined)?.amount ?? 0),
    rta: cents(f.budget.rta),
    recent: (recent!.results as ListSource[]).map((t) => listRow(t, accts, new Map())),
    recentTotal: (count!.results[0] as { n: number }).n,
    moveOptions,
  };
}

export async function accountNames(s: Scoped): Promise<Map<string, string>> {
  return new Map(
    (await s.all<{ id: string; name: string }>(`SELECT id, name FROM account WHERE budget_id = ?1`)).map(
      (a) => [a.id, a.name],
    ),
  );
}

/** Assign sheet: cover overspending first, then card shortfalls, then targets. */
export async function assignView(s: Scoped, f: Fresh, month: Month): Promise<AssignView> {
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const { rows, cards } = await categoryRows(s, month, start, f.today);
  const suggestions: AssignView['suggestions'] = [];
  for (const r of rows)
    if (r.row.status === 'overspent' && !r.info.archived_at)
      suggestions.push({
        categoryId: r.row.id,
        name: r.row.name,
        reason: 'cover',
        detail: `Cover ${fmt(-r.row.available)} of overspending`,
        amount: cents(-r.row.available),
      });
  const info = await loadCards(s, f.today);
  const cats = await s.all<{ id: string; card_account_id: string }>(
    `SELECT id, card_account_id FROM category WHERE budget_id = ?1 AND kind = 'cc_payment'`,
  );
  for (const c of info) {
    const P = cards.get(c.accountId)?.available ?? 0;
    // Card debt not covered beyond what covering overspending fixes (starting debt, earlier months).
    const creditFix = rows.reduce(
      (a, r) => a + (r.row.creditOverspent.find((x) => x.cardAccountId === c.accountId)?.amount ?? 0),
      0,
    );
    const short = c.working - c.uncategorized - P - creditFix;
    const cat = cats.find((x) => x.card_account_id === c.accountId);
    if (short > 0 && cat)
      suggestions.push({
        categoryId: cat.id,
        name: `${c.name} payment`,
        reason: 'card',
        detail: `Card debt not yet budgeted`,
        amount: cents(short),
      });
  }
  for (const r of rows) {
    if (r.row.need <= 0 || r.info.archived_at) continue;
    // One line per category: a target's need already funds this month's spending, so when it's also overspent
    // the larger of the two is suggested, never both added together.
    const cover = suggestions.find((x) => x.categoryId === r.row.id && x.reason === 'cover');
    if (cover) {
      if (r.row.need > cover.amount) {
        cover.amount = r.row.need;
        cover.detail = `${r.row.detail} · covers ${fmt(-r.row.available)} of overspending`;
      }
      continue;
    }
    suggestions.push({
      categoryId: r.row.id,
      name: r.row.name,
      reason: 'target',
      detail: r.row.detail,
      amount: r.row.need,
    });
  }
  void monthOfDate;
  return { month, rta: cents(f.budget.rta), suggestions };
}

export type { TxnListRow };
