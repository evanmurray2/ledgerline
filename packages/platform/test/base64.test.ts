import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bytesToHex, fromBase64, fromBase64url, isBase64, toBase64, toBase64url } from '../src/base64.js';

/** What the call sites did before: one character at a time, then btoa. */
const slowB64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
/** Byte for byte (toEqual on a megabyte is slow). */
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

describe('base64', () => {
  it('writes what btoa writes, at every length of the last group', () => {
    for (let n = 0; n < 64; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      expect(toBase64(b)).toBe(slowB64(b));
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8=');
  });

  it('handles more than 1 MB at once', () => {
    const b = new Uint8Array(1_500_001);
    for (let i = 0; i < b.length; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
    const s = toBase64(b);
    expect(s.length).toBe(Math.ceil(b.length / 3) * 4);
    expect(s.slice(0, 4000)).toBe(slowB64(b.subarray(0, 3000)));
    expect(same(fromBase64(s), b)).toBe(true);
    expect(isBase64(s)).toBe(true);
    const u = toBase64url(b);
    expect(u).not.toMatch(/[+/=]/);
    expect(same(fromBase64url(u), b)).toBe(true);
    expect(bytesToHex(b).length).toBe(b.length * 2);
  });

  it('reads as atob reads, and throws where it throws', () => {
    expect(fromBase64('AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromBase64('AQ')).toEqual(new Uint8Array([1]));
    expect(fromBase64('AQ==')).toEqual(new Uint8Array([1]));
    expect(() => fromBase64('AQIDB')).toThrow();
    expect(() => fromBase64('A*')).toThrow();
  });

  it('base64url drops the padding and reads it either way', () => {
    const b = new Uint8Array([0xfb, 0xff]);
    expect(toBase64url(b)).toBe('-_8');
    expect(fromBase64url('-_8')).toEqual(b);
    expect(fromBase64url('-_8=')).toEqual(b);
  });

  it('isBase64 gives the pattern’s answer', () => {
    for (const s of ['', 'A', 'A=', 'A==', 'A===', '=', '==', 'AB=C', 'AB =', 'AB\n', 'QUJD', 'QQ==', 'Q=Q='])
      expect(isBase64(s), s).toBe(PATTERN.test(s));
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9+/= \n*-]{0,12}$/), (s) => isBase64(s) === PATTERN.test(s)),
      { numRuns: 5000 },
    );
  });

  it('hex is lower case, two digits a byte', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 0xab, 0xff]))).toBe('0001abff');
  });
});
