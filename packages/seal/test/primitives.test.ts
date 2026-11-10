// The building blocks of docs/privacy-keys.md, checked against published test vectors (RFC 5869, RFC 7748, RFC 8032)
// and against WebCrypto's own HKDF.
import { describe, expect, it } from 'vitest';
import {
  aeadKey,
  aeadOpen,
  aeadSeal,
  bytes,
  concat,
  dh,
  dhPairFromSeed,
  equal,
  FormatError,
  fromB64url,
  fromHex,
  hkdf,
  hkdfExpand,
  hkdfExtract,
  hmac,
  hmacVerify,
  isUlid,
  label,
  OpenError,
  pad,
  PAD_STEPS,
  randomBytes,
  Reader,
  sha256,
  sign,
  signPairFromSeed,
  str,
  toB64url,
  toHex,
  u16,
  u32,
  u64,
  u8,
  unpad,
  utf8,
  verify,
  WeakKeyError,
} from '../src/index.js';

describe('bytes', () => {
  it('writes whole numbers big-endian and refuses what does not fit', () => {
    expect(toHex(u8(255))).toBe('ff');
    expect(toHex(u16(0x1234))).toBe('1234');
    expect(toHex(u32(0x01020304))).toBe('01020304');
    expect(toHex(u64(2 ** 40 + 5))).toBe('0000010000000005');
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => u8(bad)).toThrow(RangeError);
      expect(() => u64(bad)).toThrow(RangeError);
    }
    expect(() => u8(256)).toThrow(RangeError);
    expect(() => u16(65536)).toThrow(RangeError);
    expect(() => u32(2 ** 32)).toThrow(RangeError);
    expect(() => u64(2 ** 53)).toThrow(RangeError);
  });

  it('str puts the length first, so field lists cannot run together', () => {
    expect(toHex(str('ab'))).toBe('000000026162');
    expect(equal(concat(str('a'), str('bc')), concat(str('ab'), str('c')))).toBe(false);
  });

  it('a label ends in a zero byte, so none is the start of another', () => {
    expect(toHex(label('ledgerline/v1/x'))).toBe(`${toHex(utf8('ledgerline/v1/x'))}00`);
    const snap = label('ledgerline/v1/snap');
    const snapshot = label('ledgerline/v1/snapshot');
    expect(equal(snapshot.subarray(0, snap.length), snap)).toBe(false);
    expect(() => label('other/v1/x')).toThrow(RangeError);
    expect(() => label('ledgerline/v1/a b')).toThrow(RangeError);
    expect(() => label('ledgerline/v1/a\0b')).toThrow(RangeError);
  });

  it('a reader is strict: short input, long fields and bytes left over are refused', () => {
    const b = concat(utf8('LLE1'), u8(7), u16(513), u32(9), u64(10), str('hello'));
    const r = new Reader(b);
    r.magic('LLE1');
    expect([r.u8(), r.u16(), r.u32(), r.u64(), r.text(255)]).toEqual([7, 513, 9, 10, 'hello']);
    r.end();
    expect(() => new Reader(b).magic('LLG1')).toThrow(FormatError);
    expect(() => new Reader(concat(b, u8(0))).take(b.length) && new Reader(concat(b, u8(0))).end()).toThrow(
      FormatError,
    );
    expect(() => new Reader(u16(1)).u32()).toThrow(FormatError);
    expect(() => new Reader(str('toolong')).str(3)).toThrow(FormatError);
    expect(() => new Reader(concat(u32(5), utf8('ab'))).str(255)).toThrow(FormatError);
    expect(() => new Reader(concat(u32(2), Uint8Array.of(0xff, 0xfe))).text(255)).toThrow(FormatError);
    expect(() => new Reader(fromHex('ffffffffffffffff')).u64()).toThrow(FormatError);
  });

  it('hex and base64url go both ways, and ids are ULIDs', () => {
    const b = randomBytes(33);
    expect(equal(fromHex(toHex(b)), b)).toBe(true);
    expect(equal(fromB64url(toB64url(b)), b)).toBe(true);
    expect(toB64url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
    expect(() => fromHex('abc')).toThrow(RangeError);
    expect(() => fromB64url('a+b')).toThrow(RangeError);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01arz3ndektsv4rrffq69g5fav')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });
});

describe('HKDF and HMAC', () => {
  it('RFC 5869 test case 1', async () => {
    const ikm = fromHex('0b'.repeat(22));
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const prk = await hkdfExtract(salt, ikm);
    expect(toHex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');
    expect(toHex(await hkdfExpand(prk, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('RFC 5869 test case 3: no salt and no info, and no salt is 32 zero bytes', async () => {
    const ikm = fromHex('0b'.repeat(22));
    const okm = '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8';
    expect(toHex(await hkdf(ikm, bytes(0), bytes(0), 42))).toBe(okm);
    expect(toHex(await hkdf(ikm, bytes(32), bytes(0), 42))).toBe(okm);
  });

  it('agrees with WebCrypto’s own HKDF', async () => {
    for (const n of [16, 32, 64, 100]) {
      const [ikm, salt, info] = [randomBytes(32), randomBytes(40), randomBytes(70)];
      const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      const theirs = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, n * 8),
      );
      expect(toHex(await hkdf(ikm, salt, info, n))).toBe(toHex(theirs));
    }
  });

  it('an HMAC verifies only for its key and message', async () => {
    const k = randomBytes(32);
    const mac = await hmac(k, utf8('message'));
    expect(mac.length).toBe(32);
    expect(await hmacVerify(k, utf8('message'), mac)).toBe(true);
    expect(await hmacVerify(k, utf8('messagf'), mac)).toBe(false);
    expect(await hmacVerify(randomBytes(32), utf8('message'), mac)).toBe(false);
    expect(toHex(await sha256(utf8('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('AES-256-GCM', () => {
  it('opens what it sealed, with a fresh nonce each time', async () => {
    const key = await aeadKey(randomBytes(32));
    const [aad, plain] = [utf8('aad'), utf8('a budget row')];
    const a = await aeadSeal(key, aad, plain);
    const b = await aeadSeal(key, aad, plain);
    expect(a.length).toBe(12 + plain.length + 16);
    expect(equal(a, b)).toBe(false);
    expect(equal(await aeadOpen(key, aad, a), plain)).toBe(true);
  });

  it('refuses a changed byte, other associated data, another key and a short value', async () => {
    const key = await aeadKey(randomBytes(32));
    const sealed = await aeadSeal(key, utf8('aad'), utf8('plain'));
    for (let i = 0; i < sealed.length; i++) {
      const bad = sealed.slice();
      bad[i]! ^= 1;
      await expect(aeadOpen(key, utf8('aad'), bad)).rejects.toThrow(OpenError);
    }
    await expect(aeadOpen(key, utf8('aae'), sealed)).rejects.toThrow(OpenError);
    await expect(aeadOpen(await aeadKey(randomBytes(32)), utf8('aad'), sealed)).rejects.toThrow(OpenError);
    await expect(aeadOpen(key, utf8('aad'), sealed.subarray(0, 20))).rejects.toThrow(OpenError);
    await expect(aeadKey(randomBytes(16))).rejects.toThrow(RangeError);
  });
});

describe('key pairs from seeds', () => {
  it('Ed25519: RFC 8032 test 1 gives the published public key, and its signature verifies', async () => {
    const pair = await signPairFromSeed(
      fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
    );
    expect(toHex(pair.pub)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    expect(pair.privateKey.extractable).toBe(false);
    const published = fromHex(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(await verify(pair.pub, bytes(0), published)).toBe(true);
    expect(await verify(pair.pub, utf8('x'), published)).toBe(false);
    // Signature bytes are never compared (implementations may differ): only that a signature verifies.
    const sig = await sign(pair.privateKey, utf8('entry'));
    expect(await verify(pair.pub, utf8('entry'), sig)).toBe(true);
    expect(await verify(pair.pub, utf8('entry'), sig.subarray(0, 63))).toBe(false);
    expect(await verify((await signPairFromSeed(randomBytes(32))).pub, utf8('entry'), sig)).toBe(false);
  });

  it('X25519: RFC 7748 section 6.1 gives the published public keys and shared secret', async () => {
    const alice = await dhPairFromSeed(
      fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
    );
    const bob = await dhPairFromSeed(
      fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'),
    );
    expect(toHex(alice.pub)).toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
    expect(toHex(bob.pub)).toBe('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
    expect(alice.privateKey.extractable).toBe(false);
    const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(await dh(alice.privateKey, bob.pub))).toBe(shared);
    expect(toHex(await dh(bob.privateKey, alice.pub))).toBe(shared);
  });

  it('X25519 refuses a public key that gives an all-zero secret', async () => {
    const pair = await dhPairFromSeed(randomBytes(32));
    await expect(dh(pair.privateKey, bytes(32))).rejects.toThrow(WeakKeyError);
    const one = bytes(32);
    one[0] = 1;
    await expect(dh(pair.privateKey, one)).rejects.toThrow(WeakKeyError);
  });
});

describe('padding', () => {
  it('pads to the smallest step that fits and comes back exactly', () => {
    for (const n of [0, 1, 254, 255, 256, 1023, 1024, 4095, 16383, 16384, 65535]) {
      const x = randomBytes(n);
      const p = pad(x);
      expect((PAD_STEPS as readonly number[]).includes(p.length)).toBe(true);
      expect(p.length).toBe(PAD_STEPS.find((s) => n + 1 <= s));
      expect(equal(unpad(p), x)).toBe(true);
    }
    // A body that ends in zeros or in 0x80 keeps them.
    for (const x of [fromHex('0000'), fromHex('80'), fromHex('8000')])
      expect(equal(unpad(pad(x)), x)).toBe(true);
    expect(() => pad(bytes(65536))).toThrow(RangeError);
  });

  it('refuses a wrong length, a missing marker and padding to a larger step than needed', () => {
    expect(() => unpad(bytes(255))).toThrow(FormatError);
    expect(() => unpad(bytes(256))).toThrow(FormatError);
    const noMarker = bytes(256).fill(1);
    expect(() => unpad(noMarker)).toThrow(FormatError);
    const tooFar = bytes(1024);
    tooFar[10] = 0x80;
    expect(() => unpad(tooFar)).toThrow(FormatError);
  });
});
