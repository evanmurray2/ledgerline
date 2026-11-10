// HPKE base mode, single-shot (RFC 9180), for the one suite the key formats use (docs/privacy-keys.md section 3):
//   KEM  DHKEM(X25519, HKDF-SHA256)  0x0020
//   KDF  HKDF-SHA256                 0x0001
//   AEAD AES-256-GCM                 0x0002
// A sealed value is enc(32) || ciphertext || tag(16). HPKE proves nothing about who sealed: where that matters,
// something else does (a slot's anchor and the public chain, or the Worker's signature).
// test/hpke.test.ts checks this against the CFRG's published test vector for exactly this suite.
import { type Bytes, bytes, concat, randomBytes, u16, utf8, zeroize } from './bytes.js';
import { dh, dhPairFromSeed, type DhPair } from './curve.js';
import { hkdfExpand, hkdfExtract } from './hash.js';
import { OpenError, TAG_LEN } from './aead.js';

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const N_SECRET = 32;
const N_ENC = 32;
const N_KEY = 32;
const N_NONCE = 12;

const VERSION = utf8('HPKE-v1');
const KEM_SUITE = concat(utf8('KEM'), u16(KEM_ID));
const HPKE_SUITE = concat(utf8('HPKE'), u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID));
const EMPTY = bytes(0);

function labeledExtract(suite: Bytes, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
  return hkdfExtract(salt, concat(VERSION, suite, utf8(label), ikm));
}

function labeledExpand(
  suite: Bytes,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  n: number,
): Promise<Bytes> {
  return hkdfExpand(prk, concat(u16(n), VERSION, suite, utf8(label), info), n);
}

/** DeriveKeyPair for X25519 (RFC 9180 7.1.3): the test vectors give key material, not keys. */
export async function deriveKeyPair(ikm: Uint8Array): Promise<DhPair> {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'dkp_prk', ikm);
  const sk = await labeledExpand(KEM_SUITE, prk, 'sk', EMPTY, 32);
  try {
    return await dhPairFromSeed(sk);
  } finally {
    zeroize(prk, sk);
  }
}

async function sharedSecret(dhValue: Bytes, enc: Uint8Array, pkR: Uint8Array): Promise<Bytes> {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dhValue);
  try {
    return await labeledExpand(KEM_SUITE, prk, 'shared_secret', concat(enc, pkR), N_SECRET);
  } finally {
    zeroize(prk, dhValue);
  }
}

/** The key schedule for mode 0 (base): no pre-shared key. Gives the AEAD key and the nonce of the first seal. */
async function keySchedule(shared: Bytes, info: Uint8Array): Promise<{ key: CryptoKey; nonce: Bytes }> {
  let secret: Bytes = bytes(0);
  let rawKey: Bytes = bytes(0);
  try {
    const pskIdHash = await labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
    const infoHash = await labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
    const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
    secret = await labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY);
    rawKey = await labeledExpand(HPKE_SUITE, secret, 'key', context, N_KEY);
    const nonce = await labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_NONCE);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, nonce };
  } finally {
    zeroize(shared, secret, rawKey);
  }
}

/** One-time pairs that have sealed: a second seal with one would reuse its AES-GCM key and nonce. */
const used = new WeakSet<DhPair>();

/**
 * Seals with a given one-time pair, once: a second call with the same pair throws. Only the test vectors pass a fixed
 * pair; `seal` makes a fresh one.
 */
export async function sealWith(
  eph: DhPair,
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plain: Uint8Array,
): Promise<Bytes> {
  if (pkR.length !== 32) throw new RangeError('public key');
  if (used.has(eph)) throw new Error('a one-time key pair seals once');
  used.add(eph);
  const shared = await sharedSecret(await dh(eph.privateKey, pkR), eph.pub, pkR);
  const { key, nonce } = await keySchedule(shared, info);
  // One sender context makes exactly one seal, so the first nonce is the only one ever used with this key.
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad as Bytes, tagLength: 128 },
      key,
      plain as Bytes,
    ),
  );
  return concat(eph.pub, ct);
}

/** Seal(pkR, info, aad, plain): enc(32) || ciphertext || tag(16), with a fresh one-time key pair. */
export async function seal(
  pkR: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plain: Uint8Array,
): Promise<Bytes> {
  const seed = randomBytes(32);
  try {
    return await sealWith(await dhPairFromSeed(seed), pkR, info, aad, plain);
  } finally {
    zeroize(seed);
  }
}

/** Open(skR, info, aad, sealed). Throws OpenError when the key is wrong or anything was changed. */
export async function open(
  recipient: DhPair,
  info: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
): Promise<Bytes> {
  if (sealed.length < N_ENC + TAG_LEN) throw new OpenError();
  const enc = sealed.slice(0, N_ENC) as Bytes;
  try {
    const shared = await sharedSecret(await dh(recipient.privateKey, enc), enc, recipient.pub);
    const { key, nonce } = await keySchedule(shared, info);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad as Bytes, tagLength: 128 },
        key,
        sealed.slice(N_ENC) as Bytes,
      ),
    );
  } catch {
    throw new OpenError();
  }
}

/** The sealed length for a plain text of `n` bytes. */
export const sealedLength = (n: number): number => N_ENC + n + TAG_LEN;
