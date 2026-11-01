/**
 * AES-256-GCM encryption for provider access tokens. The key-encryption key is a Worker secret: 32 random bytes in
 * base64, or a random passphrase of 32+ characters (for example two iPhone-generated passwords joined), from which
 * the key is its SHA-256. The key version is stored with each row so keys can be rotated.
 */
export interface TokenKeyring {
  current: number;
  keys: Record<number, string>;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;
export const MIN_PASSPHRASE = 32;

async function importKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  if (BASE64_32.test(secret)) raw = unb64(secret);
  else if (secret.length >= MIN_PASSPHRASE)
    // A high-entropy random passphrase, not a memorable one: a fast hash is enough to make it a key.
    raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  else throw new Error('token key must be 32 bytes in base64 or a passphrase of 32+ characters');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(
  ring: TokenKeyring,
  plaintext: string,
  aad: string,
): Promise<{ enc: string; keyVersion: number }> {
  const secret = ring.keys[ring.current];
  if (!secret) throw new Error('missing current token key');
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return { enc: b64(out), keyVersion: ring.current };
}

export async function decryptToken(
  ring: TokenKeyring,
  enc: string,
  keyVersion: number,
  aad: string,
): Promise<string> {
  const secret = ring.keys[keyVersion];
  if (!secret) throw new Error(`missing token key version ${keyVersion}`);
  const key = await importKey(secret);
  const all = unb64(enc);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: all.slice(0, 12), additionalData: new TextEncoder().encode(aad) },
    key,
    all.slice(12),
  );
  return new TextDecoder().decode(pt);
}

/**
 * Parses TOKEN_KEYS="1:key,2:key" and TOKEN_KEY_CURRENT="2". A value without a "1:" prefix is key version 1, so
 * TOKEN_KEYS can be just one passphrase.
 */
export function parseKeyring(keys: string | undefined, current: string | undefined): TokenKeyring {
  const ring: TokenKeyring = { current: Number(current || 1), keys: {} };
  const s = (keys ?? '').trim();
  if (s && !/^\d+:/.test(s)) {
    ring.keys[1] = s;
    return ring;
  }
  for (const part of s.split(',')) {
    const i = part.indexOf(':');
    if (i > 0 && part.slice(i + 1).trim()) ring.keys[Number(part.slice(0, i))] = part.slice(i + 1).trim();
  }
  return ring;
}
