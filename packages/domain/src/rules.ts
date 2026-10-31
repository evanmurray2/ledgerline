// Categorization rules (design: Categorization rules and payee cleanup). Deterministic: payee resolution, then
// explicit rules top to bottom (first match wins unless a rule says to continue), then the payee's remembered
// category, then nothing. Rules never overwrite a category you set by hand (the caller skips user rows).
import { type Cents, cents, fractionOf } from './money.js';
import { type IsoDate, type Month, addMonths, dayOfMonth, monthOfDate } from './month.js';

export type Condition =
  | { field: 'payee'; op: 'is' | 'contains'; value: string }
  | { field: 'description'; op: 'contains' | 'matches'; value: string }
  | { field: 'account'; op: 'is'; value: string }
  | { field: 'amount'; op: 'equals'; value: Cents }
  | { field: 'amount'; op: 'between'; min: Cents; max: Cents }
  | { field: 'direction'; op: 'is'; value: 'in' | 'out' }
  | { field: 'provider_category'; op: 'is'; value: string }
  | { field: 'day_of_month'; op: 'between'; min: number; max: number };

export interface ConditionTree {
  /** Every condition must hold. */
  all: Condition[];
  /** Optional OR groups: at least one group must hold entirely. */
  any?: Condition[][];
}

export type Action =
  | { type: 'set_category'; categoryId: string }
  | { type: 'set_payee'; payeeId: string }
  | { type: 'set_memo'; memo: string }
  /** Fixed amounts (positive cents of the outflow) or percentages; one line absorbs the remainder. */
  | {
      type: 'split';
      lines: { categoryId: string; fixed?: Cents; percent?: number; absorbsRemainder?: boolean }[];
    }
  | { type: 'mark_transfer'; accountId: string }
  /** Mark part as expecting a payback: a fraction or a fixed amount, never more than the transaction. */
  | {
      type: 'mark_owed';
      num?: number;
      den?: number;
      fixed?: Cents;
      minAmount?: Cents;
      expectByDay?: number;
      expectByDays?: number;
    }
  | { type: 'previous_month_if_within_days'; days: number }
  | { type: 'flag_review' };

export interface Rule {
  id: string;
  name: string;
  conditions: ConditionTree;
  actions: Action[];
  applyToPending: boolean;
  stopAfter: boolean;
  enabled: boolean;
}

export interface RuleTxn {
  payeeId: string | null;
  payeeName: string;
  description: string;
  accountId: string;
  /** Outflow negative. */
  amount: Cents;
  date: IsoDate;
  pending: boolean;
  providerCategory: string | null;
}

export interface RuleResult {
  categoryId?: string;
  payeeId?: string;
  memo?: string;
  split?: { categoryId: string; amount: Cents; absorbsRemainder: boolean }[];
  transferTo?: string;
  owed?: { amount: Cents; num?: number; den?: number; expectBy: IsoDate | null };
  budgetMonth?: Month;
  flag?: boolean;
  /** Which rule set the category ('payee' for the remembered category). */
  by?: { ruleId: string } | 'payee';
}

export function conditionHolds(c: Condition, t: RuleTxn): boolean {
  switch (c.field) {
    case 'payee': {
      const p = t.payeeName.toLowerCase();
      return c.op === 'is'
        ? p === c.value.toLowerCase() || t.payeeId === c.value
        : p.includes(c.value.toLowerCase());
    }
    case 'description':
      if (c.op === 'contains') return t.description.toUpperCase().includes(c.value.toUpperCase());
      try {
        return new RegExp(c.value, 'i').test(t.description);
      } catch {
        return false;
      }
    case 'account':
      return t.accountId === c.value;
    case 'amount': {
      const a = Math.abs(t.amount);
      return c.op === 'equals' ? a === Math.abs(c.value) : a >= Math.abs(c.min) && a <= Math.abs(c.max);
    }
    case 'direction':
      return c.value === 'out' ? t.amount < 0 : t.amount > 0;
    case 'provider_category':
      return t.providerCategory === c.value;
    case 'day_of_month': {
      const d = dayOfMonth(t.date);
      return d >= c.min && d <= c.max;
    }
  }
}

export function treeHolds(tree: ConditionTree, t: RuleTxn): boolean {
  if (!tree.all.every((c) => conditionHolds(c, t))) return false;
  if (tree.any && tree.any.length > 0) return tree.any.some((g) => g.every((c) => conditionHolds(c, t)));
  return true;
}

/** Split an outflow by fixed amounts or percentages; the marked (default: largest) line absorbs the remainder. */
export function applySplit(
  amount: Cents,
  lines: Extract<Action, { type: 'split' }>['lines'],
): { categoryId: string; amount: Cents; absorbsRemainder: boolean }[] {
  const total = Math.abs(amount);
  const sign = amount < 0 ? -1 : 1;
  const parts = lines.map((l) =>
    l.fixed !== undefined
      ? Math.abs(l.fixed)
      : l.percent !== undefined
        ? Math.floor((total * l.percent) / 100)
        : 0,
  );
  let absorber = lines.findIndex((l) => l.absorbsRemainder);
  if (absorber < 0) absorber = parts.indexOf(Math.max(...parts));
  const rest = total - parts.reduce((a, b) => a + b, 0);
  parts[absorber] = (parts[absorber] ?? 0) + rest;
  return lines.map((l, i) => ({
    categoryId: l.categoryId,
    amount: cents(sign * (parts[i] ?? 0)),
    absorbsRemainder: i === absorber,
  }));
}

export function evaluateRules(
  t: RuleTxn,
  rules: readonly Rule[],
  payeeDefault: { categoryId: string; remember: boolean } | null,
): RuleResult {
  const out: RuleResult = {};
  for (const r of rules) {
    if (!r.enabled) continue;
    if (t.pending && !r.applyToPending) continue;
    if (!treeHolds(r.conditions, t)) continue;
    for (const a of r.actions) applyAction(out, a, t, r.id);
    if (r.stopAfter) break;
  }
  if (
    out.categoryId === undefined &&
    out.split === undefined &&
    out.transferTo === undefined &&
    payeeDefault?.remember
  ) {
    out.categoryId = payeeDefault.categoryId;
    out.by = 'payee';
  }
  return out;
}

function applyAction(out: RuleResult, a: Action, t: RuleTxn, ruleId: string): void {
  switch (a.type) {
    case 'set_category':
      if (out.categoryId === undefined && out.split === undefined) {
        out.categoryId = a.categoryId;
        out.by = { ruleId };
      }
      break;
    case 'set_payee':
      out.payeeId ??= a.payeeId;
      break;
    case 'set_memo':
      out.memo ??= a.memo;
      break;
    case 'split':
      if (out.categoryId === undefined && out.split === undefined) {
        out.split = applySplit(t.amount, a.lines);
        out.by = { ruleId };
      }
      break;
    case 'mark_transfer':
      out.transferTo ??= a.accountId;
      break;
    case 'mark_owed': {
      if (out.owed || t.amount >= 0) break;
      const x = cents(-t.amount);
      if (a.minAmount !== undefined && x <= a.minAmount) break;
      const amount =
        a.fixed !== undefined
          ? cents(Math.min(a.fixed, x))
          : a.num !== undefined && a.den
            ? fractionOf(x, a.num, a.den)
            : x;
      let expectBy: IsoDate | null = null;
      if (a.expectByDay) {
        // e.g. the 15th of the month the transaction counts in, or of the following month if already past
        const m = out.budgetMonth ?? monthOfDate(t.date);
        let target = `${m}-${String(a.expectByDay).padStart(2, '0')}`;
        if (target < t.date) target = `${addMonths(m, 1)}-${String(a.expectByDay).padStart(2, '0')}`;
        expectBy = target;
      } else if (a.expectByDays) {
        const d = new Date(
          Date.UTC(
            Number(t.date.slice(0, 4)),
            Number(t.date.slice(5, 7)) - 1,
            Number(t.date.slice(8, 10)) + a.expectByDays,
          ),
        );
        expectBy = d.toISOString().slice(0, 10);
      }
      out.owed = { amount, expectBy, ...(a.num !== undefined && a.den ? { num: a.num, den: a.den } : {}) };
      break;
    }
    case 'previous_month_if_within_days':
      if (dayOfMonth(t.date) <= a.days) out.budgetMonth ??= addMonths(monthOfDate(t.date), -1);
      break;
    case 'flag_review':
      out.flag = true;
      break;
  }
}

/**
 * "Always" offer: a payee categorized the same way every time, at least twice and never differently, gets a
 * one-tap rule offer. Payees with mixed history get none.
 */
export function shouldOfferAlways(history: readonly (string | null)[]): string | null {
  const cats = history.filter((c): c is string => c !== null);
  if (cats.length < 2) return null;
  return cats.every((c) => c === cats[0]) ? cats[0]! : null;
}
