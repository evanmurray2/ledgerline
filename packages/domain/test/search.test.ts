// Activity search folds text the same way on both sides: no case, no accents on Latin letters, one apostrophe.
import { describe, expect, it } from 'vitest';
import { SEARCH_FOLDS, foldSearch, foldSql } from '../src/search.js';

describe('foldSearch', () => {
  it('folds case and accents', () => {
    expect(foldSearch('CAFÉ')).toBe('cafe');
    expect(foldSearch('café')).toBe('cafe');
    expect(foldSearch('Crème Brûlée')).toBe('creme brulee');
    expect(foldSearch('ŁÓDŹ')).toBe('lodz');
    expect(foldSearch('STRAßE')).toBe('strasse');
    expect(foldSearch('Trader Joe’s')).toBe("trader joe's");
  });

  it('drops a combining accent written after its letter', () => {
    expect(foldSearch('café')).toBe('cafe');
  });

  it('leaves other scripts as they are, as SQL does', () => {
    expect(foldSearch('Σ')).toBe('Σ');
  });

  it('folds to lower-case ASCII only, and the SQL lists every pair', () => {
    for (const [, to] of SEARCH_FOLDS) expect(to).toMatch(/^[a-z']*$/);
    const sql = foldSql('payee');
    expect(sql.match(/replace\(/g)).toHaveLength(SEARCH_FOLDS.length);
  });
});
