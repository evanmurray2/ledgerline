// HPKE base mode for DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM (docs/privacy-keys.md section 3), against
// the CFRG's published test vector for exactly this suite (hpke-vector.json: mode 0, KEM 0x0020, KDF 0x0001, AEAD
// 0x0002, taken from test-vectors.json of github.com/cfrg/draft-irtf-cfrg-hpke). The vectors printed in RFC 9180's
// own appendix use other AEADs with X25519.
import { describe, expect, it } from 'vitest';
import { dhPairFromSeed, equal, fromHex, hpke, OpenError, randomBytes, toHex, utf8 } from '../src/index.js';
import vector from './hpke-vector.json' with { type: 'json' };

describe('HPKE', () => {
  it('is the suite the formats name', () => {
    expect([vector.mode, vector.kem_id, vector.kdf_id, vector.aead_id]).toEqual([0, 0x20, 1, 2]);
  });

  it('derives the vector’s key pairs', async () => {
    expect(toHex((await hpke.deriveKeyPair(fromHex(vector.ikmE))).pub)).toBe(vector.pkEm);
    expect(toHex((await hpke.deriveKeyPair(fromHex(vector.ikmR))).pub)).toBe(vector.pkRm);
    expect(toHex((await dhPairFromSeed(fromHex(vector.skRm))).pub)).toBe(vector.pkRm);
  });

  it('seals to the vector’s exact bytes, and opens them', async () => {
    const e = vector.encryption;
    const eph = await hpke.deriveKeyPair(fromHex(vector.ikmE));
    const sealed = await hpke.sealWith(
      eph,
      fromHex(vector.pkRm),
      fromHex(vector.info),
      fromHex(e.aad),
      fromHex(e.pt),
    );
    expect(toHex(sealed)).toBe(vector.enc + e.ct);
    const recipient = await dhPairFromSeed(fromHex(vector.skRm));
    expect(toHex(await hpke.open(recipient, fromHex(vector.info), fromHex(e.aad), sealed))).toBe(e.pt);
  });

  it('opens what it sealed with a fresh one-time key, and nothing else', async () => {
    const recipient = await dhPairFromSeed(randomBytes(32));
    const [info, aad, plain] = [utf8('info'), utf8('aad'), randomBytes(32)];
    const a = await hpke.seal(recipient.pub, info, aad, plain);
    const b = await hpke.seal(recipient.pub, info, aad, plain);
    expect(a.length).toBe(hpke.sealedLength(32));
    expect(a.length).toBe(80);
    expect(equal(a, b)).toBe(false);
    expect(equal(await hpke.open(recipient, info, aad, a), plain)).toBe(true);

    await expect(hpke.open(recipient, utf8('infp'), aad, a)).rejects.toThrow(OpenError);
    await expect(hpke.open(recipient, info, utf8('aae'), a)).rejects.toThrow(OpenError);
    await expect(hpke.open(await dhPairFromSeed(randomBytes(32)), info, aad, a)).rejects.toThrow(OpenError);
    await expect(hpke.open(recipient, info, aad, a.subarray(0, 40))).rejects.toThrow(OpenError);
    for (const i of [0, 31, 32, 60, 79]) {
      const bad = a.slice();
      bad[i]! ^= 1;
      await expect(hpke.open(recipient, info, aad, bad)).rejects.toThrow(OpenError);
    }
  });

  it('refuses to seal to an all-zero public key', async () => {
    await expect(hpke.seal(new Uint8Array(32), utf8('i'), utf8('a'), utf8('p'))).rejects.toThrow();
  });
});
