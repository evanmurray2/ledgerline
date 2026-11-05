// Pending matcher and re-issue matcher (design: Pending transactions; Sync spec: Matching mechanics;
// docs/payee-names.md 9.3). Pure: the caller passes candidate rows and applies the decisions in one batch behind the
// watermark fence. No text is compared: two rows are the same merchant only when Plaid says so (sameMerchant).
import { type Cents } from './money.js';
import { type IsoDate, daysBetween } from './month.js';
import { nameKey } from './payee.js';

/** What Plaid says about who was paid, as sent: its merchant id, `merchant_name` and `name`. */
export interface Merchant {
  merchantEntityId: string | null;
  merchantName: string | null;
  plaidName: string | null;
}

export interface MatchRow extends Merchant {
  key: string;
  accountId: string;
  amount: Cents;
  date: IsoDate;
  /** 'card' purchases get a tip/fuel tolerance; 'ach' and 'check' match exactly. */
  channel: 'card' | 'ach' | 'check' | 'other';
}

const present = (s: string | null): s is string => s !== null && s.trim() !== '';

/**
 * A row's merchant keys (docs/payee-names.md 4) without the bank-text fallback: `m:<merchant id>`, and `n:` of
 * `merchant_name` and of Plaid's `name`. Both names share one `n:` space, so a merchant name can equal a Plaid name.
 */
export function merchantKeys(r: Merchant): string[] {
  const keys: string[] = [];
  if (present(r.merchantEntityId)) keys.push(`m:${r.merchantEntityId}`);
  if (present(r.merchantName)) keys.push(nameKey(r.merchantName));
  if (present(r.plaidName)) keys.push(nameKey(r.plaidName));
  return keys;
}

/** Same merchant (9): the two rows share a merchant key: the merchant id, or a Plaid name equal to a Plaid name. */
export function sameMerchant(a: Merchant, b: Merchant): boolean {
  const k = merchantKeys(a);
  return k.length > 0 && merchantKeys(b).some((x) => k.includes(x));
}

/** Tolerance: max($5, 25%) for card purchases (tips, fuel holds); exact for ACH and checks. */
export function withinTolerance(expected: Cents, actual: Cents, channel: MatchRow['channel']): boolean {
  if (Math.sign(expected) !== Math.sign(actual) && expected !== 0) return false;
  const diff = Math.abs(Math.abs(actual) - Math.abs(expected));
  if (channel === 'ach' || channel === 'check') return diff === 0;
  return diff <= Math.max(500, Math.floor(Math.abs(expected) / 4));
}

/** Higher is better: amount closeness 50%, date gap 20%, same merchant 30% (1 or 0). */
export function score(pending: MatchRow, posted: MatchRow): number {
  const amt =
    1 -
    Math.min(
      1,
      Math.abs(Math.abs(posted.amount) - Math.abs(pending.amount)) / Math.max(1, Math.abs(pending.amount)),
    );
  const gap = 1 - Math.min(1, Math.max(0, daysBetween(pending.date, posted.date)) / 14);
  const name = sameMerchant(pending, posted) ? 1 : 0;
  return Math.round((amt * 0.5 + gap * 0.2 + name * 0.3) * 1000);
}

const CLOSE = 25; // scores within this of the best count as "equally good"

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
  /** Several candidates with exact evidence and different edits (the `ambiguous_match` alert). */
  | { kind: 'ambiguous'; postedKey: string; candidates: string[] }
  /** Candidates, none with exact evidence: "Same purchase?" (docs/payee-names.md 9.1), best first. */
  | { kind: 'ask'; postedKey: string; candidates: string[] };

/**
 * A candidate (docs/payee-names.md 9): same account and sign, amount within tolerance, and the pending row authorized
 * the same day as the posted row or the day before (else dated 0–14 days before).
 */
export function bankPendingEligible(p: BankPendingRow, q: UnlinkedPostedRow): boolean {
  if (p.accountId !== q.accountId || Math.sign(p.amount) !== Math.sign(q.amount)) return false;
  if (!withinTolerance(p.amount, q.amount, q.channel === 'other' ? 'card' : q.channel)) return false;
  if (q.authorizedDate) {
    // The bank says when the posted charge was authorized: the pending one was authorized that day or the day before
    // (never after, which rules out yesterday's posted coffee claiming today's pending one).
    const gap = daysBetween(p.authorizedDate ?? p.date, q.authorizedDate);
    return gap >= 0 && gap <= 1;
  }
  const gap = daysBetween(p.date, q.date);
  return gap >= 0 && gap <= 14;
}

/** Exact evidence (9): the same merchant, or the same amount on the same day (authorization day, else date). */
export function bankPendingEvidence(p: BankPendingRow, q: UnlinkedPostedRow): boolean {
  if (sameMerchant(p, q)) return true;
  return p.amount === q.amount && (p.authorizedDate ?? p.date) === (q.authorizedDate ?? q.date);
}

function bankScore(p: BankPendingRow, q: UnlinkedPostedRow): number {
  const amt =
    1 - Math.min(1, Math.abs(Math.abs(q.amount) - Math.abs(p.amount)) / Math.max(1, Math.abs(p.amount)));
  const days = Math.abs(daysBetween(p.authorizedDate ?? p.date, q.authorizedDate ?? q.date));
  const gap = 1 - Math.min(1, days / 14);
  return Math.round((amt * 0.5 + gap * 0.2 + (sameMerchant(p, q) ? 0.3 : 0)) * 1000);
}

/**
 * Pairs posted rows that came without the provider's link with bank pending rows (still listed or already removed).
 * A candidate pairs only on exact evidence (bankPendingEvidence); among those, best scores first, each row at most
 * once. A pairing is left for you only when a close alternative would change the result: another pending row carrying
 * different edits, or another posted row that could take edits you made. Interchangeable twins (two tabs at the same
 * bar, nothing set on either) are paired without asking. A posted row left with candidates but none with exact
 * evidence is asked about ("Same purchase?"). `notSame(postedKey, pendingKey)` is a pair you answered No to: never a
 * candidate.
 */
export function pairBankPending(
  posted: readonly UnlinkedPostedRow[],
  pending: readonly BankPendingRow[],
  notSame: (postedKey: string, pendingKey: string) => boolean = () => false,
): BankPendingDecision[] {
  type Pair = { p: BankPendingRow; q: UnlinkedPostedRow; s: number };
  const all: Pair[] = [];
  const pairs: Pair[] = [];
  for (const q of posted)
    for (const p of pending) {
      if (!bankPendingEligible(p, q) || notSame(q.key, p.key)) continue;
      const x = { p, q, s: bankScore(p, q) };
      all.push(x);
      if (bankPendingEvidence(p, q)) pairs.push(x);
    }
  const order = (a: Pair, b: Pair) =>
    b.s - a.s || a.q.key.localeCompare(b.q.key) || a.p.key.localeCompare(b.p.key);
  pairs.sort(order);
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
  // The rest: a posted row with candidates that no pairing above took, none with exact evidence for it.
  all.sort(order);
  for (const q of posted) {
    if (takenQ.has(q.key)) continue;
    const free = all.filter((y) => y.q.key === q.key && !takenP.has(y.p.key)).map((y) => y.p.key);
    if (free.length) out.push({ kind: 'ask', postedKey: q.key, candidates: free });
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
