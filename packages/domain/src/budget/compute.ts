// computeBudget(): the only implementation of the Money rules and of Ready to Assign. The incremental path (start
// from a month snapshot) and the daily full recompute both call it. Rules refer to Sync spec, Money rules (exact).
import { type Cents, cents } from '../money.js';
import { type Month, addMonths, monthRange } from '../month.js';
import { type BudgetLine, lineOrder } from './lines.js';

export type CategoryKind = 'spending' | 'saving' | 'cc_payment';

export interface BudgetCategory {
  id: string;
  kind: CategoryKind;
  /** Card account for cc_payment categories. */
  cardAccountId?: string | null;
}

export interface Assignment {
  categoryId: string;
  month: Month;
  amount: Cents;
}

interface Funded {
  /** Purchase amount (positive). */
  x: number;
  /** Funded part, including any credit overspending the category covered by month end. */
  f: number;
  /** Part forgiven at month end as credit overspending (new card debt). */
  forgiven: number;
  /** How much of f and of forgiven later refunds have taken back. */
  refundedFunded: number;
  refundedForgiven: number;
  month: Month;
  card: string;
}

/** Carry-forward state at the end of a month (after month-end processing). */
export interface MonthSnapshot {
  month: Month;
  /** Available carried into the next month, per non-payment category. */
  carry: Record<string, number>;
  /** Card payment category available carried into the next month, per card account. */
  pay: Record<string, number>;
  /** Running Ready to Assign components through this month. */
  cum: { inflows: number; owed: number; assigned: number; uncovered: number };
  /** Unbudgeted card debt per card account at the end of this month. */
  unbudgeted?: Record<string, number>;
  /** Funding of card purchases that refunds may link to later. */
  funded: Record<string, Funded>;
}

export interface CategoryCell {
  assigned: Cents;
  /** Net activity this month (inflows minus outflows and close-outs). */
  activity: Cents;
  /** Outflows this month, positive (cash and card, your share only). */
  spent: Cents;
  /** Available at the end of the month, before month-end resets (what the month view shows). */
  available: Cents;
  /** Credit overspending left at month end, by card account (rule 2). */
  creditOverspent: Record<string, Cents>;
  /** Cash overspending at month end (rule 6). */
  cashOverspent: Cents;
}

export interface CardCell {
  assigned: Cents;
  activity: Cents;
  /** Payment category available at month end, before a negative balance is moved to RTA (rule 6). */
  available: Cents;
}

export interface MonthResult {
  month: Month;
  categories: Record<string, CategoryCell>;
  /** Keyed by card account id. */
  cards: Record<string, CardCell>;
  inflows: Cents;
  owed: Cents;
  uncovered: Cents;
  snapshot: MonthSnapshot;
}

export interface ComputeInput {
  startMonth: Month;
  /** Today's month in the budget's time zone. */
  currentMonth: Month;
  categories: readonly BudgetCategory[];
  /** Assignments for months >= the first computed month. */
  assignments: readonly Assignment[];
  /** Lines for months >= the first computed month, in any order. */
  lines: readonly BudgetLine[];
  /** Start from the snapshot at the end of the month before the first computed month. */
  snapshot?: MonthSnapshot;
  /** Compute through at least this month (e.g. a future month being viewed). */
  through?: Month;
  /**
   * Purchase line ids that refunds link to (txn_link refund_of). Only their funding is kept in month snapshots;
   * when omitted, every card purchase is kept (fine for tests and full recomputes).
   */
  refundTargets?: ReadonlySet<string>;
}

export interface RtaParts {
  /** RTA inflows with a budget month up to the current month. */
  inflows: Cents;
  /** Owed parts of outflows up to the current month (rule 5, Reimbursement links). */
  owed: Cents;
  /** Everything assigned in every month, future months included. */
  assigned: Cents;
  /** Cash overspending left uncovered at the end of each past month (rule 6). */
  uncovered: Cents;
}

export interface ComputeResult {
  from: Month;
  through: Month;
  months: MonthResult[];
  rta: Cents;
  rtaParts: RtaParts;
  /** Unbudgeted card debt per card account as of now (current month, before its month end). */
  unbudgetedCardDebt: Record<string, Cents>;
}

export function emptySnapshot(month: Month): MonthSnapshot {
  return {
    month,
    carry: {},
    pay: {},
    cum: { inflows: 0, owed: 0, assigned: 0, uncovered: 0 },
    unbudgeted: {},
    funded: {},
  };
}

interface Chunk {
  line: string;
  card: string;
  amount: number;
}

export function computeBudget(input: ComputeInput): ComputeResult {
  const { currentMonth, startMonth } = input;
  const from = input.snapshot ? addMonths(input.snapshot.month, 1) : startMonth;
  if (input.snapshot && input.snapshot.month >= currentMonth) {
    // RTA subtracts overspending of months before the current one, so recompute from at least the current month.
    throw new RangeError('computeBudget: the snapshot must be from a month before the current month');
  }
  const prev = input.snapshot ?? emptySnapshot(addMonths(startMonth, -1));

  const payCatToCard = new Map<string, string>();
  const nonPay: string[] = [];
  const cardIds = new Set<string>();
  for (const c of input.categories) {
    if (c.kind === 'cc_payment') {
      if (!c.cardAccountId) throw new Error(`cc_payment category ${c.id} has no card`);
      payCatToCard.set(c.id, c.cardAccountId);
      cardIds.add(c.cardAccountId);
    } else nonPay.push(c.id);
  }

  let through = currentMonth > from ? currentMonth : from;
  if (input.through && input.through > through) through = input.through;
  const asgByMonth = new Map<Month, Map<string, number>>();
  for (const a of input.assignments) {
    if (a.month < from) continue;
    if (a.month > through) through = a.month;
    let m = asgByMonth.get(a.month);
    if (!m) asgByMonth.set(a.month, (m = new Map()));
    m.set(a.categoryId, (m.get(a.categoryId) ?? 0) + a.amount);
  }
  const linesByMonth = new Map<Month, BudgetLine[]>();
  for (const l of input.lines) {
    if (l.month < from) continue;
    if (l.month > through) through = l.month;
    if (l.kind === 'payment' || l.kind === 'debt') cardIds.add(l.cardAccountId);
    else if ((l.kind === 'cat' || l.kind === 'owed' || l.kind === 'rta') && l.card) cardIds.add(l.accountId);
    let arr = linesByMonth.get(l.month);
    if (!arr) linesByMonth.set(l.month, (arr = []));
    arr.push(l);
  }

  const carry = new Map<string, number>(Object.entries(prev.carry));
  const pay = new Map<string, number>(Object.entries(prev.pay));
  const funded = new Map<string, Funded>(Object.entries(prev.funded).map(([k, v]) => [k, { ...v }]));
  const cum = { ...prev.cum };
  // Unbudgeted card debt per card (see identity.ts): starting debt, minus assignments to the payment category,
  // plus credit overspending forgiven at month end, minus negative payment balances moved to RTA.
  const K = new Map<string, number>(Object.entries(prev.unbudgeted ?? {}));
  let kAtCurrent: Record<string, number> | null = null;
  // RTA components as of the current month, captured while walking forward.
  let inflowsAtCurrent = 0;
  let owedAtCurrent = 0;
  let uncoveredBeforeCurrent = 0;

  const months: MonthResult[] = [];
  for (const m of monthRange(from, through)) {
    const asg = asgByMonth.get(m);
    const A = new Map<string, number>();
    const assignedC = new Map<string, number>();
    const act = new Map<string, number>();
    const spent = new Map<string, number>();
    for (const id of nonPay) {
      const a = asg?.get(id) ?? 0;
      assignedC.set(id, a);
      A.set(id, (carry.get(id) ?? 0) + a);
    }
    const P = new Map<string, number>();
    const cardAsg = new Map<string, number>();
    const cardAct = new Map<string, number>();
    for (const card of cardIds) P.set(card, pay.get(card) ?? 0);
    if (asg) {
      for (const [catId, amt] of asg) {
        const card = payCatToCard.get(catId);
        if (card !== undefined) {
          P.set(card, (P.get(card) ?? 0) + amt);
          cardAsg.set(card, (cardAsg.get(card) ?? 0) + amt);
          K.set(card, (K.get(card) ?? 0) - amt);
        } else if (!A.has(catId)) {
          // Assignment to a category not in the list (archived or deleted): still counted.
          A.set(catId, (carry.get(catId) ?? 0) + amt);
          assignedC.set(catId, amt);
        }
      }
    }
    let monthAssigned = 0;
    if (asg) for (const v of asg.values()) monthAssigned += v;

    const chunks = new Map<string, Chunk[]>();
    let inflows = 0;
    let owed = 0;
    const lines = (linesByMonth.get(m) ?? []).sort(lineOrder);
    for (const l of lines) {
      switch (l.kind) {
        case 'rta':
          inflows += l.amount;
          if (l.card && l.amount > 0) {
            // A statement credit or other RTA inflow on a card gives back what the payment category held for the
            // debt it erased, as an unlinked refund does (rule 3, rule 7; decisions.md D-13).
            const Pv = P.get(l.accountId) ?? 0;
            const g = Math.min(l.amount, Math.max(Pv, 0));
            P.set(l.accountId, Pv - g);
            cardAct.set(l.accountId, (cardAct.get(l.accountId) ?? 0) - g);
          }
          break;
        case 'debt':
          K.set(l.cardAccountId, (K.get(l.cardAccountId) ?? 0) + l.amount);
          break;
        case 'owed': {
          owed += l.amount;
          if (l.card) {
            // Rule 5: moved to the card's payment category in full, not capped by what RTA holds.
            P.set(l.accountId, (P.get(l.accountId) ?? 0) + l.amount);
            cardAct.set(l.accountId, (cardAct.get(l.accountId) ?? 0) + l.amount);
          }
          break;
        }
        case 'close': {
          // Rule 11: charge the original category in this month and give RTA the same amount back.
          A.set(l.categoryId, (A.get(l.categoryId) ?? carry.get(l.categoryId) ?? 0) - l.amount);
          act.set(l.categoryId, (act.get(l.categoryId) ?? 0) - l.amount);
          spent.set(l.categoryId, (spent.get(l.categoryId) ?? 0) + l.amount);
          inflows += l.amount;
          break;
        }
        case 'payment': {
          // Rule 4: a transfer; P −= amount. No category is involved.
          P.set(l.cardAccountId, (P.get(l.cardAccountId) ?? 0) - l.amount);
          cardAct.set(l.cardAccountId, (cardAct.get(l.cardAccountId) ?? 0) - l.amount);
          break;
        }
        case 'cat': {
          const c = l.categoryId;
          let a = A.get(c) ?? carry.get(c) ?? 0;
          act.set(c, (act.get(c) ?? 0) + l.amount);
          if (l.amount < 0) {
            const x = -l.amount;
            spent.set(c, (spent.get(c) ?? 0) + x);
            if (!l.card) {
              a -= x; // rule 1
            } else {
              // Rule 2: funded f = clamp(A, 0, x); A −= x; P += f; the rest is credit overspending.
              const f = Math.min(Math.max(a, 0), x);
              a -= x;
              P.set(l.accountId, (P.get(l.accountId) ?? 0) + f);
              cardAct.set(l.accountId, (cardAct.get(l.accountId) ?? 0) + f);
              if (x - f > 0) {
                let arr = chunks.get(c);
                if (!arr) chunks.set(c, (arr = []));
                arr.push({ line: l.id, card: l.accountId, amount: x - f });
              }
              funded.set(l.id, {
                x,
                f,
                forgiven: 0,
                refundedFunded: 0,
                refundedForgiven: 0,
                month: m,
                card: l.accountId,
              });
            }
          } else if (l.amount > 0) {
            const r = l.amount;
            spent.set(c, (spent.get(c) ?? 0) - r);
            if (!l.card) {
              a += r;
            } else {
              // Rule 3: card refund. P gives back what it had set aside for the purchase.
              const card = l.accountId;
              const p = l.refundOf ? funded.get(l.refundOf) : undefined;
              const Pv = P.get(card) ?? 0;
              if (p) {
                const g = Math.min(r, p.f - p.refundedFunded);
                p.refundedFunded += g;
                P.set(card, Pv - g);
                cardAct.set(card, (cardAct.get(card) ?? 0) - g);
                const rest = r - g;
                if (p.month === m) {
                  // Same month: the refund cancels that purchase's credit overspending, so it no longer counts in
                  // the credit/cash split at month end.
                  const ch = chunks.get(c)?.find((k) => k.line === l.refundOf);
                  if (ch) ch.amount -= Math.min(rest, ch.amount);
                }
                a += r;
              } else {
                const g = Math.min(r, Math.max(Pv, 0));
                P.set(card, Pv - g);
                cardAct.set(card, (cardAct.get(card) ?? 0) - g);
                a += r;
              }
            }
          }
          A.set(c, a);
          break;
        }
      }
    }

    if (m === currentMonth) kAtCurrent = Object.fromEntries(K);

    // Month end (rule 6 and rule 2's reset).
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
    const cards: Record<string, CardCell> = {};
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

    if (m === currentMonth) uncoveredBeforeCurrent = cum.uncovered;
    cum.inflows += inflows;
    cum.owed += owed;
    cum.assigned += monthAssigned;
    cum.uncovered += uncovered;
    if (m === currentMonth) {
      inflowsAtCurrent = cum.inflows;
      owedAtCurrent = cum.owed;
    }

    const snapFunded: Record<string, Funded> = {};
    for (const [k, v] of funded)
      if (!input.refundTargets || input.refundTargets.has(k)) snapFunded[k] = { ...v };
    months.push({
      month: m,
      categories,
      cards,
      inflows: cents(inflows),
      owed: cents(owed),
      uncovered: cents(uncovered),
      snapshot: {
        month: m,
        carry: Object.fromEntries(carry),
        pay: Object.fromEntries(pay),
        cum: { ...cum },
        unbudgeted: Object.fromEntries(K),
        funded: snapFunded,
      },
    });
  }

  const rtaParts: RtaParts = {
    inflows: cents(inflowsAtCurrent),
    owed: cents(owedAtCurrent),
    assigned: cents(cum.assigned),
    uncovered: cents(uncoveredBeforeCurrent),
  };
  const rta = cents(rtaParts.inflows - rtaParts.owed - rtaParts.assigned - rtaParts.uncovered);
  const unbudgetedCardDebt: Record<string, Cents> = {};
  for (const c of cardIds) unbudgetedCardDebt[c] = cents(0);
  for (const [k, v] of Object.entries(kAtCurrent ?? Object.fromEntries(K))) unbudgetedCardDebt[k] = cents(v);
  return { from, through, months, rta, rtaParts, unbudgetedCardDebt };
}
