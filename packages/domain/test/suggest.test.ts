import { describe, expect, it } from 'vitest';
import { rankPastUses, suggestCategory, type PastUse } from '../src/suggest.js';

const use = (categoryId: string | null, n: number, last = 0): PastUse => ({
  categoryId,
  toRta: categoryId === null,
  n,
  last,
});
const all = () => true;

describe('suggested category', () => {
  it('suggests the most used category', () => {
    expect(suggestCategory([use('coffee', 14), use('dining', 2)], false, all)).toEqual({
      categoryId: 'coffee',
      toRta: false,
      strong: true,
    });
  });

  it('breaks a tie by the most recent', () => {
    expect(suggestCategory([use('a', 2, 10), use('b', 2, 20)], false, all)?.categoryId).toBe('b');
  });

  it('has no suggestion for a payee never categorized', () => {
    expect(suggestCategory([], false, all)).toBeNull();
  });

  it('offers Ready to Assign only for money in', () => {
    expect(suggestCategory([use(null, 5)], true, all)).toEqual({
      categoryId: null,
      toRta: true,
      strong: true,
    });
    expect(suggestCategory([use(null, 5)], false, all)).toBeNull();
  });

  it('skips categories that cannot be used and falls back to the next', () => {
    const usable = (id: string) => id !== 'archived';
    expect(suggestCategory([use('archived', 9), use('household', 3)], false, usable)?.categoryId).toBe(
      'household',
    );
  });

  it('is strong only when used at least twice and for most of the payee', () => {
    expect(suggestCategory([use('a', 1)], false, all)?.strong).toBe(false);
    expect(suggestCategory([use('a', 2), use('b', 2)], false, all)?.strong).toBe(false);
    expect(suggestCategory([use('a', 3), use('b', 2)], false, all)?.strong).toBe(true);
  });

  it('ranks past uses most used first', () => {
    expect(
      rankPastUses([use('a', 1), use('b', 4), use('c', 2)], false, all).map((u) => u.categoryId),
    ).toEqual(['b', 'c', 'a']);
  });
});
