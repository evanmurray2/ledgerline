// What comes from a budget key (docs/privacy-keys.md section 2). The derived keys can't be exported, so each is
// checked against the same derivation done with WebCrypto's own HKDF, and the signing public key is pinned: a change
// to a label or to the salt breaks this test.
import { describe, expect, it } from 'vitest';
import {
  aeadKey,
  aeadOpen,
  aeadSeal,
  concat,
  deriveBudgetKeys,
  equal,
  fromHex,
  keySalt,
  sign,
  signPairFromSeed,
  toHex,
  utf8,
  verify,
} from '../src/index.js';

const BK = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** HKDF(BK, salt_v, label || 0x00, 32) with WebCrypto's HKDF, written out here apart from the package's own. */
async function expected(name: string, version: number): Promise<Uint8Array<ArrayBuffer>> {
  const salt = concat(Uint8Array.of(0, 0, 0, 26), utf8(BUDGET), Uint8Array.of(0, 0, 0, version));
  const info = concat(utf8(name), Uint8Array.of(0));
  const key = await crypto.subtle.importKey('raw', BK, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, 256),
  );
}

describe('budget key', () => {
  it('salt_v is str(budgetId) || u32(v)', () => {
    expect(toHex(keySalt(BUDGET, 3))).toBe(`0000001a${toHex(utf8(BUDGET))}00000003`);
    expect(() => keySalt('not-a-ulid', 1)).toThrow(RangeError);
    expect(() => keySalt(BUDGET, 0)).toThrow(RangeError);
  });

  it('derives the log, snapshot and wrap keys under their labels', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    for (const [name, key] of [
      ['ledgerline/v1/log', keys.log],
      ['ledgerline/v1/snapshot', keys.snapshot],
      ['ledgerline/v1/wrap', keys.wrap],
    ] as const) {
      expect(key.extractable).toBe(false);
      const theirs = await aeadKey(await expected(name, 1));
      const sealed = await aeadSeal(theirs, utf8('aad'), utf8(name));
      expect(equal(await aeadOpen(key, utf8('aad'), sealed), utf8(name))).toBe(true);
    }
    // Each key opens only its own.
    const sealed = await aeadSeal(keys.log, utf8('aad'), utf8('x'));
    await expect(aeadOpen(keys.snapshot, utf8('aad'), sealed)).rejects.toThrow();
    await expect(aeadOpen(keys.wrap, utf8('aad'), sealed)).rejects.toThrow();
  });

  it('derives the signing pair under its label, and pins it', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    const theirs = await signPairFromSeed(await expected('ledgerline/v1/sign', 1));
    expect(toHex(keys.sign.pub)).toBe(toHex(theirs.pub));
    expect(toHex(keys.sign.pub)).toBe('892d4aaec73bfc9c282bece0e182272ea03d50893d79ccdf71555b72211271cc');
    expect(keys.sign.privateKey.extractable).toBe(false);
    expect(await verify(keys.sign.pub, utf8('m'), await sign(keys.sign.privateKey, utf8('m')))).toBe(true);
  });

  it('derives the device check key under its label (D-116)', async () => {
    const keys = await deriveBudgetKeys(BK, BUDGET, 1);
    expect(keys.check.extractable).toBe(false);
    const theirs = await crypto.subtle.importKey(
      'raw',
      await expected('ledgerline/v1/device-check', 1),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const ours = new Uint8Array(await crypto.subtle.sign('HMAC', keys.check, utf8('m')));
    expect(toHex(ours)).toBe(toHex(new Uint8Array(await crypto.subtle.sign('HMAC', theirs, utf8('m')))));
  });

  it('another version, budget or budget key gives other keys', async () => {
    const a = await deriveBudgetKeys(BK, BUDGET, 1);
    const others = await Promise.all([
      deriveBudgetKeys(BK, BUDGET, 2),
      deriveBudgetKeys(BK, '01BX5ZZKBKACTAV9WEVGEMMVRZ', 1),
      deriveBudgetKeys(fromHex('ff'.repeat(32)), BUDGET, 1),
    ]);
    const sealed = await aeadSeal(a.log, utf8('aad'), utf8('x'));
    for (const o of others) {
      expect(toHex(o.sign.pub)).not.toBe(toHex(a.sign.pub));
      await expect(aeadOpen(o.log, utf8('aad'), sealed)).rejects.toThrow();
    }
    expect(toHex(others[0]!.sign.pub)).toBe(
      '8f28e8602d3f025b9d6501d3e2f2a6a6b7716cecb0f3d5d68a17d57b033d6700',
    );
    await expect(deriveBudgetKeys(BK.subarray(0, 16), BUDGET, 1)).rejects.toThrow(RangeError);
  });
});
