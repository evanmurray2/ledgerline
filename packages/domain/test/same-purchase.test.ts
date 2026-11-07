// Your entry and a bank row (docs/payee-names.md 9): candidates, exact evidence, and pairing only on it.
import { describe, expect, it } from 'vitest';
import { parseCents as $ } from '../src/money.js';
import {
  entryCandidate,
  entryEvidence,
  notSameKeys,
  pairEntries,
  type BankSideRow,
  type EntryRow,
} from '../src/same-purchase.js';

const entry = (o: Partial<EntryRow> = {}): EntryRow => ({
  key: 'e1',
  accountId: 'card',
  amount: $('-40'),
  date: '2026-11-10',
  name: 'Junebug',
  channel: 'card',
  ...o,
});
const bank = (o: Partial<BankSideRow> = {}): BankSideRow => ({
  key: 'p:b1',
  accountId: 'card',
  amount: $('-40'),
  date: '2026-11-10',
  authorizedDate: null,
  names: ['TST*JUNEBUG'],
  channel: 'card',
  ...o,
});

describe('candidates', () => {
  it('same account and sign, amount within tolerance', () => {
    expect(entryCandidate(entry(), bank({ amount: $('-48') }))).toBe(true);
    expect(entryCandidate(entry(), bank({ amount: $('-60') }))).toBe(false);
    expect(entryCandidate(entry(), bank({ accountId: 'chk' }))).toBe(false);
    expect(entryCandidate(entry(), bank({ amount: $('40') }))).toBe(false);
    // Checks and ACH match exactly.
    expect(entryCandidate(entry(), bank({ amount: $('-40.01'), channel: 'check' }))).toBe(false);
  });

  it('the entry dated 0–14 days before, or up to 7 days after, the bank row (D-72)', () => {
    expect(entryCandidate(entry(), bank({ date: '2026-11-24' }))).toBe(true);
    expect(entryCandidate(entry(), bank({ date: '2026-11-25' }))).toBe(false);
    expect(entryCandidate(entry(), bank({ date: '2026-11-03' }))).toBe(true);
    expect(entryCandidate(entry(), bank({ date: '2026-11-02' }))).toBe(false);
  });

  it('a bill you add two days after the bank has it, same amount: asked about, not paired (D-72)', () => {
    const e = entry({ name: 'Calwater', amount: $('-44.99'), date: '2026-11-06', channel: 'card' });
    const b = bank({ names: ['Calwater Service'], amount: $('-44.99'), date: '2026-11-04', channel: 'ach' });
    expect(pairEntries([b], [e])).toEqual([{ kind: 'ask', bankKey: 'p:b1', candidates: ['e1'] }]);
  });
});

describe('exact evidence', () => {
  it('the name you typed equals one of Plaid’s names, without case, outer spaces or apostrophe style', () => {
    expect(entryEvidence(entry({ name: ' trader joe’s ' }), bank({ names: ["Trader Joe's", 'X'] }))).toBe(
      true,
    );
    expect(
      entryEvidence(entry({ name: 'Trader Joe' }), bank({ names: ["Trader Joe's"], amount: $('-41') })),
    ).toBe(false);
  });

  it('or the same amount on the same day (the authorization day first)', () => {
    expect(entryEvidence(entry({ name: 'Dinner' }), bank())).toBe(true);
    expect(
      entryEvidence(entry({ name: 'Dinner' }), bank({ date: '2026-11-12', authorizedDate: '2026-11-10' })),
    ).toBe(true);
    expect(entryEvidence(entry({ name: 'Dinner' }), bank({ date: '2026-11-11' }))).toBe(false);
    // A close amount alone is not evidence.
    expect(entryEvidence(entry({ name: 'Dinner' }), bank({ amount: $('-40.5') }))).toBe(false);
  });
});

describe('pairing', () => {
  it('pairs the one candidate with evidence on both sides', () => {
    expect(pairEntries([bank({ amount: $('-47'), names: ['JUNEBUG'] })], [entry()])).toEqual([
      { kind: 'pair', bankKey: 'p:b1', entryKey: 'e1' },
    ]);
  });

  it('asks "Same purchase?" when there are candidates but no evidence: a close amount alone never pairs', () => {
    expect(pairEntries([bank({ names: ['SQ *CAFE'], amount: $('-44') })], [entry()])).toEqual([
      { kind: 'ask', bankKey: 'p:b1', candidates: ['e1'] },
    ]);
  });

  it('several candidates: the one with evidence pairs; several with evidence are asked, evidence first', () => {
    const e2 = entry({ key: 'e2', name: 'Lunch', amount: $('-42') });
    expect(pairEntries([bank()], [entry(), e2])).toEqual([{ kind: 'pair', bankKey: 'p:b1', entryKey: 'e1' }]);
    const e3 = entry({ key: 'e3' });
    expect(pairEntries([bank()], [e2, entry(), e3])).toEqual([
      { kind: 'ask', bankKey: 'p:b1', candidates: ['e1', 'e3', 'e2'] },
    ]);
  });

  it('an entry with evidence for two bank rows pairs with neither (both asked)', () => {
    const b2 = bank({ key: 'p:b2', amount: $('-45'), names: ['Junebug'] });
    expect(pairEntries([bank(), b2], [entry()])).toEqual([
      { kind: 'ask', bankKey: 'p:b1', candidates: ['e1'] },
      { kind: 'ask', bankKey: 'p:b2', candidates: ['e1'] },
    ]);
  });

  it('a pair you said No to is never a candidate', () => {
    expect(pairEntries([bank()], [entry()], (b, e) => b === 'p:b1' && e === 'e1')).toEqual([]);
  });

  it('no candidates, nothing to ask', () => {
    expect(pairEntries([bank({ amount: $('-90') })], [entry()])).toEqual([]);
  });

  it('not_same keys are stored in one order', () => {
    expect(notSameKeys('p:b', 'm:a')).toEqual(['m:a', 'p:b']);
    expect(notSameKeys('m:a', 'p:b')).toEqual(['m:a', 'p:b']);
  });
});
