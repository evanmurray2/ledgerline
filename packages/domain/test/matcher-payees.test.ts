import { describe, expect, it } from 'vitest';
import { parseCents as $, cents } from '../src/money.js';
import { matchOrphan, matchReissues, mergeEdits, withinTolerance, type MatchRow } from '../src/matcher.js';
import { detectTransfers } from '../src/transfers.js';

const row = (o: Partial<MatchRow>): MatchRow => ({
  key: 'k',
  accountId: 'chk',
  amount: $('-50'),
  date: '2026-11-10',
  merchantEntityId: null,
  merchantName: null,
  plaidName: 'RESTAURANT',
  channel: 'card',
  ...o,
});

describe('pending matcher', () => {
  it('tolerance: max($5, 25%) for card purchases, exact for checks and ACH', () => {
    expect(withinTolerance($('-50'), $('-61'), 'card')).toBe(true); // $50 pre-auth, $61 with tip
    expect(withinTolerance($('-50'), $('-63'), 'card')).toBe(false);
    expect(withinTolerance($('-120'), $('-120.01'), 'check')).toBe(false);
  });
  it('orphan recovery and re-issues', () => {
    expect(matchOrphan(row({ key: 'R' }), [row({ key: 'X', date: '2026-11-12' })])).toBe('X');
    // Two candidates: the same merchant decides (no text likeness); two others alike are ambiguous.
    const two = [
      row({ key: 'X', plaidName: 'SOMEWHERE ELSE' }),
      row({ key: 'Y', plaidName: null, merchantName: 'Restaurant' }),
    ];
    expect(matchOrphan(row({ key: 'R' }), two)).toBe('Y');
    expect(matchOrphan(row({ key: 'R', plaidName: 'NEW PLACE' }), two)).toBe('ambiguous');
    expect(
      matchReissues([row({ key: 'old', channel: 'ach' })], [row({ key: 'new', date: '2026-11-12' })]),
    ).toEqual([{ kind: 'inherit', removedKey: 'old', addedKey: 'new' }]);
    expect(
      matchReissues([row({ key: 'old' })], [row({ key: 'new', amount: $('-55'), date: '2026-11-12' })]),
    ).toEqual([{ kind: 'possible', removedKey: 'old', addedKeys: ['new'] }]);
  });
  it('both rows carry edits: most recent edit wins per field, conflict flagged', () => {
    const m = mergeEdits(
      { values: { categoryId: 'a', memo: 'x' }, editedAt: { categoryId: 10, memo: 30 } },
      { values: { categoryId: 'b', memo: 'y' }, editedAt: { categoryId: 20 } },
    );
    expect(m).toEqual({ values: { categoryId: 'b', memo: 'x' }, conflict: true });
  });
});

describe('payees and transfers', () => {
  it('transfers: one matching inflow pairs; two make it unclear', () => {
    const t = (
      key: string,
      accountId: string,
      amount: string,
      date: string,
      description = 'ONLINE TRANSFER',
    ) => ({ key, accountId, amount: $(amount), date, description, providerCategory: null });
    expect(
      detectTransfers([
        t('o', 'chk', '-500', '2026-11-12'),
        t('i', 'marcus', '500', '2026-11-12', 'DEPOSIT'),
      ]),
    ).toEqual([{ kind: 'paired', outKey: 'o', inKey: 'i' }]);
    expect(
      detectTransfers([
        t('o', 'chk', '-200', '2026-11-10'),
        t('m', 'marcus', '200', '2026-11-11'),
        t('a', 'ally', '200', '2026-11-12'),
      ]),
    ).toEqual([{ kind: 'unclear', outKey: 'o', candidates: ['m', 'a'] }]);
    expect(detectTransfers([t('x', 'chk', '-20', '2026-11-10', 'SAFEWAY')])).toEqual([]);
    // Two equal outflows and one inflow: either could be its other side, so both are asked about, in any order.
    const two = [
      t('o1', 'chk', '-300', '2026-11-10'),
      t('o2', 'savings', '-300', '2026-11-11'),
      t('in', 'marcus', '300', '2026-11-12', 'DEPOSIT'),
    ];
    const asked = [
      { kind: 'unclear', outKey: 'o1', candidates: ['in'] },
      { kind: 'unclear', outKey: 'o2', candidates: ['in'] },
    ];
    expect(detectTransfers(two)).toEqual(asked);
    expect(detectTransfers([...two].reverse())).toEqual([...asked].reverse());
    expect(cents(0)).toBe(0);
  });
});
