// Your entry and a bank row (docs/payee-names.md 9, 9.1, 9.2): an entry you added (Add pending, or an Upcoming row)
// pairs with a bank row, posted or pending, only on exact evidence; otherwise you're asked "Same purchase?". Pure: the
// caller passes the candidate rows and applies the decisions in one batch.
import { type Cents } from './money.js';
import { type IsoDate, daysBetween } from './month.js';
import { withinTolerance, type MatchRow } from './matcher.js';
import { payeeNameKey } from './payee.js';

/** An entry you added, not yet paired. */
export interface EntryRow {
  key: string;
  accountId: string;
  amount: Cents;
  date: IsoDate;
  /** The name you typed. */
  name: string;
  channel: MatchRow['channel'];
}

/** A bank row an entry could pair with: a posted row (step 3 of 9.2) or a pending row (step 4, a cover). */
export interface BankSideRow {
  key: string;
  accountId: string;
  amount: Cents;
  date: IsoDate;
  authorizedDate: IsoDate | null;
  /** Plaid's names for the row as sent: `merchant_name` and `name` (the bank text when it has neither). */
  names: readonly string[];
  channel: MatchRow['channel'];
}

/** How many days before the bank row your entry can be dated, and how many after (D-72). */
export const ENTRY_DAYS_BEFORE = 14;
export const ENTRY_DAYS_AFTER = 7;

/**
 * Candidates (9): same account and sign, amount within tolerance (exact for checks and ACH; card purchases within $5
 * or 25% either way), and the entry dated 0–14 days before, or up to ENTRY_DAYS_AFTER days after, the bank row (you
 * often add a bill after the bank already has it).
 */
export function entryCandidate(e: EntryRow, b: BankSideRow): boolean {
  if (e.accountId !== b.accountId || Math.sign(e.amount) !== Math.sign(b.amount)) return false;
  const gap = daysBetween(e.date, b.date);
  if (gap < -ENTRY_DAYS_AFTER || gap > ENTRY_DAYS_BEFORE) return false;
  return withinTolerance(e.amount, b.amount, b.channel === 'other' ? e.channel : b.channel);
}

/**
 * Exact evidence (9) between an entry and a bank row: the name you typed equals one of the row's Plaid names (case,
 * outer spaces and apostrophes aside), or the same amount on the same day (the authorization day, else the date).
 */
export function entryEvidence(e: EntryRow, b: BankSideRow): boolean {
  const typed = payeeNameKey(e.name);
  if (typed && b.names.some((n) => payeeNameKey(n) === typed)) return true;
  return e.amount === b.amount && e.date === (b.authorizedDate ?? b.date);
}

export type EntryPairDecision =
  | { kind: 'pair'; bankKey: string; entryKey: string }
  /** "Same purchase?" for this bank row: these entries, best first (with exact evidence first). */
  | { kind: 'ask'; bankKey: string; candidates: string[] };

/**
 * Pairs bank rows with entries. A pair is made only on exact evidence, and only when each row is the other's one
 * candidate with evidence; a bank row with candidates but no such pair is asked about. `notSame` is a pair you
 * answered No to: it is never a candidate.
 */
export function pairEntries(
  bank: readonly BankSideRow[],
  entries: readonly EntryRow[],
  notSame: (bankKey: string, entryKey: string) => boolean = () => false,
): EntryPairDecision[] {
  const cands = new Map<string, { e: EntryRow; exact: boolean }[]>();
  const exactFor = new Map<string, string[]>();
  for (const b of bank) {
    const list: { e: EntryRow; exact: boolean }[] = [];
    for (const e of entries) {
      if (!entryCandidate(e, b) || notSame(b.key, e.key)) continue;
      const exact = entryEvidence(e, b);
      list.push({ e, exact });
      if (exact) exactFor.set(e.key, [...(exactFor.get(e.key) ?? []), b.key]);
    }
    if (list.length) cands.set(b.key, list);
  }
  const out: EntryPairDecision[] = [];
  for (const b of bank) {
    const list = cands.get(b.key);
    if (!list) continue;
    const exact = list.filter((c) => c.exact);
    const one = exact.length === 1 ? exact[0]!.e : null;
    if (one && exactFor.get(one.key)?.length === 1) {
      out.push({ kind: 'pair', bankKey: b.key, entryKey: one.key });
      continue;
    }
    const gap = (e: EntryRow) =>
      Math.abs(Math.abs(e.amount) - Math.abs(b.amount)) * 100 + Math.abs(daysBetween(e.date, b.date));
    out.push({
      kind: 'ask',
      bankKey: b.key,
      candidates: [...list]
        .sort(
          (x, y) =>
            Number(y.exact) - Number(x.exact) || gap(x.e) - gap(y.e) || x.e.key.localeCompare(y.e.key),
        )
        .map((c) => c.e.key),
    });
  }
  return out;
}

/** A `not_same` row's two keys in their stored order (a_key < b_key). */
export function notSameKeys(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}
