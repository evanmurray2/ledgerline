// Activity's search: what a search looks for, and how posted rows and one category's rows are picked in SQL.
import { paybacksIn, paybacksWhere } from '../views/owed-rows.js';

/**
 * A search matches a row's category name too: split lines included, and money in that paid back an owed purchase
 * in a category with that name.
 */
/** A name as a search compares it: lower case, curly apostrophes as straight ones (`searchText` folds the search). */
const fold = (col: string) => `replace(replace(lower(${col}), '’', ''''), '‘', '''')`;

const CATEGORY_MATCH = `category_id IN (SELECT id FROM category WHERE budget_id = ?1 AND ${fold('name')} LIKE ?3 ESCAPE '\\')
         OR key IN (SELECT sp.txn_key FROM txn_split sp JOIN category c ON c.id = sp.category_id
                    WHERE sp.budget_id = ?1 AND ${fold('c.name')} LIKE ?3 ESCAPE '\\')
         OR key IN (${paybacksWhere(`e.category_id IN (SELECT id FROM category WHERE budget_id = ?1 AND ${fold('name')} LIKE ?3 ESCAPE '\\')`)})`;

/**
 * One category's rows (Reports and the category sheet open Activity on a category, by id): the row's own category,
 * a split line in it, or money in that paid back one of its owed purchases. `p` is the parameter holding the id.
 */
export const inCategory = (p: string) =>
  `AND (category_id = ${p} OR key IN (SELECT txn_key FROM txn_split WHERE budget_id = ?1 AND category_id = ${p})
    OR key IN (${paybacksIn(p)}))`;

/**
 * A search's posted-row filter: ?3 is the text as a LIKE pattern (its % and _ are letters, not wildcards), `amt`
 * the parameter holding the amount pattern (`amountPattern`), NULL when the search isn't an amount.
 */
export const searchMatch = (amt: string) =>
  `AND (${fold('payee')} LIKE ?3 ESCAPE '\\' OR (${amt} IS NOT NULL AND printf('%.2f', abs(amount) / 100.0) LIKE ${amt}) OR ${CATEGORY_MATCH})`;

/** Text as a search compares it, as `fold` does in SQL. */
export function foldText(t: string): string {
  return t.toLowerCase().replace(/[’‘]/g, "'");
}

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
 * What a search looks for: at most 48 bytes, since a Durable Object's SQLite refuses a LIKE pattern over 50 bytes
 * (the search goes between two `%`). A longer search looks for its start.
 */
export function searchText(raw: string): string {
  // Curly and straight apostrophes match each other, and a double space is one space.
  const chars = [...foldText(raw).replace(/\s+/g, ' ').trim()];
  const enc = new TextEncoder();
  while (enc.encode(chars.join('')).length > 48) chars.pop();
  return chars.join('').trim();
}
