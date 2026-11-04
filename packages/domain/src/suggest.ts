// Suggested categories (docs/payees.md section 2.1): the category you've used most for a payee, in the same
// direction. A suggestion is only shown; nothing is categorized until you tap OK.

/** How often you put one payee's transactions in one place, in one direction (money out or money in). */
export interface PastUse {
  /** The category, or null for Ready to Assign (then `toRta` is true). */
  categoryId: string | null;
  toRta: boolean;
  /** How many of the payee's transactions you put there. */
  n: number;
  /** When you last did (ms), to break a tie. */
  last: number;
}

export interface Suggestion {
  categoryId: string | null;
  toRta: boolean;
  /** Used at least twice and for more than half of the payee's transactions in this direction: OK all takes it. */
  strong: boolean;
}

/**
 * The past uses that can be offered, most used first (ties: most recent first). Ready to Assign only for money in;
 * categories only when `usable` says so (not archived, not a card payment category).
 */
export function rankPastUses(
  uses: readonly PastUse[],
  moneyIn: boolean,
  usable: (categoryId: string) => boolean,
): PastUse[] {
  return uses
    .filter((u) => (u.toRta ? moneyIn : u.categoryId !== null && usable(u.categoryId)))
    .slice()
    .sort((a, b) => b.n - a.n || b.last - a.last);
}

/** The suggestion for a payee's next transaction in this direction, or null when you've never categorized one. */
export function suggestCategory(
  uses: readonly PastUse[],
  moneyIn: boolean,
  usable: (categoryId: string) => boolean,
): Suggestion | null {
  const top = rankPastUses(uses, moneyIn, usable)[0];
  if (!top) return null;
  const total = uses.reduce((a, u) => a + u.n, 0);
  return {
    categoryId: top.toRta ? null : top.categoryId,
    toRta: top.toRta,
    strong: top.n >= 2 && top.n * 2 > total,
  };
}
