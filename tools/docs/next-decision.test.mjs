import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decisionNumbers, duplicates, nextNumber } from './next-decision.mjs';

describe('next-decision', () => {
  const table = '| D-1 | First |\n| D-2 | Second |\nNot a row D-9\n';

  it('gives the number after the highest one, from the table and the files', () => {
    const n = decisionNumbers(table, ['D-51-a.md', 'D-60-b.md', 'README.txt', '']);
    assert.equal(nextNumber(n), 61);
    assert.deepEqual(duplicates(n), []);
    assert.equal(nextNumber(decisionNumbers('', [])), 1);
  });

  it('finds a number used twice, in files or in the table and a file', () => {
    const n = decisionNumbers(table, ['D-85-a.md', 'D-85-b.md', 'D-2-again.md']);
    assert.deepEqual(duplicates(n), [
      [2, ['docs/decisions.md row D-2', 'docs/decisions/D-2-again.md']],
      [85, ['docs/decisions/D-85-a.md', 'docs/decisions/D-85-b.md']],
    ]);
  });
});
