// Posted rows that arrive without the provider's link claim their bank pending rows (D-47), on exact evidence only
// (docs/payee-names.md 9.3): the same merchant (Plaid's merchant id, or a Plaid name equal to a Plaid name), or the
// same amount on the same day. Otherwise "Same purchase?" asks. The cases come from a real card whose bank sends no
// link and keeps the pending rows listed for hours after posting.
import { describe, expect, it } from 'vitest';
import { parseCents as $ } from '../src/money.js';
import {
  bankPendingEligible,
  bankPendingEvidence,
  merchantKeys,
  pairBankPending,
  sameMerchant,
  type BankPendingRow,
  type Merchant,
  type UnlinkedPostedRow,
} from '../src/matcher.js';

/** Plaid's fields: a string is Plaid's `name` only; an object sets any of them. */
type Who = string | Partial<Merchant>;
const who = (w: Who): Merchant => ({
  merchantEntityId: null,
  merchantName: null,
  plaidName: null,
  ...(typeof w === 'string' ? { plaidName: w } : w),
});
const pend = (key: string, amount: string, date: string, w: Who, edits = ''): BankPendingRow => ({
  key,
  accountId: 'card',
  amount: $(amount),
  date,
  authorizedDate: date,
  ...who(w),
  channel: 'card',
  edits,
});
const post = (key: string, amount: string, date: string, auth: string | null, w: Who): UnlinkedPostedRow => ({
  key,
  accountId: 'card',
  amount: $(amount),
  date,
  authorizedDate: auth,
  ...who(w),
  channel: 'card',
});

describe('exact evidence', () => {
  it('same merchant: the merchant id, or a Plaid name equal to a Plaid name (case and spaces aside)', () => {
    expect(sameMerchant(who({ merchantEntityId: 'm1' }), who({ merchantEntityId: 'm1' }))).toBe(true);
    expect(sameMerchant(who('JUNEBUG'), who({ merchantName: 'Junebug ' }))).toBe(true);
    expect(sameMerchant(who({ merchantName: 'Junebug' }), who('TST*JUNEBUG New Orleans LA'))).toBe(false);
    // Different merchant ids don't block a pair: the names may still agree (one payee, two ids).
    expect(
      sameMerchant(
        who({ merchantEntityId: 'm1', merchantName: 'Uber' }),
        who({ merchantEntityId: 'm2', merchantName: 'Uber' }),
      ),
    ).toBe(true);
    // Rows without any Plaid name never share a merchant: the bank text is not a key here.
    expect(sameMerchant(who({}), who({}))).toBe(false);
    expect(merchantKeys(who({ merchantEntityId: 'm1', merchantName: 'Hulu', plaidName: 'HULU' }))).toEqual([
      'm:m1',
      'n:hulu',
      'n:hulu',
    ]);
  });

  it('same amount on the same day (authorization day, else date) is evidence; a close amount is not', () => {
    expect(
      bankPendingEvidence(
        pend('p', '-23.50', '2026-10-31', 'PAYPAL *ACME'),
        post('q', '-23.50', '2026-11-01', '2026-10-31', 'ACME WIDGETS INC'),
      ),
    ).toBe(true);
    expect(
      bankPendingEvidence(
        pend('p', '-23.50', '2026-10-31', 'PAYPAL *ACME'),
        post('q', '-23.51', '2026-11-01', '2026-10-31', 'ACME WIDGETS INC'),
      ),
    ).toBe(false);
    expect(
      bankPendingEvidence(
        pend('p', '-23.50', '2026-10-31', 'PAYPAL *ACME'),
        post('q', '-23.50', '2026-11-01', '2026-11-01', 'ACME WIDGETS INC'),
      ),
    ).toBe(false);
  });
});

describe('posted rows claim bank pending rows', () => {
  it('pairs a card’s posted rows with their pending rows: a tip with the same name, an exact amount and day', () => {
    const d = pairBankPending(
      [
        post('junebug', '-42.75', '2026-11-02', '2026-10-30', {
          merchantName: 'Junebug',
          plaidName: 'JUNEBUG',
        }),
        post('heard', '-25.30', '2026-11-02', '2026-10-31', 'PY *HEARD DAT KITCHEN NEW ORLE'),
        post('eliz', '-97.90', '2026-11-02', '2026-11-01', { merchantEntityId: 'eliz' }),
        post('nola', '-46.86', '2026-10-31', '2026-10-30', 'NOLA POBOYS 504-522-2639 LA'),
      ],
      [
        pend('p-junebug', '-35.75', '2026-10-30', 'JUNEBUG', 'cat:dining'),
        pend('p-heard', '-25.30', '2026-10-31', 'PY HEARD DAT KITCHEN', 'cat:dining'),
        pend('p-eliz', '-97.90', '2026-11-01', {
          merchantEntityId: 'eliz',
          plaidName: 'ELIZABETH S RESTAURANT',
        }),
        pend('p-claib', '-50.00', '2026-11-01', 'Claiborne Express', 'cat:travel'),
        pend('p-cookies', '-9.54', '2026-11-01', 'INSOMNIA COOKIES-NEW ORL'),
      ],
    );
    expect(d).toEqual(
      expect.arrayContaining([
        { kind: 'claim', postedKey: 'junebug', pendingKey: 'p-junebug' },
        { kind: 'claim', postedKey: 'heard', pendingKey: 'p-heard' },
        { kind: 'claim', postedKey: 'eliz', pendingKey: 'p-eliz' },
      ]),
    );
    expect(d).toHaveLength(3); // nola has no pending row; the other pending rows haven't posted
  });

  it('a tip whose pending row has another Plaid name: "Same purchase?" asks, best first', () => {
    const d = pairBankPending(
      [post('tab', '-28.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE 504-5256724 LA')],
      [
        pend('p-hold', '-25.00', '2026-10-31', 'SOMEWHERE ELSE'),
        pend('p-tab', '-23.50', '2026-10-31', 'CAFE LAFITTE'),
      ],
    );
    expect(d).toEqual([{ kind: 'ask', postedKey: 'tab', candidates: ['p-hold', 'p-tab'] }]);
    // No to a candidate takes it out; No to every one leaves nothing to ask.
    expect(
      pairBankPending(
        [post('tab', '-28.50', '2026-11-02', '2026-10-31', 'X')],
        [pend('p', '-23.50', '2026-10-31', 'Y')],
        () => true,
      ),
    ).toEqual([]);
  });

  it('two tabs at the same bar with nothing set on either are interchangeable: paired without asking', () => {
    const d = pairBankPending(
      [
        post('a', '-28.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
        post('b', '-28.25', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
      ],
      [
        pend('p1', '-23.50', '2026-10-31', 'CAFE LAFITTE'),
        pend('p2', '-23.25', '2026-10-31', 'CAFE LAFITTE'),
        pend('h1', '-5.00', '2026-10-31', 'CAFE LAFITTE'), // a hold: too far from either amount
        pend('h2', '-5.00', '2026-10-31', 'CAFE LAFITTE'),
      ],
    );
    expect(d.map((x) => x.kind)).toEqual(['claim', 'claim']);
    expect(new Set(d.map((x) => (x.kind === 'claim' ? x.pendingKey : '')))).toEqual(new Set(['p1', 'p2']));
  });

  it('asks when the twins carry different edits', () => {
    const d = pairBankPending(
      [post('a', '-28.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE')],
      [
        pend('p1', '-23.50', '2026-10-31', 'CAFE LAFITTE', 'cat:dining'),
        pend('p2', '-23.25', '2026-10-31', 'CAFE LAFITTE', 'cat:gifts'),
      ],
    );
    expect(d).toEqual([{ kind: 'ambiguous', postedKey: 'a', candidates: ['p1', 'p2'] }]);
  });

  it('twins carrying the same edits are still interchangeable', () => {
    const d = pairBankPending(
      [
        post('a', '-28.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
        post('b', '-28.25', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
      ],
      [
        pend('p1', '-23.50', '2026-10-31', 'CAFE LAFITTE', 'cat:dining'),
        pend('p2', '-23.25', '2026-10-31', 'CAFE LAFITTE', 'cat:dining'),
      ],
    );
    expect(d.map((x) => x.kind)).toEqual(['claim', 'claim']);
  });

  it('asks when two posted rows fit a pending row that carries your edits', () => {
    const d = pairBankPending(
      [
        post('a', '-23.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
        post('b', '-23.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
      ],
      [pend('p1', '-23.50', '2026-10-31', 'CAFE LAFITTE', 'memo:birthday')],
    );
    expect(d).toEqual([{ kind: 'ambiguous', postedKey: 'a', candidates: ['p1'] }]);
  });

  it('two branches of a chain: one merchant id each, so a close amount asks; an exact amount and day pairs', () => {
    const branch = (id: string) => ({ merchantEntityId: id, plaidName: `STARBUCKS ${id}` });
    expect(
      pairBankPending(
        [post('b', '-5.40', '2026-11-04', '2026-11-03', branch('67890'))],
        [pend('a', '-5.00', '2026-11-03', branch('12345'))],
      ),
    ).toEqual([{ kind: 'ask', postedKey: 'b', candidates: ['a'] }]);
    expect(
      pairBankPending(
        [post('b', '-5.00', '2026-11-04', '2026-11-03', branch('67890'))],
        [pend('a', '-5.00', '2026-11-03', branch('12345'))],
      ),
    ).toEqual([{ kind: 'claim', postedKey: 'b', pendingKey: 'a' }]);
  });

  it('the same merchant beats an exact amount on the same day from another merchant', () => {
    const d = pairBankPending(
      [post('q', '-20.00', '2026-11-04', '2026-11-03', { merchantEntityId: 'shop' })],
      [
        pend('other', '-20.00', '2026-11-03', 'ELSEWHERE'),
        pend('mine', '-20.00', '2026-11-03', { merchantEntityId: 'shop' }),
      ],
    );
    expect(d).toEqual([{ kind: 'claim', postedKey: 'q', pendingKey: 'mine' }]);
  });

  it('never pairs yesterday’s posted purchase with today’s pending one', () => {
    expect(
      bankPendingEligible(
        pend('today', '-5.00', '2026-11-03', 'BLUE BOTTLE'),
        post('yesterday', '-5.00', '2026-11-03', '2026-11-02', 'BLUE BOTTLE'),
      ),
    ).toBe(false);
    // Authorized the day after the pending row is fine (the parking charge: pending Oct 31, authorized Nov 1).
    expect(
      bankPendingEligible(
        pend('park', '-0.40', '2026-10-31', '90949 - NEW ORLEAN'),
        post('park-posted', '-0.40', '2026-11-02', '2026-11-01', '90949 - NEW ORLEANS PARKINEW O'),
      ),
    ).toBe(true);
  });

  it('keeps the tolerance: a $5 hold never claims a $28 tab, a refund never claims a purchase', () => {
    expect(
      bankPendingEligible(
        pend('h', '-5.00', '2026-10-31', 'CAFE LAFITTE'),
        post('t', '-28.25', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
      ),
    ).toBe(false);
    expect(
      bankPendingEligible(
        pend('r', '5.00', '2026-10-31', 'CAFE LAFITTE'),
        post('t', '-5.00', '2026-11-02', '2026-10-31', 'CAFE LAFITTE'),
      ),
    ).toBe(false);
  });

  it('without an authorization date, uses the posted date 0–14 days after', () => {
    const p = pend('p', '-40.00', '2026-11-01', 'SHOP');
    expect(bankPendingEligible(p, post('q', '-40.00', '2026-11-10', null, 'SHOP'))).toBe(true);
    expect(bankPendingEligible(p, post('q', '-40.00', '2026-11-20', null, 'SHOP'))).toBe(false);
    expect(bankPendingEligible(p, post('q', '-40.00', '2026-10-31', null, 'SHOP'))).toBe(false);
  });
});
