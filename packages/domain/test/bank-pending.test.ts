// Posted rows that arrive without the provider's link claim their bank pending rows (D-47). The cases come from a
// real card whose bank sends no link and keeps the pending rows listed for hours after posting.
import { describe, expect, it } from 'vitest';
import { parseCents as $ } from '../src/money.js';
import {
  bankPendingEligible,
  pairBankPending,
  storeNumbers,
  type BankPendingRow,
  type UnlinkedPostedRow,
} from '../src/matcher.js';

const pend = (key: string, amount: string, date: string, payee: string, edits = ''): BankPendingRow => ({
  key,
  accountId: 'card',
  amount: $(amount),
  date,
  authorizedDate: date,
  payee,
  channel: 'card',
  edits,
});
const post = (
  key: string,
  amount: string,
  date: string,
  auth: string | null,
  payee: string,
): UnlinkedPostedRow => ({
  key,
  accountId: 'card',
  amount: $(amount),
  date,
  authorizedDate: auth,
  payee,
  channel: 'card',
});

describe('posted rows claim bank pending rows', () => {
  it('pairs a card’s posted rows with their pending rows: tips, renamed descriptors, exact amounts', () => {
    const d = pairBankPending(
      [
        post('junebug', '-42.75', '2026-11-02', '2026-10-30', 'TST*JUNEBUG New Orleans LA'),
        post('heard', '-25.30', '2026-11-02', '2026-10-31', 'PY *HEARD DAT KITCHEN NEW ORLE'),
        post('eliz', '-97.90', '2026-11-02', '2026-11-01', "ELIZABETH'S RESTAURANT NEW ORL"),
        post('nola', '-46.86', '2026-10-31', '2026-10-30', 'NOLA POBOYS 504-522-2639 LA'),
      ],
      [
        pend('p-junebug', '-35.75', '2026-10-30', 'JUNEBUG', 'cat:dining'),
        pend('p-heard', '-25.30', '2026-10-31', 'PY HEARD DAT KITCHEN', 'cat:dining'),
        pend('p-eliz', '-97.90', '2026-11-01', 'ELIZABETH S RESTAURANT'),
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

  it('two tabs at the same bar with nothing set on either are interchangeable: paired without asking', () => {
    const d = pairBankPending(
      [
        post('a', '-28.50', '2026-11-02', '2026-10-31', 'CAFE LAFITTE 504-5256724 LA'),
        post('b', '-28.25', '2026-11-02', '2026-10-31', 'CAFE LAFITTE 504-5256724 LA'),
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

  it('never pairs yesterday’s posted purchase with today’s pending one', () => {
    expect(
      bankPendingEligible(
        pend('today', '-5.00', '2026-11-03', 'BLUE BOTTLE'),
        post('yesterday', '-5.00', '2026-11-03', '2026-11-02', 'SQ *BLUE BOTTLE'),
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

  it('needs names that look alike, unless amount and day agree exactly', () => {
    expect(
      bankPendingEligible(
        pend('lafitte', '-23.50', '2026-10-31', 'CAFE LAFITTE'),
        post('monde', '-23.50', '2026-11-01', '2026-11-01', 'CAFE DU MONDE'),
      ),
    ).toBe(false);
    expect(
      bankPendingEligible(
        pend('x', '-23.50', '2026-10-31', 'PAYPAL *ACME'),
        post('y', '-23.50', '2026-11-01', '2026-10-31', 'ACME WIDGETS INC'),
      ),
    ).toBe(true);
  });

  it('a store number in the pending description must match: two branches of one chain never pair', () => {
    expect(
      bankPendingEligible(
        pend('a', '-5.00', '2026-11-03', 'STARBUCKS 12345'),
        post('b', '-5.40', '2026-11-04', '2026-11-03', 'STARBUCKS STORE 67890 NEW YORK NY'),
      ),
    ).toBe(false);
    expect(
      bankPendingEligible(
        pend('a', '-5.00', '2026-11-03', 'STARBUCKS 12345'),
        post('b', '-5.40', '2026-11-04', '2026-11-03', 'STARBUCKS STORE 12345 NEW YORK NY'),
      ),
    ).toBe(true);
    expect(
      bankPendingEligible(
        pend('a', '-14.38', '2026-11-01', 'CAJUN SEAFOOD #3'),
        post('b', '-14.38', '2026-11-02', '2026-11-01', 'CAJUN SEAFOOD #3 NEW ORLEANS LA'),
      ),
    ).toBe(true);
  });

  it('store numbers only: dates, phone numbers, card digits and reference codes never block a pair', () => {
    expect([...storeNumbers('UBER *TRIP 10/30 HELP.UBER.COM 800-592-8996 CA')]).toEqual([]);
    expect([...storeNumbers('AMAZON MKTPL*ZX12A XXXX1234')]).toEqual([]);
    expect([...storeNumbers('STARBUCKS STORE 05521 SEATTLE WA')]).toEqual(['5521']);
    expect([...storeNumbers('CAJUN SEAFOOD #3')]).toEqual(['3']);
    expect([...storeNumbers('7-ELEVEN 34012')]).toEqual(['34012']);
    // A date or reference code on the pending row only.
    expect(
      bankPendingEligible(
        pend('a', '-18.50', '2026-10-30', 'UBER *TRIP 10/30'),
        post('b', '-22.50', '2026-11-01', '2026-10-30', 'UBER *TRIP HELP.UBER.COM CA'),
      ),
    ).toBe(true);
    expect(
      bankPendingEligible(
        pend('a', '-23.99', '2026-10-30', 'AMAZON MKTPL*ZX12A'),
        post('b', '-24.99', '2026-11-01', '2026-10-30', 'AMAZON MKTPL*ZX9QK Amzn.com/bill WA'),
      ),
    ).toBe(true);
    // A phone number on the pending row, none on the posted one.
    expect(
      bankPendingEligible(
        pend('a', '-12.00', '2026-10-30', 'SQ *CAFE 206-555-0101'),
        post('b', '-14.50', '2026-11-01', '2026-10-30', 'SQ *CAFE SEATTLE WA'),
      ),
    ).toBe(true);
    // The store number only on the pending row: the bank dropped it on posting.
    expect(
      bankPendingEligible(
        pend('a', '-5.00', '2026-11-03', 'STARBUCKS 12345'),
        post('b', '-5.40', '2026-11-04', '2026-11-03', 'STARBUCKS NEW YORK NY'),
      ),
    ).toBe(true);
    // Two branches of a chain whose name has a number.
    expect(
      bankPendingEligible(
        pend('a', '-8.00', '2026-11-03', '7-ELEVEN 34012'),
        post('b', '-8.00', '2026-11-04', '2026-11-03', '7-ELEVEN 39977 SEATTLE WA'),
      ),
    ).toBe(false);
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
