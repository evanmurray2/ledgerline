// Ed25519 and X25519 key pairs from 32-byte seeds (docs/privacy-keys.md section 2). WebCrypto can't derive these key
// types and can't give the public half of a private key it won't export, so a seed is wrapped as PKCS#8 by a fixed
// prefix and the public half is worked out here.
import { type Bytes, bytes, concat, equal, fromB64url, fromHex, zeroize } from './bytes.js';

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
    const jwk = await crypto.subtle.exportKey('jwk', open);
    if (typeof jwk.x !== 'string') throw new Error('no public half');
    const pub = fromB64url(jwk.x);
    jwk.d = '';
    if (pub.length !== 32) throw new Error('public half');
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    return { privateKey, publicKey: await signPublicKey(pub), pub };
  } finally {
    zeroize(pkcs8);
  }
}

export function signPublicKey(pub: Uint8Array): Promise<CryptoKey> {
  if (pub.length !== 32) throw new RangeError('public key');
  return crypto.subtle.importKey('raw', pub as Bytes, { name: 'Ed25519' }, true, ['verify']);
}

export async function sign(privateKey: CryptoKey, message: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, message as Bytes));
}

export async function verify(
  pub: Uint8Array | CryptoKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== 64) return false;
  const key = pub instanceof Uint8Array ? await signPublicKey(pub) : pub;
  return crypto.subtle.verify('Ed25519', key, signature as Bytes, message as Bytes);
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

async function dhRaw(privateKey: CryptoKey, pub: Uint8Array): Promise<Bytes> {
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: await dhPublicKey(pub) }, privateKey, 256),
  );
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
  let shared: Bytes;
  try {
    shared = await dhRaw(privateKey, pub);
  } catch {
    throw new WeakKeyError();
  }
  if (equal(shared, bytes(32))) throw new WeakKeyError();
  return shared;
}
