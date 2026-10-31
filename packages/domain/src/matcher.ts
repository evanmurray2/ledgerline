// Pending matcher and re-issue matcher (design: Pending transactions; Sync spec: Matching mechanics). Pure: the
// caller passes candidate rows and applies the decisions in one batch behind the watermark fence.
import { type Cents } from './money.js';
import { type IsoDate, daysBetween } from './month.js';
import { similarity } from './payee.js';

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
