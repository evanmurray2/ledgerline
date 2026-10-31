import { describe, expect, it } from 'vitest';
import { parseCents as $, cents } from '../src/money.js';
import { applySplit, evaluateRules, shouldOfferAlways, type Rule, type RuleTxn } from '../src/rules.js';
import {
  matchOrphan,
  matchPosted,
  matchReissues,
  mergeEdits,
  withinTolerance,
  type MatchRow,
  type PostedRow,
} from '../src/matcher.js';
import { cleanDescription, clusterPayees, similarity } from '../src/payee.js';
import { detectTransfers } from '../src/transfers.js';

const rent: Rule = {
  id: 'r-rent',
  name: 'Rent',
  conditions: {
    all: [
      { field: 'payee', op: 'is', value: 'Rent' },
      { field: 'direction', op: 'is', value: 'out' },
    ],
  },
  actions: [
    { type: 'set_category', categoryId: 'rent' },
    { type: 'previous_month_if_within_days', days: 5 },
    { type: 'mark_owed', num: 2, den: 3, minAmount: $('2500'), expectByDay: 15 },
  ],
  applyToPending: true,
  stopAfter: true,
  enabled: true,
};
const tx = (o: Partial<RuleTxn>): RuleTxn => ({
  payeeId: null,
  payeeName: 'X',
  description: 'X',
  accountId: 'chk',
  amount: $('-10'),
  date: '2026-11-14',
  pending: false,
  providerCategory: null,
  ...o,
});

describe('rules engine', () => {
  it('the rent rule: category, counts in the previous month in the first 5 days, 2/3 owed, expected by the 15th', () => {
    const r = evaluateRules(tx({ payeeName: 'Rent', amount: $('-3000'), date: '2026-11-01' }), [rent], null);
    expect(r.categoryId).toBe('rent');
    expect(r.budgetMonth).toBe('2026-10');
    expect(r.owed).toEqual({ amount: $('2000'), num: 2, den: 3, expectBy: '2026-11-15' });
    expect(r.by).toEqual({ ruleId: 'r-rent' });
  });
  it('never marks more than the transaction, and not under the minimum', () => {
    expect(evaluateRules(tx({ payeeName: 'Rent', amount: $('-2000') }), [rent], null).owed).toBeUndefined();
  });
  it('first match wins; payee default only when no rule set a category', () => {
    const a: Rule = {
      ...rent,
      id: 'a',
      conditions: { all: [{ field: 'description', op: 'contains', value: 'vanguard' }] },
      actions: [{ type: 'set_category', categoryId: 'invest' }],
    };
    const b: Rule = { ...a, id: 'b', actions: [{ type: 'set_category', categoryId: 'other' }] };
    expect(evaluateRules(tx({ description: 'VANGUARD BUY' }), [a, b], null).categoryId).toBe('invest');
    expect(
      evaluateRules(tx({ description: 'TJ' }), [a, b], { categoryId: 'groceries', remember: true }),
    ).toEqual({ categoryId: 'groceries', by: 'payee' });
    expect(
      evaluateRules(tx({ description: 'TJ' }), [a, b], { categoryId: 'groceries', remember: false }),
    ).toEqual({});
  });
  it('rules can skip pending rows', () => {
    const r = { ...rent, applyToPending: false };
    expect(
      evaluateRules(tx({ payeeName: 'Rent', amount: $('-3000'), pending: true }), [r], null).categoryId,
    ).toBeUndefined();
  });
  it('splits: the remainder goes to the marked (or largest) line', () => {
    expect(
      applySplit($('-182.40'), [
        { categoryId: 'g', fixed: $('140') },
        { categoryId: 'h', fixed: $('40') },
      ]),
    ).toEqual([
      { categoryId: 'g', amount: $('-142.40'), absorbsRemainder: true },
      { categoryId: 'h', amount: $('-40'), absorbsRemainder: false },
    ]);
  });
  it('"Always" is offered only for payees categorized the same way at least twice and never differently', () => {
    expect(shouldOfferAlways(['dining', 'dining'])).toBe('dining');
    expect(shouldOfferAlways(['dining'])).toBeNull();
    expect(shouldOfferAlways(['shopping', 'household'])).toBeNull();
  });
});

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
  it('cleans the doc’s Blue Bottle examples to one name', () => {
    expect(cleanDescription('SQ *BLUE BOTTLE 0123 OAKLAND CA')).toBe('BLUE BOTTLE');
    expect(cleanDescription('TST* BLUE BOTTLE')).toBe('BLUE BOTTLE');
    expect(similarity('BLUE BOTTLE', 'BLUEBOTTLE COFFEE')).toBeGreaterThan(0.3);
    const c = clusterPayees([
      { raw: 'SQ *BLUE BOTTLE 0123 OAKLAND CA', merchantEntityId: null, merchantName: null, count: 10 },
      { raw: 'TST* BLUE BOTTLE', merchantEntityId: null, merchantName: null, count: 8 },
      { raw: 'SAFEWAY #1234', merchantEntityId: null, merchantName: null, count: 3 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.transactions).toBe(18);
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
    expect(cents(0)).toBe(0);
  });
});
