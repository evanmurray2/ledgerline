// BudgetView: Budget (home) with its Needs attention filter.
import type { AttentionItem, BudgetCategoryRow, BudgetView, CardRow } from '@ledgerline/contracts';
import {
  type Cents,
  type Month,
  type StatusInput,
  addMonths,
  cardStatus,
  categoryStatus,
  cents,
  describeTarget,
  formatCents,
  neededThisMonth,
  owedList,
  owedOut,
  projectedFronts,
  refillPeriod,
  statementCovered,
  suggestedFix,
  targetFor,
} from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import {
  cards as loadCards,
  monthLong,
  monthResult,
  shortDate,
  structure,
  type CategoryInfo,
  type Fresh,
} from './common.js';
import { txnCol } from '../ledger/ledger.js';

const fmt = (c: number) => formatCents(c);

export interface CategoryComputed {
  info: CategoryInfo;
  row: BudgetCategoryRow;
  isBill: boolean;
}

/** Category rows for a month: cells, targets, need, status, detail and fix. Shared by Budget and the Assign sheet. */
export async function categoryRows(
  s: Scoped,
  month: Month,
  start: Month,
  today: string,
): Promise<{
  rows: CategoryComputed[];
  cards: Map<string, { available: Cents }>;
  groups: Awaited<ReturnType<typeof structure>>['groups'];
}> {
  const { categories, groups, targets } = await structure(s);
  const cur = await monthResult(s, month, start);
  const prev = month > start ? await monthResult(s, addMonths(month, -1), start) : null;
  const billGroups = new Set(groups.filter((g) => g.is_bills).map((g) => g.id));
  const cardIds = new Map<string, { available: Cents }>();
  for (const [id, c] of Object.entries(cur?.cards ?? {})) cardIds.set(id, { available: c.available });
  // Multi-month refill periods need the period start's carry and what was assigned earlier in the period.
  const periodCache = new Map<Month, Awaited<ReturnType<typeof monthResult>>>();
  const monthAt = async (m: Month) => {
    if (!periodCache.has(m)) periodCache.set(m, await monthResult(s, m, start));
    return periodCache.get(m)!;
  };
  const rows: CategoryComputed[] = [];
  for (const info of categories) {
    if (info.kind === 'cc_payment') continue;
    const cell = cur?.categories[info.id];
    const assigned = cell?.assigned ?? cents(0);
    const available = cell?.available ?? cents(prev?.snapshot.carry[info.id] ?? 0);
    const spent = cell?.spent ?? cents(0);
    const X = cents(prev?.snapshot.carry[info.id] ?? 0);
    const versions = targets.get(info.id) ?? [];
    const target = targetFor(versions, month);
    let S = X;
    let P = cents(0);
    let periodFrom: Month | undefined;
    if (target?.type === 'refill' && target.periodMonths > 1) {
      // The period counts from the later of its start, the budget start and the month this target was set.
      const set = versions.reduce<Month | null>(
        (b, v) => (v.effectiveFrom <= month && (!b || v.effectiveFrom > b) ? v.effectiveFrom : b),
        null,
      );
      const p = refillPeriod(target, month);
      let from = p.start > start ? p.start : start;
      if (set && set > from) from = set;
      periodFrom = from;
      if (from < month) {
        const before = from > start ? await monthAt(addMonths(from, -1)) : null;
        S = cents(before?.snapshot.carry[info.id] ?? 0);
        let sum = 0;
        for (let m = from; m < month; m = addMonths(m, 1))
          sum += (await monthAt(m))?.categories[info.id]?.assigned ?? 0;
        P = cents(sum);
      }
    }
    const need = neededThisMonth(target, {
      month,
      assignedThisMonth: assigned,
      availableAtMonthStart: X,
      availableAtPeriodStart: S,
      assignedEarlierInPeriod: P,
      periodFrom,
    });
    const isBill = (info.group_id !== null && billGroups.has(info.group_id)) || info.due_day !== null;
    const st: StatusInput = {
      kind: info.kind,
      isBill,
      target,
      available,
      spent,
      assignedThisMonth: assigned,
      need,
      lowThreshold: info.low_threshold === null ? null : cents(info.low_threshold),
      month,
      today,
    };
    const status = categoryStatus(st);
    const fixAmount = suggestedFix(status, st);
    const verb =
      status === 'overspent'
        ? 'Cover'
        : status === 'underfunded'
          ? 'Fund'
          : status === 'low'
            ? 'Add'
            : status === 'overfunded'
              ? 'Move'
              : null;
    const credit = Object.entries(cell?.creditOverspent ?? {}).map(([cardAccountId, amount]) => ({
      cardAccountId,
      cardName: '',
      amount,
    }));
    const tAmount = target && 'amount' in target ? target.amount : null;
    let detail: string;
    if (status === 'overspent')
      detail = credit.length ? 'overspent on a card · its payment is short' : 'overspent';
    else if (status === 'invested') detail = `${fmt(spent)} invested this month`;
    else if (status === 'no_target') detail = 'No target';
    else if (target?.type === 'by_date')
      detail =
        status === 'underfunded'
          ? `needs ${fmt(need)} this month · ${describeTarget(target, fmt).replace(/\.00\b/g, '')}`
          : `this month’s share is in · ${describeTarget(target, fmt).replace(/\.00\b/g, '')}`;
    else if (status === 'overfunded' && tAmount !== null)
      // The same amount the Move fix offers. A Set aside target is overfunded by the extra assigned this month that is
      // still unspent (D-69), which can leave less than the target available.
      detail =
        target?.type === 'set_aside'
          ? `${fmt(-fixAmount)} extra assigned is unspent · this month’s ${fmt(tAmount)}`
          : `${fmt(-fixAmount)} more than this month’s ${fmt(tAmount)}`;
    else if (status === 'underfunded') detail = `needs ${fmt(need)} this month`;
    else if (tAmount !== null && target?.type !== 'no_date') {
      // Matches the bar, which shows what's left of the month's money (spent + available).
      detail = `${fmt(available)} left of ${fmt(spent + available > 0 ? spent + available : tAmount)}`;
      if (X > 0 && status !== 'low' && target?.type === 'refill' && month > start)
        detail += ` · ${fmt(X)} carried from ${monthLong(addMonths(month, -1))}`;
    } else if (target?.type === 'no_date')
      detail =
        available >= target.amount
          ? `goal ${fmt(target.amount)} reached`
          : `${fmt(available)} of ${fmt(target.amount)}`;
    else detail = '';
    const total = spent + available;
    const leftPercent =
      tAmount !== null && status !== 'overfunded' && total > 0
        ? Math.max(0, Math.min(100, Math.round((available * 100) / total)))
        : null;
    rows.push({
      info,
      isBill,
      row: {
        id: info.id,
        name: info.name,
        kind: info.kind,
        assigned,
        spent,
        activity: cell?.activity ?? cents(0),
        available,
        status,
        detail,
        leftPercent: status === 'no_target' || status === 'invested' ? null : leftPercent,
        need,
        fix: verb && fixAmount !== 0 ? { verb, amount: fixAmount } : null,
        targetText: describeTarget(target, fmt),
        creditOverspent: credit,
      },
    });
  }
  return { rows, cards: cardIds, groups };
}

export async function budgetView(s: Scoped, f: Fresh, month: Month): Promise<BudgetView> {
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const { rows, cards: cardCells, groups } = await categoryRows(s, month, start, f.today);
  const cardInfo = await loadCards(s, f.today);
  const [cardCats, owedRows, links, fronts, conns, maxRow] = await s.batch([
    s.q(`SELECT id, card_account_id FROM category WHERE budget_id = ?1 AND kind = 'cc_payment'`),
    s.q(
      `SELECT e.id, e.txn_key, e.amount, e.expect_by, e.closed_at, e.canceled_at, coalesce(${txnCol('e.txn_key', 'payee')}, '') AS payee
       FROM expected_reimbursement e WHERE e.budget_id = ?1
         AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
    s.q(
      `SELECT m.txn_key, m.date, m.payee_name, e.amount FROM manual_pending m JOIN expected_reimbursement e ON e.budget_id = m.budget_id AND e.txn_key = m.txn_key
       WHERE m.budget_id = ?1 AND m.kind = 'upcoming' AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL AND e.canceled_at IS NULL`,
    ),
    s.q(
      `SELECT institution_name, status FROM connection WHERE budget_id = ?1 AND removed_at IS NULL AND status != 'ok'`,
    ),
    s.q(`SELECT max(month) AS m FROM month_snapshot WHERE budget_id = ?1`),
  ]);
  const catByCard = new Map(
    (cardCats!.results as { id: string; card_account_id: string }[]).map((r) => [r.card_account_id, r.id]),
  );
  const cardNames = new Map(cardInfo.map((c) => [c.accountId, c.name]));
  for (const r of rows)
    for (const co of r.row.creditOverspent) co.cardName = cardNames.get(co.cardAccountId) ?? '';
  for (const r of rows)
    if (r.row.status === 'overspent' && r.row.creditOverspent.length)
      r.row.detail = `overspent on ${r.row.creditOverspent.map((c) => c.cardName).join(', ')}`;

  const cardRows: CardRow[] = cardInfo.map((c) => {
    const available = cardCells.get(c.accountId)?.available ?? cents(0);
    const cs = cardStatus(available, c.working, c.uncategorized);
    const covered = c.statement ? statementCovered(available, c.statement.balance) : true;
    const detail =
      cs.short > 0
        ? `${fmt(cs.short)} of card spending not covered`
        : (c.statement
            ? `statement ${fmt(c.statement.balance)}${c.statement.due ? ` due ${shortDate(c.statement.due)}` : ''}`
            : 'covered') + (c.uncategorized ? ` · ${fmt(c.uncategorized)} waits for a category` : '');
    return {
      accountId: c.accountId,
      categoryId: catByCard.get(c.accountId) ?? '',
      name: c.name,
      available,
      owed: c.bank,
      budgetedPending: c.pending,
      uncategorized: c.uncategorized,
      need: cs.need,
      short: cs.short,
      status: cs.status,
      statement: c.statement ? { balance: c.statement.balance, due: c.statement.due, covered } : null,
      detail,
    };
  });

  const paybacks = (links!.results as { from_key: string; to_key: string; amount: number | null }[]).map(
    (l) => ({ inflowKey: l.from_key, itemId: l.to_key, amount: cents(l.amount ?? 0) }),
  );
  const items = (
    owedRows!.results as {
      id: string;
      txn_key: string;
      amount: number;
      expect_by: string | null;
      closed_at: number | null;
      canceled_at: number | null;
      payee: string;
    }[]
  ).map((o) => ({
    id: o.id,
    txnKey: o.txn_key,
    amount: cents(o.amount),
    expectBy: o.expect_by,
    closedAt: o.closed_at ? 'x' : null,
    canceledAt: o.canceled_at ? 'x' : null,
    payee: o.payee,
  }));
  const owed = owedList(items, paybacks, f.today);
  const late = owed.filter((o) => o.status === 'late');
  const out = owedOut(owed);

  const groupList = groups
    .filter((g) => !g.archived_at)
    .map((g) => {
      const cats = rows.filter((r) => r.info.group_id === g.id && !r.info.archived_at).map((r) => r.row);
      return {
        id: g.id,
        name: g.name,
        isBills: g.is_bills === 1,
        total: cents(cats.reduce((a, c) => a + c.available, 0)),
        categories: cats,
      };
    })
    .filter((g) => g.categories.length > 0);
  const ungrouped = rows.filter((r) => !r.info.group_id && !r.info.archived_at).map((r) => r.row);
  if (ungrouped.length)
    groupList.push({
      id: 'none',
      name: 'Other',
      isBills: false,
      total: cents(ungrouped.reduce((a, c) => a + c.available, 0)),
      categories: ungrouped,
    });
  const archived = rows
    .filter((r) => r.info.archived_at && (r.row.activity !== 0 || r.row.available !== 0))
    .map((r) => r.row);

  const attention: AttentionItem[] = [];
  const isCurrent = month === f.current;
  if (f.budget.rta < 0) {
    attention.push({
      section: 'Ready to Assign',
      key: 'rta-neg',
      name: 'Ready to Assign',
      amount: cents(f.budget.rta),
      detail: 'More is assigned than you have. Take it back from a category.',
      categoryId: null,
      fix: { verb: 'Move money', amount: cents(-f.budget.rta) },
      link: 'category',
    });
  }
  const sectionOf = {
    overspent: 'Overspent',
    underfunded: 'Underfunded',
    low: 'Low',
    overfunded: 'Overfunded',
  } as const;
  let underfundedTotal = 0;
  for (const r of rows) {
    if (r.info.archived_at) continue;
    const sec = sectionOf[r.row.status as keyof typeof sectionOf];
    if (!sec || !r.row.fix) continue;
    if (sec === 'Underfunded') underfundedTotal += r.row.fix.amount;
    attention.push({
      section: sec,
      key: r.row.id,
      name: r.row.name,
      amount: r.row.available,
      detail: r.row.detail,
      categoryId: r.row.id,
      fix: r.row.fix,
      link: null,
    });
  }
  // A Short card: fund its payment category with what covering its overspent categories won't (starting debt,
  // earlier months). Covering a category also funds the card, so that part isn't counted twice (as on Assign).
  for (const c of cardRows) {
    if (c.short <= 0 || !c.categoryId) continue;
    const creditFix = rows.reduce(
      (a, r) =>
        a +
        (r.info.archived_at
          ? 0
          : (r.row.creditOverspent.find((x) => x.cardAccountId === c.accountId)?.amount ?? 0)),
      0,
    );
    const fund = c.short - creditFix;
    const over = rows.filter(
      (r) => !r.info.archived_at && r.row.creditOverspent.some((x) => x.cardAccountId === c.accountId),
    );
    attention.push({
      section: 'Card payments',
      key: `card:${c.accountId}`,
      name: c.name,
      amount: c.available,
      detail:
        fund > 0
          ? `${fmt(c.short)} of card spending not covered`
          : `Cover ${over.map((r) => r.row.name).join(', ')} to cover this card`,
      categoryId: c.categoryId,
      fix: fund > 0 ? { verb: 'Fund', amount: cents(fund) } : null,
      link: 'card',
      accountId: c.accountId,
    });
  }
  if (isCurrent) {
    for (const o of late) {
      const it = items.find((i) => i.id === o.id)!;
      attention.push({
        section: 'Owed to you',
        key: `late:${o.id}`,
        name: it.payee || 'Owed to you',
        amount: o.stillOwed,
        detail: `Late: expected back by ${shortDate(o.expectBy)}`,
        categoryId: null,
        fix: { verb: 'Review', amount: o.stillOwed },
        link: 'owed',
      });
    }
    const scheduled = (
      fronts!.results as { txn_key: string; date: string; payee_name: string; amount: number }[]
    ).map((r) => ({ key: r.txn_key, date: r.date, owed: cents(r.amount), label: r.payee_name }));
    for (const p of projectedFronts(cents(f.budget.rta), scheduled, f.today)) {
      const lbl = scheduled.find((x) => x.key === p.key)!.label;
      attention.push({
        section: 'Owed to you',
        key: `front:${p.key}`,
        name: `${lbl} on ${shortDate(p.date)}`,
        amount: cents(-p.shortfall),
        detail: `Fronts ${fmt(p.owed)}. Ready to Assign has ${fmt(f.budget.rta)}, so it would go ${fmt(f.budget.rta - p.owed)}.`,
        categoryId: null,
        fix: { verb: 'Review', amount: p.shortfall },
        link: 'owed',
      });
    }
  }
  const problems = (conns!.results as { institution_name: string; status: string }[]).map(
    (c) =>
      `${c.institution_name} ${c.status === 'login_required' ? 'needs you to sign in again' : 'sync failed'}`,
  );
  const maxMonth = ((maxRow!.results[0] as { m: string | null } | undefined)?.m ?? f.current) as Month;
  return {
    month,
    currentMonth: f.current,
    minMonth: start,
    maxMonth: (maxMonth > addMonths(f.current, 1) ? maxMonth : addMonths(f.current, 1)) as Month,
    rta: cents(f.budget.rta),
    rtaUpdating: f.rtaUpdating,
    cards: cardRows,
    owed: { out, late: late.length, status: late.length ? 'late' : 'tracking' },
    groups: groupList,
    archived,
    attention,
    underfundedTotal: cents(underfundedTotal),
    syncProblem: problems[0] ?? null,
  };
}
