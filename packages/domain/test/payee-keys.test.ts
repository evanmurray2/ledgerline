// A bank row's payee keys and a new payee's name (docs/payee-names.md 4, 5): Plaid's values as sent, compared only by
// payeeNameKey (case, outer spaces and apostrophes).
import { describe, expect, it } from 'vitest';
import { nameKey, newPayeeName, payeeKeys, type PayeeSource } from '../src/payee.js';

const row = (o: Partial<PayeeSource>): PayeeSource => ({
  merchantEntityId: null,
  merchantName: null,
  plaidName: null,
  rawName: 'RAW TEXT',
  ...o,
});

describe('payee keys', () => {
  it('merchant id, then merchant name, then Plaid name, without repeats', () => {
    expect(
      payeeKeys(
        row({
          merchantEntityId: 'ent_hulu',
          merchantName: 'Hulu',
          plaidName: 'Hlu Huluplus',
          rawName: 'HLU*HULUPLUS HULU.COM/BILL CA',
        }),
      ),
    ).toEqual(['m:ent_hulu', 'n:hulu', 'n:hlu huluplus']);
    expect(payeeKeys(row({ merchantName: 'Hulu', plaidName: ' HULU ' }))).toEqual(['n:hulu']);
  });

  it('a row with neither name has its bank text as its one key', () => {
    expect(payeeKeys(row({ rawName: 'MYSTERY 1' }))).toEqual(['n:mystery 1']);
    expect(payeeKeys(row({ merchantEntityId: 'e1', rawName: 'MYSTERY 1' }))).toEqual(['m:e1', 'n:mystery 1']);
  });

  it('compares names only by case, outer spaces and apostrophes; nothing else is cleaned', () => {
    expect(nameKey('Trader Joe’s')).toBe(nameKey(" trader joe's"));
    expect(nameKey('Shell')).not.toBe(nameKey('Shell Oil'));
    expect(nameKey('SQ *BLUE BOTTLE 0123')).toBe('n:sq *blue bottle 0123');
  });
});

describe('a new payee’s name', () => {
  it('is the merchant name, else Plaid’s name, else the bank text exactly', () => {
    expect(newPayeeName(row({ merchantName: 'Hulu', plaidName: 'Hlu Huluplus' }))).toBe('Hulu');
    expect(newPayeeName(row({ plaidName: 'Venmo' }))).toBe('Venmo');
    expect(newPayeeName(row({ rawName: 'HLU*HULUPLUS HULU.COM/BILL CA' }))).toBe(
      'HLU*HULUPLUS HULU.COM/BILL CA',
    );
    // No title case, no tidy step.
    expect(newPayeeName(row({ plaidName: 'ZELLE FROM SAM' }))).toBe('ZELLE FROM SAM');
  });
});
