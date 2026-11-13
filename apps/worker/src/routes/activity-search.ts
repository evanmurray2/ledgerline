// Activity's search: what a search looks for, and how posted rows and one category's rows are picked in SQL.
//
// A search compares text without case or accents (`foldSearch`, packages/domain/src/search.ts): "cafe" finds
// "CAFÉ". SQLite's lower() folds only A–Z, and a Durable Object's SQLite refuses an expression deep enough to fold
// every accented letter, so SQL folds only text of plain ASCII, where lower() is the same fold. The payee names with
// other characters, and the categories, are folded and matched here, and SQL is given the matches (`SearchFound`).
import { foldSearch } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { paybacksIn, paybacksWhere } from '../views/owed-rows.js';

/** What a search matched outside SQL: payee names that aren't plain ASCII, and categories by name (ids). */
export interface SearchFound {
  names: string[];
  cats: string[];
}

export const NOTHING_FOUND: SearchFound = { names: [], cats: [] };

/** Text with a character outside printable ASCII: SQL's lower() doesn't fold it as a search does. */
const NOT_ASCII = (col: string) => `${col} GLOB '*[^ -~]*'`;

/**
 * Every name a row's payee can be (a payee's name, or the bank's merchant name or text) that isn't plain ASCII,
 * kept when it matches the search `q` (already folded). Few names have such characters, so the list stays short.
 */
export async function foldedNames(s: Scoped, q: string): Promise<string[]> {
  if (!q) return [];
  const rows = await s.all<{ n: string }>(
    `SELECT name AS n FROM payee WHERE budget_id = ?1 AND ${NOT_ASCII('name')}
     UNION SELECT merchant_name FROM bank_txn WHERE budget_id = ?1 AND ${NOT_ASCII('merchant_name')}
     UNION SELECT raw_name FROM bank_txn WHERE budget_id = ?1 AND ${NOT_ASCII('raw_name')}`,
  );
  return rows.map((r) => r.n).filter((n) => foldSearch(n).includes(q));
}

/** `col` is one of the values in the JSON array parameter `p`. */
const inList = (col: string, p: string) => `${col} IN (SELECT value FROM json_each(${p}))`;

/**
 * One category's rows (Reports and the category sheet open Activity on a category, by id): the row's own category,
 * a split line in it, or money in that paid back one of its owed purchases. `p` is the parameter holding the id.
 */
export const inCategory = (p: string) =>
  `AND (category_id = ${p} OR key IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1 AND category_id = ${p})
    OR key IN (${paybacksIn(p)}))`;

/**
 * A search's posted-row filter. ?3 is the text as a LIKE pattern (its % and _ are letters, not wildcards), matched
 * against a payee of plain ASCII; `names` the parameter holding the other matching payee names (JSON), `cats` the
 * matching categories' ids (JSON): a row's category, a split line's, or that of an owed purchase it paid back.
 * `amt` holds the amount pattern, NULL when the search isn't an amount.
 */
export const searchMatch = (amt: string, names: string, cats: string) =>
  `AND ((NOT ${NOT_ASCII('payee')} AND lower(payee) LIKE ?3 ESCAPE '\\') OR ${inList('payee', names)}
    OR (${amt} IS NOT NULL AND printf('%.2f', abs(amount) / 100.0) LIKE ${amt})
    OR ${inList('category_id', cats)}
    OR key IN (SELECT sp.txn_key FROM txn_split sp WHERE sp.budget_id = ?1 AND ${inList('sp.category_id', cats)})
    OR key IN (${paybacksWhere(inList('e.category_id', cats))}))`;

/** The search as a LIKE pattern for the text: % and _ match only themselves. */
export function textPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The search as a plain amount ("$1,018" → "1018", "−38.10" → "38.10"), or null when it isn't one. */
export function searchAmount(q: string): string | null {
  const a = q.replace(/[\s$,−-]/g, '');
  return /\d/.test(a) && /^\d*\.?\d*$/.test(a) ? a : null;
}

/** An amount as the search compares it: 101800 → "1018.00", sign dropped. */
export function plainAmount(c: number): string {
  const a = Math.abs(c);
  return `${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * What a search looks for, folded (`foldSearch`): at most 48 bytes, since a Durable Object's SQLite refuses a LIKE
 * pattern over 50 bytes (the search goes between two `%`). A longer search looks for its start.
 */
export function searchText(raw: string): string {
  // A double space is one space.
  const chars = [...foldSearch(raw).replace(/\s+/g, ' ').trim()];
  const enc = new TextEncoder();
  while (enc.encode(chars.join('')).length > 48) chars.pop();
  return chars.join('').trim();
}
