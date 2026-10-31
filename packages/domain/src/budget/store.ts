// Compact storage form of a computed month (one month_snapshot row) and a cheap change hash, so a recompute reads
// only hashes of cached months and writes only the months whose content changed.
import { type Cents, cents } from '../money.js';
import type { Month } from '../month.js';
import type { CategoryCell, CardCell, MonthResult, MonthSnapshot } from './compute.js';

/** [id, assigned, activity, spent, available, cashOverspent, creditOverspent by card] */
type CellRow = [string, number, number, number, number, number, Record<string, number>?];
/** [card, assigned, activity, available] */
type CardRow = [string, number, number, number];

export interface StoredMonth {
  m: Month;
  c: CellRow[];
  k: CardRow[];
  i: number;
  o: number;
  u: number;
  s: MonthSnapshot;
}

export function encodeMonth(r: MonthResult): StoredMonth {
  const c: CellRow[] = [];
  for (const [id, x] of Object.entries(r.categories)) {
    const row: CellRow = [id, x.assigned, x.activity, x.spent, x.available, x.cashOverspent];
    if (Object.keys(x.creditOverspent).length) row.push(x.creditOverspent);
    c.push(row);
  }
  const k: CardRow[] = Object.entries(r.cards).map(([id, x]) => [id, x.assigned, x.activity, x.available]);
  return { m: r.month, c, k, i: r.inflows, o: r.owed, u: r.uncovered, s: r.snapshot };
}

export function decodeMonth(s: StoredMonth): MonthResult {
  const categories: Record<string, CategoryCell> = {};
  for (const [id, assigned, activity, spent, available, cashOverspent, credit] of s.c) {
    const co: Record<string, Cents> = {};
    for (const [card, v] of Object.entries(credit ?? {})) co[card] = cents(v);
    categories[id] = {
      assigned: cents(assigned),
      activity: cents(activity),
      spent: cents(spent),
      available: cents(available),
      cashOverspent: cents(cashOverspent),
      creditOverspent: co,
    };
  }
  const cards: Record<string, CardCell> = {};
  for (const [id, assigned, activity, available] of s.k) {
    cards[id] = { assigned: cents(assigned), activity: cents(activity), available: cents(available) };
  }
  return {
    month: s.m,
    categories,
    cards,
    inflows: cents(s.i),
    owed: cents(s.o),
    uncovered: cents(s.u),
    snapshot: s.s,
  };
}

/** FNV-1a, 32-bit, over UTF-16 code units, as 8 hex digits. Change detection only; not a security hash. */
export function changeHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
