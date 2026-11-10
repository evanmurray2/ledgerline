import { describe, expect, it } from 'vitest';
import { matchPayees } from '../src/components/PayeeField';

describe('matchPayees', () => {
  const names = ['Amazon', 'Blue Bottle Coffee', 'Trader Joe’s', 'amazon', 'Bottle Shop', 'Blue Apron'];
  it('lists names that start with what is typed first, then names with a word that does', () => {
    expect(matchPayees(names, 'bl')).toEqual(['Blue Bottle Coffee', 'Blue Apron']);
    expect(matchPayees(names, 'bot')).toEqual(['Bottle Shop', 'Blue Bottle Coffee']);
  });
  it('ignores case, outer spaces and the kind of apostrophe', () => {
    expect(matchPayees(names, "  trader joe'")).toEqual(['Trader Joe’s']);
  });
  it('lists a name once, and nothing for an empty box or a name typed in full', () => {
    expect(matchPayees(names, 'ama')).toEqual(['Amazon']);
    expect(matchPayees(names, '')).toEqual([]);
    expect(matchPayees(names, 'Amazon')).toEqual([]);
  });
  it('lists at most 5', () => {
    expect(matchPayees(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], 'a')).toHaveLength(5);
  });
});
