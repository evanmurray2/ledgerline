// Ed25519 and X25519 key pairs from 32-byte seeds (docs/privacy-keys.md section 2). WebCrypto can't derive these key
// types and can't give the public half of a private key it won't export, so a seed is wrapped as PKCS#8 by a fixed
// prefix and the public half is worked out here.
import { type Bytes, bytes, concat, equal, fromB64url, fromHex, toHex, zeroize } from './bytes.js';

const PKCS8_ED25519 = fromHex('302e020100300506032b657004220420');
const PKCS8_X25519 = fromHex('302e020100300506032b656e04220420');

export interface SignPair {
  /** Non-extractable. */
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** The public half, 32 raw bytes. */
  pub: Bytes;
}

export interface DhPair {
  /** Non-extractable. */
  privateKey: CryptoKey;
  /** The public half, 32 raw bytes. */
  pub: Bytes;
}

/**
 * An Ed25519 pair from a seed. The seed is imported once as extractable to read the public half from its JWK, then
 * again as non-extractable, which is the key that is kept. The caller zeroes the seed.
 */
export async function signPairFromSeed(seed: Uint8Array): Promise<SignPair> {
  if (seed.length !== 32) throw new RangeError('seed');
  const pkcs8 = concat(PKCS8_ED25519, seed);
  try {
    const open = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    // `as JsonWebKey`: Cloudflare's WebCrypto types give 'jwk' the same return type as the other formats.
    const jwk = (await crypto.subtle.exportKey('jwk', open)) as JsonWebKey;
    const x = jwk.x;
    // The JWK also holds the seed, as text. JavaScript can't erase a string; dropping the reference is all there is.
    jwk.d = '';
    if (typeof x !== 'string') throw new Error('Ed25519: this browser gave no public key');
    const pub = fromB64url(x);
    if (pub.length !== 32) throw new Error('Ed25519: public key');
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    return { privateKey, publicKey: await signPublicKey(pub), pub };
  } finally {
    zeroize(pkcs8);
  }
}

/**
 * The encodings of the Ed25519 points of small order, canonical and not. A signature of zeros verifies under some of
 * them for any message on some engines, so they are never a signing key.
 */
const WEAK_SIGN_KEYS = new Set([
  '01' + '00'.repeat(31),
  '01' + '00'.repeat(30) + '80',
  '00'.repeat(32),
  '00'.repeat(31) + '80',
  'ec' + 'ff'.repeat(30) + '7f',
  'ec' + 'ff'.repeat(31),
  'ed' + 'ff'.repeat(30) + '7f',
  'ed' + 'ff'.repeat(31),
  'ee' + 'ff'.repeat(30) + '7f',
  'ee' + 'ff'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
]);

/** Whether 32 bytes are a small-order point, which is never a signing key. */
export const isWeakSignKey = (pub: Uint8Array): boolean => WEAK_SIGN_KEYS.has(toHex(pub));

export function signPublicKey(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.length !== 32 || isWeakSignKey(pub)) throw new RangeError('public key');
  return crypto.subtle.importKey('raw', pub as Bytes, { name: 'Ed25519' }, true, ['verify']);
}

export async function sign(privateKey: CryptoKey, message: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message as Bytes));
}

/** Whether a signature verifies. A public key or a signature that isn't one is simply "no", on every engine. */
export async function verify(
  pub: Uint8Array | CryptoKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64) return false;
  try {
    const key = pub instanceof Uint8Array ? await signPublicKey(pub) : pub;
    return await crypto.subtle.verify('Ed25519', key, signature as Bytes, message as Bytes);
  } catch {
    return false;
  }
}

/** The X25519 base point, u = 9. */
const BASE_POINT = (() => {
  const b = bytes(32);
  b[0] = 9;
  return b;
})();

function dhPublicKey(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.length !== 32) throw new RangeError('public key');
  return crypto.subtle.importKey('raw', pub as Bytes, { name: 'X25519' }, true, []);
}

/**
 * X25519 with WebCrypto. The browser's WebCrypto types and Cloudflare's spell the public key's field differently
 * (`public`, `$public`); every engine takes `public`, so the algorithm is written once here, with a cast that both
 * accept. This is what lets the package type-check under both, and the Worker import its real types.
 */
async function x25519Bits(privateKey: CryptoKey, publicKey: CryptoKey): Promise<Bytes> {
  const algorithm = { name: 'X25519', public: publicKey } as Parameters<typeof crypto.subtle.deriveBits>[0];
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
}

async function dhRaw(privateKey: CryptoKey, pub: Uint8Array): Promise<Bytes> {
  return x25519Bits(privateKey, await dhPublicKey(pub));
}

/**
 * An X25519 pair from a seed (the private scalar; X25519 clamps it itself). The private key is imported once, as
 * non-extractable; the public half is the shared value with the base point. The caller zeroes the seed.
 */
export async function dhPairFromSeed(seed: Uint8Array): Promise<DhPair> {
  if (seed.length !== 32) throw new RangeError('seed');
  const pkcs8 = concat(PKCS8_X25519, seed);
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, false, [
      'deriveBits',
    ]);
    return { privateKey, pub: await dhRaw(privateKey, BASE_POINT) };
  } finally {
    zeroize(pkcs8);
  }
}

/** A shared secret that is all zeros (a small-order public key): refused, RFC 9180 7.1.4. */
export class WeakKeyError extends Error {
  constructor() {
    super('weak public key');
  }
}

/** The X25519 shared secret, refused when it is all zeros (WebCrypto implementations differ on that). */
export async function dh(privateKey: CryptoKey, pub: Uint8Array): Promise<Bytes> {
  if (privateKey.algorithm.name !== 'X25519') throw new TypeError('not an X25519 key');
  const publicKey = await dhPublicKey(pub);
  let shared: Bytes;
  try {
    shared = await x25519Bits(privateKey, publicKey);
  } catch (e) {
    // Some engines refuse a small-order public key with OperationError; others return zeros, caught below.
    if (e instanceof Error && e.name === 'OperationError') throw new WeakKeyError();
    throw e;
  }
  if (equal(shared, bytes(32))) throw new WeakKeyError();
  return shared;
}
