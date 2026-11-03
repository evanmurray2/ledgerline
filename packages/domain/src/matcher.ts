// Pending matcher and re-issue matcher (design: Pending transactions; Sync spec: Matching mechanics). Pure: the
// caller passes candidate rows and applies the decisions in one batch behind the watermark fence.
import { type Cents } from './money.js';
import { type IsoDate, daysBetween } from './month.js';
import { cleanDescription, jaccard, similarity, trigrams } from './payee.js';

export interface MatchRow {
  key: string;
  accountId: string;
  amount: Cents;
  date: IsoDate;
  payee: string;
  /** 'card' purchases get a tip/fuel tolerance; 'ach' and 'check' match exactly. */
  channel: 'card' | 'ach' | 'check' | 'other';
}

export interface PostedRow extends MatchRow {
  providerTxnId: string;
  pendingProviderTxnId: string | null;
}

export type MatchDecision =
  | { kind: 'inherit'; postedKey: string; fromKey: string; by: 'provider' | 'auto' }
  | { kind: 'ambiguous'; postedKey: string; candidates: string[] }
  | { kind: 'likely'; postedKey: string; pendingKey: string }
  | { kind: 'none'; postedKey: string };

/** Tolerance: max($5, 25%) for card purchases (tips, fuel holds); exact for ACH and checks. */
export function withinTolerance(expected: Cents, actual: Cents, channel: MatchRow['channel']): boolean {
  if (Math.sign(expected) !== Math.sign(actual) && expected !== 0) return false;
  const diff = Math.abs(Math.abs(actual) - Math.abs(expected));
  if (channel === 'ach' || channel === 'check') return diff === 0;
  return diff <= Math.max(500, Math.floor(Math.abs(expected) / 4));
}

/** Higher is better: amount closeness, date gap and payee similarity. */
export function score(pending: MatchRow, posted: MatchRow): number {
  const amt =
    1 -
    Math.min(
      1,
      Math.abs(Math.abs(posted.amount) - Math.abs(pending.amount)) / Math.max(1, Math.abs(pending.amount)),
    );
  const gap = 1 - Math.min(1, Math.max(0, daysBetween(pending.date, posted.date)) / 14);
  const name = similarity(pending.payee, posted.payee);
  return Math.round((amt * 0.5 + gap * 0.2 + name * 0.3) * 1000);
}

const CLOSE = 25; // scores within this of the best count as "equally good"

/**
 * Matches posted rows to pending rows (bank pending or your manual ones). Order of authority: the provider's link,
 * then a unique best candidate on both sides (same account, unmatched, dated 0–14 days before, within tolerance),
 * else ambiguous (you pick).
 */
export function matchPosted(
  posted: readonly PostedRow[],
  manualPending: readonly MatchRow[],
  bankPendingByProviderId: ReadonlyMap<string, string>,
): MatchDecision[] {
  const out: MatchDecision[] = [];
  const unlinked: PostedRow[] = [];
  for (const p of posted) {
    const k = p.pendingProviderTxnId ? bankPendingByProviderId.get(p.pendingProviderTxnId) : undefined;
    if (k) out.push({ kind: 'inherit', postedKey: p.key, fromKey: k, by: 'provider' });
    else unlinked.push(p);
  }
  const eligible = (m: MatchRow, p: MatchRow) => {
    if (m.accountId !== p.accountId) return false;
    const gap = daysBetween(m.date, p.date);
    return (
      gap >= 0 &&
      gap <= 14 &&
      withinTolerance(m.amount, p.amount, p.channel === 'other' ? m.channel : p.channel)
    );
  };
  // Best candidate per posted row, and per pending row; auto-match only when each is the other's unique best.
  const bestFor = new Map<string, { key: string; s: number; tie: boolean; all: string[] }>();
  for (const p of unlinked) {
    const cands = manualPending.filter((m) => eligible(m, p)).map((m) => ({ key: m.key, s: score(m, p) }));
    if (cands.length === 0) continue;
    cands.sort((a, b) => b.s - a.s);
    const top = cands[0]!;
    const tie = cands.length > 1 && top.s - cands[1]!.s < CLOSE;
    bestFor.set(p.key, {
      key: top.key,
      s: top.s,
      tie,
      all: cands.filter((c) => top.s - c.s < CLOSE).map((c) => c.key),
    });
  }
  const claims = new Map<string, string[]>();
  for (const [pk, b] of bestFor) claims.set(b.key, [...(claims.get(b.key) ?? []), pk]);
  for (const p of unlinked) {
    const b = bestFor.get(p.key);
    if (!b) {
      out.push({ kind: 'none', postedKey: p.key });
      continue;
    }
    const rivals = claims.get(b.key) ?? [];
    if (!b.tie && rivals.length === 1)
      out.push({ kind: 'inherit', postedKey: p.key, fromKey: b.key, by: 'auto' });
    else out.push({ kind: 'ambiguous', postedKey: p.key, candidates: b.all });
  }
  return out;
}

/** Orphan recovery: a bank pending row removed with no provider link, matched against unmatched posted rows. */
export function matchOrphan(
  removedPending: MatchRow,
  unmatchedPosted: readonly MatchRow[],
): string | 'ambiguous' | null {
  const c = unmatchedPosted.filter((p) => {
    if (p.accountId !== removedPending.accountId) return false;
    const gap = daysBetween(removedPending.date, p.date);
    return gap >= 0 && gap <= 14 && withinTolerance(removedPending.amount, p.amount, removedPending.channel);
  });
  if (c.length === 0) return null;
  if (c.length === 1) return c[0]!.key;
  const scored = c.map((p) => ({ k: p.key, s: score(removedPending, p) })).sort((a, b) => b.s - a.s);
  return scored[0]!.s - scored[1]!.s >= CLOSE ? scored[0]!.k : 'ambiguous';
}

/** A bank pending row that a posted row could claim. */
export interface BankPendingRow extends MatchRow {
  /** The pending row's own authorization date (falls back to its date). */
  authorizedDate: IsoDate | null;
  /**
   * What claiming it carries over that you set (category you chose, memo, estimate, splits...): '' when nothing. Two
   * pending rows with the same signature are interchangeable, so which one a posted row claims changes nothing.
   */
  edits: string;
}

/** A posted row without the provider's link to its pending row. */
export interface UnlinkedPostedRow extends MatchRow {
  authorizedDate: IsoDate | null;
}

export type BankPendingDecision =
  | { kind: 'claim'; postedKey: string; pendingKey: string }
  | { kind: 'ambiguous'; postedKey: string; candidates: string[] };

/** A description's cleaned trigrams and its store numbers, worked out once per row (one row is compared with many). */
interface Prepared {
  grams: Set<string>;
  nums: Set<string>;
}

/**
 * The numbers in a description that can name a store or branch ("STARBUCKS 12345", "CAJUN SEAFOOD #3"): a number on
 * its own, not a date, a phone number, a card's last four digits or part of a reference code ("MKTPL*ZX12A"), which
 * change between a pending row and its posted row or are added to only one of them.
 */
export function storeNumbers(raw: string): Set<string> {
  const s = raw
    .toUpperCase()
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // dates
    .replace(/\(?\b\d{3}\)?[-. ]?\d{3}[-. ]\d{4}\b/g, ' ') // phone numbers
    .replace(/(X+|\*+)\d{4}\b/g, ' ') // card last-4
    .replace(/\b\d+-[A-Z]+/g, ' ') // part of the name ("7-ELEVEN"), shared by every branch
    .replace(/[A-Z0-9]*(?:[A-Z]\d|\d[A-Z])[A-Z0-9]*/g, ' '); // reference codes mixing letters and digits
  return new Set((s.match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, '')));
}
type Cache = Map<string, Prepared>;
function prep(c: Cache, s: string): Prepared {
  let v = c.get(s);
  if (!v) {
    v = { grams: trigrams(cleanDescription(s) || s), nums: storeNumbers(s) };
    c.set(s, v);
  }
  return v;
}

/** Name similarity when the pair could be the same purchase, else null. */
function eligible(p: BankPendingRow, q: UnlinkedPostedRow, c: Cache): number | null {
  if (p.accountId !== q.accountId || Math.sign(p.amount) !== Math.sign(q.amount)) return null;
  if (!withinTolerance(p.amount, q.amount, q.channel === 'other' ? 'card' : q.channel)) return null;
  const pAuth = p.authorizedDate ?? p.date;
  if (q.authorizedDate) {
    // The bank says when the posted charge was authorized: the pending one was authorized that day or the day before
    // (never after, which rules out yesterday's posted coffee claiming today's pending one).
    const gap = daysBetween(pAuth, q.authorizedDate);
    if (gap < 0 || gap > 1) return null;
  } else {
    const gap = daysBetween(p.date, q.date);
    if (gap < 0 || gap > 14) return null;
  }
  const a = prep(c, p.payee);
  const b = prep(c, q.payee);
  // When both descriptions name a store number, they must share one: cleaning drops numbers, so two branches of one
  // chain would otherwise look alike. A number on only one side (the bank added or dropped it on posting) proves nothing.
  if (a.nums.size && b.nums.size && ![...b.nums].some((n) => a.nums.has(n))) return null;
  // The same bank describes both: the names must look alike, unless the amount and the day agree exactly.
  const sim = jaccard(a.grams, b.grams);
  return sim >= 0.4 || (p.amount === q.amount && (q.authorizedDate ?? q.date) === pAuth) ? sim : null;
}

/** A pending row and a posted row could be the same purchase. */
export function bankPendingEligible(p: BankPendingRow, q: UnlinkedPostedRow): boolean {
  return eligible(p, q, new Map()) !== null;
}

function bankScore(p: BankPendingRow, q: UnlinkedPostedRow, sim: number): number {
  const amt =
    1 - Math.min(1, Math.abs(Math.abs(q.amount) - Math.abs(p.amount)) / Math.max(1, Math.abs(p.amount)));
  const days = Math.abs(daysBetween(p.authorizedDate ?? p.date, q.authorizedDate ?? q.date));
  const gap = 1 - Math.min(1, days / 14);
  return Math.round((amt * 0.5 + gap * 0.2 + sim * 0.3) * 1000);
}

/**
 * Pairs posted rows that came without the provider's link with bank pending rows (still listed or already removed),
 * best scores first, each row at most once. A pairing is left for you only when a close alternative would change the
 * result: another pending row carrying different edits, or another posted row that could take edits you made.
 * Interchangeable twins (two tabs at the same bar, nothing set on either) are paired without asking.
 */
export function pairBankPending(
  posted: readonly UnlinkedPostedRow[],
  pending: readonly BankPendingRow[],
): BankPendingDecision[] {
  type Pair = { p: BankPendingRow; q: UnlinkedPostedRow; s: number };
  const pairs: Pair[] = [];
  const cache: Cache = new Map();
  for (const q of posted)
    for (const p of pending) {
      const sim = eligible(p, q, cache);
      if (sim !== null) pairs.push({ p, q, s: bankScore(p, q, sim) });
    }
  pairs.sort((a, b) => b.s - a.s || a.q.key.localeCompare(b.q.key) || a.p.key.localeCompare(b.p.key));
  const takenP = new Map<string, Pair>();
  const takenQ = new Map<string, Pair>();
  for (const x of pairs)
    if (!takenP.has(x.p.key) && !takenQ.has(x.q.key)) {
      takenP.set(x.p.key, x);
      takenQ.set(x.q.key, x);
    }
  const out: BankPendingDecision[] = [];
  const ambiguous = new Set<string>();
  for (const x of takenQ.values()) {
    for (const y of pairs) {
      if (y === x || y.s < x.s - CLOSE) continue;
      if (y.q.key === x.q.key && y.p.key !== x.p.key) {
        // Another pending row fits this posted row about as well: it matters only if they carry different edits,
        // and when that row is itself taken, only if swapping the two pairs is about as good.
        if (y.p.edits === x.p.edits) continue;
        const other = takenP.get(y.p.key);
        if (other) {
          const swap = pairs.find((z) => z.p.key === x.p.key && z.q.key === other.q.key);
          if (!swap || swap.s + y.s < x.s + other.s - CLOSE) continue;
          ambiguous.add(other.q.key);
        }
        ambiguous.add(x.q.key);
      } else if (y.p.key === x.p.key && y.q.key !== x.q.key && x.p.edits !== '') {
        // Another posted row fits this pending row about as well, and the pending row carries your edits: unless that
        // posted row is taking a pending row with the same edits, which one gets them matters.
        if (takenQ.get(y.q.key)?.p.edits === x.p.edits) continue;
        ambiguous.add(x.q.key);
      }
    }
  }
  for (const x of takenQ.values()) {
    if (ambiguous.has(x.q.key))
      out.push({
        kind: 'ambiguous',
        postedKey: x.q.key,
        candidates: pairs.filter((y) => y.q.key === x.q.key).map((y) => y.p.key),
      });
    else out.push({ kind: 'claim', postedKey: x.q.key, pendingKey: x.p.key });
  }
  return out;
}

export type ReissueDecision =
  | { kind: 'inherit'; removedKey: string; addedKey: string }
  | { kind: 'possible'; removedKey: string; addedKeys: string[] };

/**
 * Re-issued posted rows: same account, same amount, dates within 3 days, and exactly one candidate on each side →
 * the replacement inherits; otherwise queue "Possible re-issue".
 */
export function matchReissues(removed: readonly MatchRow[], added: readonly MatchRow[]): ReissueDecision[] {
  const near = (a: MatchRow, b: MatchRow) =>
    a.accountId === b.accountId && Math.abs(daysBetween(a.date, b.date)) <= 3;
  const out: ReissueDecision[] = [];
  for (const r of removed) {
    const exact = added.filter((a) => near(r, a) && a.amount === r.amount);
    const back =
      exact.length === 1 ? removed.filter((x) => near(x, exact[0]!) && x.amount === exact[0]!.amount) : [];
    if (exact.length === 1 && back.length === 1)
      out.push({ kind: 'inherit', removedKey: r.key, addedKey: exact[0]!.key });
    else {
      const loose = added.filter(
        (a) => a.accountId === r.accountId && Math.abs(daysBetween(a.date, r.date)) <= 14,
      );
      if (loose.length) out.push({ kind: 'possible', removedKey: r.key, addedKeys: loose.map((a) => a.key) });
    }
  }
  return out;
}

/** When both rows carry your edits, the most recent edit wins per field; the conflict is flagged. */
export function mergeEdits<T extends Record<string, unknown>>(
  a: { values: T; editedAt: Partial<Record<keyof T, number>> },
  b: { values: T; editedAt: Partial<Record<keyof T, number>> },
): { values: Partial<T>; conflict: boolean } {
  const values: Partial<T> = {};
  let conflict = false;
  const keys = new Set<keyof T>([
    ...(Object.keys(a.editedAt) as (keyof T)[]),
    ...(Object.keys(b.editedAt) as (keyof T)[]),
  ]);
  for (const k of keys) {
    const ta = a.editedAt[k];
    const tb = b.editedAt[k];
    if (ta !== undefined && tb !== undefined) {
      if (a.values[k] !== b.values[k]) conflict = true;
      values[k] = ta >= tb ? a.values[k] : b.values[k];
    } else values[k] = ta !== undefined ? a.values[k] : b.values[k];
  }
  return { values, conflict };
}

export type { Cents };
