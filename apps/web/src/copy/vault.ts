// The encrypted copy on the phone (docs/phone-budget.md section 13, decisions.md D-45).
//
// Keys:
// - The passkey's PRF output (WebAuthn `prf` extension, salt kept on the device) is a secret only that passkey can
//   produce. It never leaves the phone and is never stored.
// - The server holds a share for each device; it hands it out only after a sign-in and only until the device is
//   signed out (Settings → Sign-in).
// - HKDF(PRF output ‖ share) gives the key-encryption key, which unwraps the random data key. The data key encrypts
//   the copy (AES-GCM, a fresh random IV every time, bound to this device by associated data).
// - For opening with no signal, the share is also kept wrapped under a key from the PRF output alone, with the last
//   server time; that's refused 7 days after it.
// All keys are non-extractable CryptoKeys held in memory and dropped by the idle sign-out. While the copy is open,
// the data key is also held in IndexedDB so a refresh doesn't ask for Face ID (holdKey); signing out deletes it.

const DB_NAME = 'ledgerline-copy';
const STORE = 'copies';
/** An IndexedDB read or write failed with no error of its own. */
const STORAGE_FAILED = 'This device couldn’t read its saved budget. Try again.';
export const OFFLINE_DAYS = 7;
const enc = new TextEncoder();

export interface Wrapped {
  iv: ArrayBuffer;
  data: ArrayBuffer;
}

export interface CopyRecord {
  /** `${email}:${budgetId}`: another person signing in on this device never sees this record. */
  key: string;
  who: { budgetId: string; userId: string; email: string };
  deviceId: string;
  salt: ArrayBuffer;
  /** The data key, wrapped once per passkey that has opened this copy. */
  keys: { credentialId: string; wrapped: Wrapped }[];
  /** The server's share, wrapped under the PRF output alone, per passkey (opening with no signal). */
  shares: { credentialId: string; wrapped: Wrapped }[];
  /** Server time of the last confirmed sign-in (ms). */
  lastServerTime: number;
  /** The passkey that set this copy up: opening it asks for it alone. */
  credentialIdHint?: string | null;
  blob: Wrapped | null;
  savedAt: number;
}

// ---------------------------------------------------------------- IndexedDB

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error(STORAGE_FAILED));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error ?? new Error(STORAGE_FAILED));
      t.onabort = () => reject(t.error ?? new Error(STORAGE_FAILED));
    });
  } finally {
    db.close();
  }
}

export const recordKey = (email: string, budgetId: string) => `${email}:${budgetId}`;

/** IndexedDB couldn't be read (not "no copy"): the saved copy may well be there, so nothing may replace it. */
export class StorageUnavailable extends Error {
  constructor() {
    super('storage_unavailable');
  }
}

/**
 * This person's saved copy, or null when there is none. iOS sometimes fails an IndexedDB open or read for a moment
 * (after the app comes back from the background): that's tried again, and if it still fails it throws
 * StorageUnavailable instead of answering "no copy", which would set up a new copy over the saved one.
 */
export async function loadRecord(key: string, waits = [100, 400]): Promise<CopyRecord | null> {
  if (typeof indexedDB === 'undefined') return null;
  for (let i = 0; ; i++) {
    try {
      return ((await tx('readonly', (s) => s.get(key))) as CopyRecord | undefined) ?? null;
    } catch {
      if (i >= waits.length) throw new StorageUnavailable();
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/** Every copy on this device. */
export async function allRecords(): Promise<CopyRecord[]> {
  if (typeof indexedDB === 'undefined') return [];
  return ((await tx('readonly', (s) => s.getAll()).catch(() => [])) as CopyRecord[]) ?? [];
}

/** The record last used on this device (for opening with no signal, before anyone has signed in). */
export async function lastRecord(): Promise<CopyRecord | null> {
  if (typeof indexedDB === 'undefined') return null;
  const all = await allRecords();
  return all.sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
}

export async function saveRecord(r: CopyRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(r));
}

export async function deleteRecord(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await tx('readwrite', (s) => s.delete(key)).catch(() => undefined);
}

/** Every copy on this device (sign-out), and any key held for a refresh. */
export async function deleteAll(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  for (const name of [DB_NAME, HELD_DB])
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
}

// ---------------------------------------------------------------- an open copy that survives a refresh

// While the copy is open, its data key (a non-extractable CryptoKey: the browser stores it but never hands out its
// bytes) is kept here with the time of the last activity, so reloading the page or the phone restarting the app
// doesn't ask for Face ID again. It's only used within IDLE_MS of that time, and signing out deletes it. (The
// database keeps its old name so keys already held still work.)
const HELD_DB = 'ledgerline-unlock';
const HELD = 'held';

interface Held {
  key: string;
  dataKey: CryptoKey;
  lastActive: number;
}

async function held<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(HELD_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(HELD, { keyPath: 'key' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error(STORAGE_FAILED));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(HELD, mode);
      const r = fn(t.objectStore(HELD));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error ?? new Error(STORAGE_FAILED));
      t.onabort = () => reject(t.error ?? new Error(STORAGE_FAILED));
    });
  } finally {
    db.close();
  }
}

export async function holdKey(key: string, dataKey: CryptoKey, lastActive: number): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await held('readwrite', (s) => s.put({ key, dataKey, lastActive } satisfies Held)).catch(() => undefined);
}

/** The held data key, when the last activity was less than `maxAge` ago; an older one is deleted. */
export async function heldKey(key: string, maxAge: number, now = Date.now()): Promise<CryptoKey | null> {
  if (typeof indexedDB === 'undefined') return null;
  const h = (await held('readonly', (s) => s.get(key)).catch(() => undefined)) as Held | undefined;
  if (!h) return null;
  if (now < h.lastActive || now - h.lastActive >= maxAge) {
    await dropHeld(key);
    return null;
  }
  return h.dataKey;
}

export async function dropHeld(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await held('readwrite', (s) => s.delete(key)).catch(() => undefined);
}

// ---------------------------------------------------------------- crypto

const buf = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export function randomBytes(n: number): ArrayBuffer {
  return buf(crypto.getRandomValues(new Uint8Array(n)));
}

function concat(...parts: (ArrayBuffer | Uint8Array)[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : new Uint8Array(p), o);
    o += p.byteLength;
  }
  return buf(out);
}

export function fromB64url(s: string): ArrayBuffer {
  const b = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  );
  return buf(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

export function toB64url(b: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A non-extractable AES-GCM key from HKDF-SHA-256 over `secret`. */
async function hkdf(secret: ArrayBuffer, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key: CryptoKey, data: ArrayBuffer, aad: string): Promise<Wrapped> {
  const iv = randomBytes(12);
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    data,
  );
  return { iv, data: out };
}

/** Throws when the key is wrong or anything was changed (AES-GCM checks both). */
export async function open(key: CryptoKey, w: Wrapped, aad: string): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.iv, additionalData: enc.encode(aad) }, key, w.data);
}

/** The copy couldn't be decrypted at `step` (the key from the passkey and share didn't fit, or it changed). */
export class CopyUnreadable extends Error {
  constructor(readonly step: 'share' | 'key' | 'copy') {
    super(`copy_unreadable:${step}`);
  }
}

async function openAt(
  step: CopyUnreadable['step'],
  key: CryptoKey,
  w: Wrapped,
  aad: string,
): Promise<ArrayBuffer> {
  try {
    return await open(key, w, aad);
  } catch {
    throw new CopyUnreadable(step);
  }
}

/** Same salt bytes (the passkey's PRF output depends on it). */
export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
}

const info = (r: Pick<CopyRecord, 'who' | 'deviceId'>, what: string) =>
  `ledgerline-copy-v1|${what}|${r.who.userId}|${r.who.budgetId}|${r.deviceId}`;
const keyAad = (r: Pick<CopyRecord, 'deviceId' | 'salt'>, credentialId: string) =>
  `key|${credentialId}|${toB64url(r.salt)}|${r.deviceId}`;
const shareAad = (r: Pick<CopyRecord, 'deviceId'>, credentialId: string) =>
  `share|${credentialId}|${r.deviceId}`;
export const blobAad = (r: Pick<CopyRecord, 'deviceId'>) => `copy|v1|${r.deviceId}`;

/** The key-encryption key: needs the passkey (PRF output) and the server's share. */
export const kek = (r: Pick<CopyRecord, 'who' | 'deviceId'>, prf: ArrayBuffer, share: ArrayBuffer) =>
  hkdf(concat(prf, share), info(r, 'kek'));
/** Wraps the cached share for opening with no signal: needs the passkey only. */
const offlineKey = (r: Pick<CopyRecord, 'who' | 'deviceId'>, prf: ArrayBuffer) =>
  hkdf(prf, info(r, 'offline'));

async function importDataKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** A new copy's keys: a random data key, wrapped for this passkey and share. */
export async function newKeys(
  r: Omit<CopyRecord, 'keys' | 'shares' | 'blob'>,
  credentialId: string,
  prf: ArrayBuffer,
  share: ArrayBuffer,
): Promise<{ record: CopyRecord; dataKey: CryptoKey }> {
  const raw = randomBytes(32);
  const wrapped = await seal(await kek(r, prf, share), raw, keyAad(r, credentialId));
  const cached = await seal(await offlineKey(r, prf), share, shareAad(r, credentialId));
  const dataKey = await importDataKey(raw);
  new Uint8Array(raw).fill(0);
  return {
    record: {
      ...r,
      keys: [{ credentialId, wrapped }],
      shares: [{ credentialId, wrapped: cached }],
      blob: null,
    },
    dataKey,
  };
}

/** Opens the data key with a passkey's PRF output and the server's share (online). */
export async function openKey(
  r: CopyRecord,
  credentialId: string,
  prf: ArrayBuffer,
  share: ArrayBuffer,
): Promise<{ dataKey: CryptoKey; record: CopyRecord }> {
  const k = r.keys.find((x) => x.credentialId === credentialId);
  if (!k) throw new Error('other_passkey');
  const raw = await openAt('key', await kek(r, prf, share), k.wrapped, keyAad(r, credentialId));
  const dataKey = await importDataKey(raw);
  new Uint8Array(raw).fill(0);
  // Refresh the cached share (it may have been rotated) for opening with no signal.
  const cached = await seal(await offlineKey(r, prf), share, shareAad(r, credentialId));
  const shares = [
    ...r.shares.filter((x) => x.credentialId !== credentialId),
    { credentialId, wrapped: cached },
  ];
  return { dataKey, record: { ...r, shares } };
}

/** Opens the data key with no signal: the cached share, within 7 days of the last confirmed sign-in. */
export async function openKeyOffline(
  r: CopyRecord,
  credentialId: string,
  prf: ArrayBuffer,
  now = Date.now(),
): Promise<CryptoKey> {
  if (now < r.lastServerTime || now - r.lastServerTime > OFFLINE_DAYS * 86_400_000)
    throw new Error('offline_expired');
  const c = r.shares.find((x) => x.credentialId === credentialId);
  const k = r.keys.find((x) => x.credentialId === credentialId);
  if (!c || !k) throw new Error('other_passkey');
  const share = await openAt('share', await offlineKey(r, prf), c.wrapped, shareAad(r, credentialId));
  const raw = await openAt('key', await kek(r, prf, share), k.wrapped, keyAad(r, credentialId));
  const dataKey = await importDataKey(raw);
  new Uint8Array(raw).fill(0);
  return dataKey;
}

export async function sealCopy(r: CopyRecord, dataKey: CryptoKey, bytes: ArrayBuffer): Promise<Wrapped> {
  return seal(dataKey, bytes, blobAad(r));
}

export async function openCopy(r: CopyRecord, dataKey: CryptoKey): Promise<ArrayBuffer | null> {
  return r.blob ? openAt('copy', dataKey, r.blob, blobAad(r)) : null;
}
