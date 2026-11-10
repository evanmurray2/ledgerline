// SHA-256, HMAC-SHA-256 and HKDF-SHA-256 (RFC 5869), on WebCrypto. HKDF is written as its two steps, extract and
// expand, because HPKE (RFC 9180) uses them apart and WebCrypto only offers them joined.
import { type Bytes, bytes, concat, u8 } from './bytes.js';

export const HASH_LEN = 32;

export async function sha256(x: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', x as Bytes));
}

export async function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  // HMAC pads a short key with zeros, so an empty key and 32 zero bytes are the same key; WebCrypto refuses the
  // empty one.
  const k = raw.length === 0 ? bytes(HASH_LEN) : (raw as Bytes);
  return crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmac(key: Uint8Array | CryptoKey, x: Uint8Array): Promise<Bytes> {
  const k = key instanceof Uint8Array ? await hmacKey(key) : key;
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, x as Bytes));
}

/** Checks an HMAC in constant time (WebCrypto's verify). */
export async function hmacVerify(
  key: Uint8Array | CryptoKey,
  x: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  const k = key instanceof Uint8Array ? await hmacKey(key) : key;
  return crypto.subtle.verify('HMAC', k, mac as Bytes, x as Bytes);
}

/** HKDF-Extract: a salt of no bytes means 32 zero bytes. */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Bytes> {
  return hmac(salt, ikm);
}

/** HKDF-Expand to `n` bytes (at most 255 blocks). */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, n: number): Promise<Bytes> {
  if (!Number.isInteger(n) || n < 0 || n > 255 * HASH_LEN) throw new RangeError('hkdf length');
  const key = await hmacKey(prk);
  const out = bytes(n);
  let t: Uint8Array = bytes(0);
  for (let i = 1, o = 0; o < n; i++) {
    const block = concat(t, info, u8(i));
    const next = await hmac(key, block);
    block.fill(0);
    t.fill(0);
    t = next;
    out.set(t.subarray(0, Math.min(HASH_LEN, n - o)), o);
    o += HASH_LEN;
  }
  t.fill(0);
  return out;
}

/** HKDF(ikm, salt, info, n) as docs/privacy-keys.md writes it. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, n: number): Promise<Bytes> {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, n);
}
