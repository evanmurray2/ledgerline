// What the Worker makes with its own secret (docs/privacy-keys.md 9.1 and 9.2): an HMAC key and a run-signing pair,
// both derived from the 32 bytes of the keyring entry that already encrypts bank tokens, under labels of their own.
// The HMACs stop someone who can write to the database, but holds no Worker secret, from inventing a key, a bank
// link or a run state.
import { type Bytes, concat, isUlid, label, str, u16, u32, u64, u8, zeroize } from './bytes.js';
import { type SignPair, signPairFromSeed } from './curve.js';
import { hkdf, hmac, hmacKey, hmacVerify } from './hash.js';

export interface ServerKeys {
  /** The keyring's key number. */
  n: number;
  /** HMAC key. Non-extractable. */
  mac: CryptoKey;
  /** Signs bank run manifests. The app is built with the public halves it accepts, by `n`. */
  runSign: SignPair;
}

const SALT = label('ledgerline/v1/server');

/**
 * The Worker's keys for keyring entry `n`. `secret` is exactly the 32 bytes that entry gives the token cipher
 * (`tokenKeyBytes` in packages/platform): the decoded bytes of a base64 key, or the SHA-256 of a passphrase.
 */
export async function serverKeys(secret: Uint8Array, n: number): Promise<ServerKeys> {
  if (secret.length !== 32) throw new RangeError('secret');
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new RangeError('key number');
  const macRaw = await hkdf(secret, SALT, label('ledgerline/v1/server/mac'), 32);
  try {
    const seed = await hkdf(secret, SALT, label('ledgerline/v1/server/run-sign'), 32);
    try {
      return { n, mac: await hmacKey(macRaw), runSign: await signPairFromSeed(seed) };
    } finally {
      zeroize(seed);
    }
  } finally {
    zeroize(macRaw);
  }
}

const ulid = (id: string, what: string): string => {
  if (!isUlid(id)) throw new RangeError(what);
  return id;
};
const version = (v: number): number => {
  if (!Number.isInteger(v) || v < 1 || v > 0xffffffff) throw new RangeError('version');
  return v;
};

export const KEY_KIND = { sign: 1, inbox: 2 } as const;
export type KeyKind = (typeof KEY_KIND)[keyof typeof KEY_KIND];

function keyMacInput(budgetId: string, v: number, kind: KeyKind, pub: Uint8Array): Bytes {
  if (kind !== 1 && kind !== 2) throw new RangeError('key kind');
  if (pub.length !== 32) throw new RangeError('public key');
  return concat(
    label('ledgerline/v1/mac/key'),
    str(ulid(budgetId, 'budget id')),
    u32(version(v)),
    u8(kind),
    pub,
  );
}

/** The Worker's stamp on a signing or inbox public key it accepted from a holder of the budget key. */
export async function keyMac(
  k: ServerKeys,
  budgetId: string,
  v: number,
  kind: KeyKind,
  pub: Uint8Array,
): Promise<Bytes> {
  return hmac(k.mac, keyMacInput(budgetId, v, kind, pub));
}

export async function checkKeyMac(
  k: ServerKeys,
  budgetId: string,
  v: number,
  kind: KeyKind,
  pub: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  return mac.length === 32 && hmacVerify(k.mac, keyMacInput(budgetId, v, kind, pub), mac);
}

export const MAX_ITEM_ID = 255;
export const MAX_TOKEN_CIPHERTEXT = 4096;

function linkMacInput(budgetId: string, linkId: string, itemId: string, tokenCiphertext: Uint8Array): Bytes {
  const item = new TextEncoder().encode(itemId);
  if (item.length < 1 || item.length > MAX_ITEM_ID) throw new RangeError('item id');
  if (tokenCiphertext.length < 1 || tokenCiphertext.length > MAX_TOKEN_CIPHERTEXT)
    throw new RangeError('token');
  return concat(
    label('ledgerline/v1/mac/link'),
    str(ulid(budgetId, 'budget id')),
    str(ulid(linkId, 'link id')),
    str(item),
    str(tokenCiphertext),
  );
}

/** The Worker's stamp on a bank link: it can't be invented, or moved to another budget. */
export async function linkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
): Promise<Bytes> {
  return hmac(k.mac, linkMacInput(budgetId, linkId, itemId, tokenCiphertext));
}

export async function checkLinkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  return mac.length === 32 && hmacVerify(k.mac, linkMacInput(budgetId, linkId, itemId, tokenCiphertext), mac);
}

/** A budget's whole run state: what `runsMac` covers at once, so no part can be moved back without the rest. */
export interface RunState {
  /** The budget's last completed run number; 0 before any. */
  run: number;
  /** H(manifest) of that run; zeros before any. */
  lastManifestHash: Uint8Array;
  /** The time of that run; 0 before any. */
  lastRunTime: number;
  /** Every link's cursor, as H(cursor). */
  links: { linkId: string; cursorHash: Uint8Array }[];
}

export const MAX_LINKS = 4096;

function runsMacInput(budgetId: string, s: RunState): Bytes {
  if (s.lastManifestHash.length !== 32) throw new RangeError('manifest hash');
  if (s.links.length > MAX_LINKS) throw new RangeError('link count');
  // The links are written in ascending order of id, whatever order they were given in, so the stamp is one value.
  const links = [...s.links].sort((a, b) => (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
  for (let i = 0; i < links.length; i++) {
    ulid(links[i]!.linkId, 'link id');
    if (links[i]!.cursorHash.length !== 32) throw new RangeError('cursor hash');
    if (i > 0 && links[i - 1]!.linkId === links[i]!.linkId) throw new RangeError('link twice');
  }
  return concat(
    label('ledgerline/v1/mac/runs'),
    str(ulid(budgetId, 'budget id')),
    u64(s.run),
    s.lastManifestHash,
    u64(s.lastRunTime),
    u16(links.length),
    ...links.map((l) => concat(str(l.linkId), l.cursorHash)),
  );
}

/** The Worker's stamp on a budget's run state, written in the transaction that completes a run. */
export async function runsMac(k: ServerKeys, budgetId: string, s: RunState): Promise<Bytes> {
  return hmac(k.mac, runsMacInput(budgetId, s));
}

export async function checkRunsMac(
  k: ServerKeys,
  budgetId: string,
  s: RunState,
  mac: Uint8Array,
): Promise<boolean> {
  return mac.length === 32 && hmacVerify(k.mac, runsMacInput(budgetId, s), mac);
}
