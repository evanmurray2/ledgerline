// computeBudget's stages (compute.ts): each is a part of computeBudget moved out as it was, with no change in what it
// counts. Those that take `into` change the maps in it (the state computeBudget carries from month to month), in
// the order the code ran before. Not exported from the package.
import { type Cents, cents } from '../money.js';
import type { Month } from '../month.js';
import type { BudgetLine } from './lines.js';
import type {
  BudgetCategory,
  CardCell,
  CategoryCell,
  Chunk,
  ComputeInput,
  Funded,
  MonthSnapshot,
  RtaParts,
} from './compute.js';

/**
 * The purchase a category line belongs to, as its first line id: `<txn key>:<n>` → `<txn key>:0`. A split
 * purchase has one line per split (`:0`, `:1`, …); a refund links to the whole purchase (rule 3).
 */
export function purchaseOf(lineId: string): string {
  return `${lineId.slice(0, lineId.lastIndexOf(':'))}:0`;
}

/** The payment categories' cards, the other categories, and every card a payment category names. */
export function indexCategories(categories: readonly BudgetCategory[]): {
  payCatToCard: Map<string, string>;
  nonPay: string[];
  cardIds: Set<string>;
} {
  const payCatToCard = new Map<string, string>();
  const nonPay: string[] = [];
  const cardIds = new Set<string>();
  for (const c of categories) {
    if (c.kind === 'cc_payment') {
      if (!c.cardAccountId) throw new Error(`cc_payment category ${c.id} has no card`);
      payCatToCard.set(c.id, c.cardAccountId);
      cardIds.add(c.cardAccountId);
    } else nonPay.push(c.id);
  }
  return { payCatToCard, nonPay, cardIds };
}

/**
 * Assignments and lines by month, from `from`, and the last month to compute. Adds to `cardIds` every card a line
 * names.
 */
export function indexByMonth(
  input: ComputeInput,
  from: Month,
  cardIds: Set<string>,
): { through: Month; asgByMonth: Map<Month, Map<string, number>>; linesByMonth: Map<Month, BudgetLine[]> } {
  const { currentMonth } = input;
  let through = currentMonth > from ? currentMonth : from;
  if (input.through && input.through > through) through = input.through;
  const asgByMonth = new Map<Month, Map<string, number>>();
  for (const a of input.assignments) {
    if (a.month < from) continue;
    if (input.until && a.month > input.until) continue;
    if (a.month > through) through = a.month;
    let m = asgByMonth.get(a.month);
    if (!m) asgByMonth.set(a.month, (m = new Map()));
    m.set(a.categoryId, (m.get(a.categoryId) ?? 0) + a.amount);
  }
  if (input.until && input.until < through) through = input.until < from ? from : input.until;
  const linesByMonth = new Map<Month, BudgetLine[]>();
  for (const l of input.lines) {
    if (l.month < from) continue;
    if (input.until && l.month > input.until) continue;
    if (l.month > through) through = l.month;
    if (l.kind === 'payment' || l.kind === 'debt') cardIds.add(l.cardAccountId);
    else if ((l.kind === 'cat' || l.kind === 'owed' || l.kind === 'rta') && l.card) cardIds.add(l.accountId);
    let arr = linesByMonth.get(l.month);
    if (!arr) linesByMonth.set(l.month, (arr = []));
    arr.push(l);
  }
  return { through, asgByMonth, linesByMonth };
}

/**
 * Month end for the categories (rule 6 and rule 2's reset): each category's cell, its credit overspending forgiven
 * as new card debt (into K and the purchases' funding) and what it carries into next month; and the cash
 * overspending left uncovered.
 */
export function closeCategories(
  month: {
    A: Map<string, number>;
    chunks: Map<string, Chunk[]>;
    assignedC: Map<string, number>;
    act: Map<string, number>;
    spent: Map<string, number>;
  },
  into: { K: Map<string, number>; funded: Map<string, Funded>; carry: Map<string, number> },
): { categories: Record<string, CategoryCell>; uncovered: number } {
  const { A, chunks, assignedC, act, spent } = month;
  const { K, funded, carry } = into;
  const categories: Record<string, CategoryCell> = {};
  let uncovered = 0;
  for (const [c, a] of A) {
    const arr = chunks.get(c) ?? [];
    let co = 0;
    for (const k of arr) co += k.amount;
    let credit = 0;
    let cash = 0;
    if (a < 0) {
      credit = Math.min(-a, co);
      cash = -a - credit;
    }
    // The credit part is forgiven as new card debt: the latest unfunded purchases count as the overspending.
    let creditLeft = credit;
    const creditByCard: Record<string, Cents> = {};
    for (let i = arr.length - 1; i >= 0 && creditLeft > 0; i--) {
      const k = arr[i]!;
      const take = Math.min(creditLeft, k.amount);
      creditLeft -= take;
      creditByCard[k.card] = cents((creditByCard[k.card] ?? 0) + take);
      K.set(k.card, (K.get(k.card) ?? 0) + take);
      const fd = funded.get(k.line);
      if (fd) fd.forgiven += take;
    }
    uncovered += cash;
    categories[c] = {
      assigned: cents(assignedC.get(c) ?? 0),
      activity: cents(act.get(c) ?? 0),
      spent: cents(spent.get(c) ?? 0),
      available: cents(a),
      creditOverspent: creditByCard,
      cashOverspent: cents(cash),
    };
    carry.set(c, a < 0 ? 0 : a);
  }
  return { categories, uncovered };
}

/**
 * Month end for the card payment categories: each card's cell and what it carries into next month (into pay). A
 * negative payment category is cash overspending (rule 6, decisions.md D-10): uncovered, and taken off K.
 */
export function closeCards(
  month: {
    cardIds: Set<string>;
    P: Map<string, number>;
    cardAsg: Map<string, number>;
    cardAct: Map<string, number>;
  },
  into: { K: Map<string, number>; pay: Map<string, number> },
): { cards: Record<string, CardCell>; uncovered: number } {
  const { cardIds, P, cardAsg, cardAct } = month;
  const { K, pay } = into;
  const cards: Record<string, CardCell> = {};
  let uncovered = 0;
  for (const card of new Set([...cardIds, ...P.keys()])) {
    const pv = P.get(card) ?? 0;
    cards[card] = {
      assigned: cents(cardAsg.get(card) ?? 0),
      activity: cents(cardAct.get(card) ?? 0),
      available: cents(pv),
    };
    // Rule 6 covers every category, card payment categories included: paying a card beyond what its payment
    // category held is cash overspending (decisions.md D-10).
    if (pv < 0) {
      uncovered += -pv;
      K.set(card, (K.get(card) ?? 0) + pv);
      pay.set(card, 0);
    } else pay.set(card, pv);
  }
  return { cards, uncovered };
}

/** The carry-forward state at the end of month `m`: copies, so later months don't change it. */
export function snapshotOf(
  m: Month,
  s: {
    carry: Map<string, number>;
    pay: Map<string, number>;
    cum: MonthSnapshot['cum'];
    K: Map<string, number>;
    Cr: Map<string, number>;
    funded: Map<string, Funded>;
  },
  refundTargets: ReadonlySet<string> | undefined,
): MonthSnapshot {
  const snapFunded: Record<string, Funded> = {};
  for (const [k, v] of s.funded)
    if (!refundTargets || refundTargets.has(purchaseOf(k))) snapFunded[k] = { ...v };
  return {
    month: m,
    carry: Object.fromEntries(s.carry),
    pay: Object.fromEntries(s.pay),
    cum: { ...s.cum },
    unbudgeted: Object.fromEntries(s.K),
    credit: Object.fromEntries(s.Cr),
    funded: snapFunded,
  };
}

/** Ready to Assign from its parts. */
export function readyToAssign(p: RtaParts): Cents {
  return cents(p.inflows - p.owed - p.assigned - p.uncovered);
}

/** Unbudgeted card debt per card as of now: every card, 0 when it has none. */
export function debtNow(cardIds: Set<string>, k: Record<string, number>): Record<string, Cents> {
  const unbudgetedCardDebt: Record<string, Cents> = {};
  for (const c of cardIds) unbudgetedCardDebt[c] = cents(0);
  for (const [key, v] of Object.entries(k)) unbudgetedCardDebt[key] = cents(v);
  return unbudgetedCardDebt;
}
