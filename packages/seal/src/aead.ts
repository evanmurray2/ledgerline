// AES-256-GCM as the key formats use it (docs/privacy-keys.md section 1): a fresh random 96-bit nonce every time,
// stored as nonce(12) || ciphertext || tag(16).
import { type Bytes, concat, randomBytes } from './bytes.js';

export const NONCE_LEN = 12;
export const TAG_LEN = 16;

/** A sealed value that doesn't open: the wrong key, or something was changed. */
export class OpenError extends Error {
  constructor() {
    super('open failed');
  }
}

export async function aeadKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new RangeError('aead key');
  return crypto.subtle.importKey('raw', raw as Bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function aeadSeal(key: CryptoKey, aad: Uint8Array, plain: Uint8Array): Promise<Bytes> {
  const nonce = randomBytes(NONCE_LEN);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad as Bytes, tagLength: 128 },
      key,
      plain as Bytes,
    ),
  );
  return concat(nonce, ct);
}

export async function aeadOpen(key: CryptoKey, aad: Uint8Array, sealed: Uint8Array): Promise<Bytes> {
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new OpenError();
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: sealed.slice(0, NONCE_LEN) as Bytes,
          additionalData: aad as Bytes,
          tagLength: 128,
        },
        key,
        sealed.slice(NONCE_LEN) as Bytes,
      ),
    );
  } catch {
    throw new OpenError();
  }
}
