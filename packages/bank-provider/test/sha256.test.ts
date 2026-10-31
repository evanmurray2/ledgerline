import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sha256HexSync } from '../src/sha256.js';
import { sha256Hex } from '../src/plaid.js';

describe('sha256HexSync', () => {
  it('matches the FIPS test vectors', () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexSync('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('matches WebCrypto for any string, including block boundaries and non-ASCII', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300, unit: 'grapheme' }), async (s) => {
        expect(sha256HexSync(s)).toBe(await sha256Hex(s));
      }),
      { numRuns: 300 },
    );
    for (let n = 50; n < 140; n++) {
      const s = 'x'.repeat(n);
      expect(sha256HexSync(s)).toBe(await sha256Hex(s));
    }
  });
});
