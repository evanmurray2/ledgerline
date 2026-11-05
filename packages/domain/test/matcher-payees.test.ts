import { describe, expect, it } from 'vitest';
import { parseCents as $, cents } from '../src/money.js';
import {
  matchOrphan,
  matchPosted,
  matchReissues,
  mergeEdits,
  withinTolerance,
  type MatchRow,
  type PostedRow,
} from '../src/matcher.js';
import { cleanDescription, similarity } from '../src/payee.js';
import { detectTransfers } from '../src/transfers.js';

const row = (o: Partial<MatchRow>): MatchRow => ({
  key: 'k',
  accountId: 'chk',
  amount: $('-50'),
  date: '2026-11-10',
  payee: 'Restaurant',
  channel: 'card',
  ...o,
});
const posted = (o: Partial<PostedRow>): PostedRow => ({
  ...row(o),
  providerTxnId: 'p',
  pendingProviderTxnId: null,
  ...o,
});

describe('pending matcher', () => {
  it('tolerance: max($5, 25%) for card purchases, exact for checks and ACH', () => {
    expect(withinTolerance($('-50'), $('-61'), 'card')).toBe(true); // $50 pre-auth, $61 with tip
    expect(withinTolerance($('-50'), $('-63'), 'card')).toBe(false);
    expect(withinTolerance($('-120'), $('-120.01'), 'check')).toBe(false);
  });
  it('provider link first; then a unique best candidate; else ambiguous', () => {
    const d = matchPosted(
      [
        posted({ key: 'P1', pendingProviderTxnId: 'bankpend' }),
        posted({ key: 'P2', amount: $('-120'), channel: 'check', payee: 'Check 1043' }),
      ],
      [row({ key: 'M1', amount: $('-120'), date: '2026-11-05', channel: 'check', payee: 'Check #1043' })],
      new Map([['bankpend', 'B1']]),
    );
    expect(d).toEqual([
      { kind: 'inherit', postedKey: 'P1', fromKey: 'B1', by: 'provider' },
      { kind: 'inherit', postedKey: 'P2', fromKey: 'M1', by: 'auto' },
    ]);
    const amb = matchPosted(
      [posted({ key: 'P', amount: $('-40') })],
      [row({ key: 'A', amount: $('-40') }), row({ key: 'B', amount: $('-40') })],
      new Map(),
    );
    expect(amb[0]).toEqual({ kind: 'ambiguous', postedKey: 'P', candidates: ['A', 'B'] });
  });
  it('candidates must be 0–14 days before the posted date', () => {
    expect(
      matchPosted(
        [posted({ key: 'P', date: '2026-11-30' })],
        [row({ key: 'M', date: '2026-11-10' })],
        new Map(),
      )[0]!.kind,
    ).toBe('none');
  });
  it('orphan recovery and re-issues', () => {
    expect(matchOrphan(row({ key: 'R' }), [row({ key: 'X', date: '2026-11-12' })])).toBe('X');
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
  // The pending matcher's text likeness (PR 4 of docs/payee-names.md 11 removes it).
  it('cleans the doc’s Blue Bottle examples to one name for the matcher', () => {
    expect(cleanDescription('SQ *BLUE BOTTLE 0123 OAKLAND CA')).toBe('BLUE BOTTLE');
    expect(cleanDescription('TST* BLUE BOTTLE')).toBe('BLUE BOTTLE');
    expect(similarity('BLUE BOTTLE', 'BLUEBOTTLE COFFEE')).toBeGreaterThan(0.3);
  });
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
