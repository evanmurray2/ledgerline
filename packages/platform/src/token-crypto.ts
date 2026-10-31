/**
 * AES-256-GCM encryption for provider access tokens. The key-encryption key is a Worker secret (base64, 32 bytes);
 * the key version is stored with each row so keys can be rotated.
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

async function importKey(secretB64: string): Promise<CryptoKey> {
  const raw = unb64(secretB64);
  if (raw.length !== 32) throw new Error('token key must be 32 bytes');
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

/** Parses TOKEN_KEYS="1:base64,2:base64" and TOKEN_KEY_CURRENT="2". */
export function parseKeyring(keys: string | undefined, current: string | undefined): TokenKeyring {
  const ring: TokenKeyring = { current: Number(current ?? 1), keys: {} };
  for (const part of (keys ?? '').split(',')) {
    const [v, k] = part.split(':');
    if (v && k) ring.keys[Number(v)] = k.trim();
  }
  return ring;
}
