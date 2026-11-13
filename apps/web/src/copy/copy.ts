// The budget's copy on this device (docs/phone-budget.md, decisions.md D-45): every screen is worked out from it by
// the engine in a Web Worker. Every budget is locked (D-102): the copy lives on the budget's sealed log, every change
// is made here and goes out as an entry, and the server can't read it. On any device whose passkey supports PRF
// (D-53), the copy is saved encrypted (vault.ts), reopens reading only the entries since, and opens with no signal;
// without PRF it's kept in memory for the visit only.
//
// Idle sign-out (D-57): after 10 idle minutes, or 10 minutes in the background, the keys, the copy in memory and the
// server session are dropped and the app shows Sign in; that one Face ID also opens the saved copy. A refresh or the
// app restarting within 10 minutes of the last activity reopens it with the data key held in IndexedDB (vault.ts
// holdKey). Wipe: signing out, here or from another device (Settings → Sign-in), no longer a member, or 7 days
// offline.
import { useSyncExternalStore } from 'react';
import {
  CSRF_HEADER,
  SEALED_HEADER,
  SIGNED_CHALLENGE_HEADER,
  SIGNED_SIGNATURE_HEADER,
  type SealedSession,
  type Session,
} from '@ledgerline/contracts';
import {
  KEY_TYPO,
  NoSlotError,
  type OpenBudget,
  openWithPasskey,
  openWithRecoveryKey,
  type PasskeySecret,
  slotPrfInput,
  WayInError,
} from '../keys/budget';
import {
  dropNewBudget,
  newBudget,
  proveNewBudget,
  recoveryKeyOpens,
  type NewBudget,
} from '../keys/new-budget';
import { WORKER_RUN_KEYS } from '../keys/worker-keys';
import { fetchPublicEntries, logDeviceId, newUlid, openSealedBudget, openSealedHeld } from './sealed';
import { keepPublicSeen, lastPublicSeen, PUBLIC_MARK } from './public-marks';
import { addPasskeyWay, authPubOf, openPlans, type Ways } from './sealed-ways';
import { ACTION, type Entry, type PublicState, walkPublic, zeroize } from '@ledgerline/seal';
import { mergedSession, NOT_LOCKED } from './sealed-session';
import { ownWriters } from './notices';
import { connectivity } from '../state/connectivity';
import { EngineHost, type EngineIdentity, type QueuedEdit, type SealedKeys } from './host';
import { usage } from '../usage/tracker';
import { isServerRead } from './server-reads';
import { shownFields } from './shown';
import { assert, canUsePasskeys, keepsCopy, type RequestOptionsJSON } from './passkey';
import {
  type CopyRecord,
  allRecords,
  deleteAll,
  deleteRecord,
  dropHeld,
  heldKey,
  heldSealed,
  holdKey,
  fromB64url,
  toB64url,
  lastRecord,
  loadRecord,
  newKeys,
  openCopy,
  randomBytes,
  recordKey,
  saveRecord,
  sealCopy,
  openKey,
  openKeyOffline,
  CopyUnreadable,
  StorageUnavailable,
  sameBytes,
} from './vault';

export const IDLE_MS = 10 * 60_000;
const SYNC_EVERY_MS = 2 * 60_000;
/** A sync that brings nothing still saves the copy this often, to keep the offline limit's server time fresh. */
const KEEP_ALIVE_MS = 60 * 60_000;

export type CopyStatus =
  | 'off' // the mock API (development and tests)
  | 'idle' // nobody signed in yet
  | 'signed_out' // a saved copy waits: Sign in opens it online, or Face ID with no signal
  | 'opening'
  | 'ready'
  | 'fresh' // a new budget with no first entry yet: this device makes it (lockStart, lockFinish)
  | 'failed';

export interface CopyState {
  status: CopyStatus;
  /** Saved encrypted on this device (vs. memory only). */
  saved: boolean;
  /** Opened with no signal: view and the offline edits only. */
  offline: boolean;
  /** Downloading: rows so far. */
  progress: number;
  /** Why everything is being downloaded, not just what changed (null: only changes). */
  why: FullWhy | null;
  error: string | null;
  /** Changes made offline not yet on the server. */
  queued: number;
  /** A saved copy exists for someone on this device (offline opening is possible). */
  hasSaved: boolean;
  /**
   * The budget is locked and the passkey just used is no way in to it (a new passkey, after a recovery): the
   * recovery key opens it (`openWithRecovery`).
   */
  needsRecovery?: boolean;
  /** The copy is being made again from the budget's newest snapshot (a sealed budget): "Bringing your budget up to date". */
  rebuilding?: boolean;
  /**
   * The server showed this device a history that is not the one it saw (docs/privacy.md 5.3, a fork or a rollback).
   * The device stops; nothing was changed.
   */
  forked?: boolean;
}

const MOCK = import.meta.env.VITE_MOCK === '1';

let state: CopyState = {
  status: MOCK ? 'off' : 'idle',
  saved: false,
  offline: false,
  progress: 0,
  why: null,
  error: null,
  queued: 0,
  hasSaved: false,
};

/** Why a sync starts from nothing; sent with the first request (`why`) and shown while it downloads. */
export type FullWhy =
  | 'memory' // this browser can't save anything (no IndexedDB)
  | 'first' // no saved copy on this phone yet
  | 'no_prf' // the passkey gave no key, so nothing can be saved
  | 'turned_off' // signed out from another device
  | 'unreadable_share'
  | 'unreadable_key'
  | 'unreadable_copy'
  | 'empty' // a saved copy with nothing in it
  | 'storage' // the saved copy couldn't be read from this device's storage (it's kept for the next time)
  | 'reset'; // the server's copy was restored, or a change made offline was refused
const listeners = new Set<() => void>();
function set(patch: Partial<CopyState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Screens refetch when the copy changes (the router subscribes and invalidates queries). */
const changeListeners = new Set<() => void>();
export function onCopyChanged(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
const changed = () => {
  for (const l of changeListeners) l();
};

let host: EngineHost | null = null;
let record: CopyRecord | null = null;
let dataKey: CryptoKey | null = null;
let who: EngineIdentity | null = null;
/** Copies deleted because they were signed out from another device, so the download that follows says so. */
const turnedOff = new Set<string>();

/** A sign-in that just produced a PRF output, for start() to use without asking for Face ID again. */
let pending: {
  credentialId: string;
  prf: ArrayBuffer | null;
  salt: ArrayBuffer;
  /** The passkey's secret for a sealed budget's way in, when the sign-in asked for it. */
  slotPrf: ArrayBuffer | null;
} | null = null;

// ---------------------------------------------------------------- a sealed budget (docs/privacy.md 5.3)

/** What the server said about a signed-in person whose budget is sealed; null for a budget that is not. */
let sealed: SealedSession | null = null;
/** The budget lives in its sealed log: the copy syncs with the log, and every change is made on the device. */
export const isSealed = (): boolean => sealed !== null;
/**
 * The server says the budget is sealed. It is remembered on this device from then on: the next sign-in asks the
 * passkey for the budget's secret in the same prompt, and an answer that says the budget is not sealed is
 * refused (sealed-session.ts). Nothing the server says later takes this back.
 */
export function noteSealed(s: SealedSession): void {
  sealed = s;
  // A new budget is remembered once this device has locked it (startBudget below), not before.
  if (!s.fresh) rememberSealed(s.budgetId);
}
/** The budgets this device knows as sealed (their ids, no more), kept outside the copy so a wipe leaves them. */
const sealedBudgets = (): string[] => {
  try {
    return (localStorage.getItem(SEALED_FLAG) ?? '').split(',').filter(Boolean);
  } catch {
    return [];
  }
};
function rememberSealed(budgetId: string): void {
  try {
    const all = sealedBudgets();
    if (!all.includes(budgetId)) localStorage.setItem(SEALED_FLAG, [...all, budgetId].join(','));
  } catch {
    // No storage: the device knows it only while the app is open.
  }
}
/** Only the person's own act on this device forgets it: signing out here. */
function forgetSealed(budgetId: string | null): void {
  try {
    const rest = budgetId ? sealedBudgets().filter((b) => b !== budgetId) : [];
    if (rest.length) localStorage.setItem(SEALED_FLAG, rest.join(','));
    else localStorage.removeItem(SEALED_FLAG);
    if (budgetId) localStorage.removeItem(PUBLIC_MARK + budgetId);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
/** This device knows the budget as sealed. */
export const sealedKnown = (budgetId: string): boolean =>
  sealed?.budgetId === budgetId || sealedBudgets().includes(budgetId);

export const sealedSession = (): SealedSession | null => sealed;
/** The copy is open and can answer for the budget. */
export const copyReady = (): boolean => state.status === 'ready' && host !== null;
/** Keeps the session with the copy, for a start with no signal. */
export async function keepSession(s: Session): Promise<void> {
  if (!host) return;
  const text = JSON.stringify(s);
  if ((await host.get('session')) === text) return;
  await host.put('session', text);
  // Saved when it changed, so that a start with no signal finds it.
  if (record) await save().catch(() => undefined);
}
const SEALED_FLAG = 'ledgerline.sealed';
/** Shown, with the button that tries again, when a sealed budget needs the passkey once more. */
export const NEEDS_PASSKEY = 'Your passkey is needed once more to open your budget. Try again.';

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** The recovery key as typed, held only until the next open uses it (`openWithRecovery`, a recovery sign-in). */
let recoveryTyped: string | null = null;
/** The passkey that was no way in, kept for the open with the recovery key that follows (it becomes one). */
let noSlotWay: { credentialId: string; slotPrf: ArrayBuffer } | null = null;
/** The budget key another device sealed to this one (copy/device-add.ts), held only until the next open uses it. */
let addedKey: Uint8Array | null = null;
/** The derived keys the engine holds now, for the keys held for a refresh once a key change adds a version. */
let keysInEngine: unknown[] | null = null;

/** The next open of a locked budget uses this recovery key if the passkey can't open it (a recovery sign-in). */
export function holdRecoveryKey(typed: string): void {
  recoveryTyped = typed;
}

/**
 * Opens the locked budget with the recovery key, when the passkey just used is no way in to it. The passkey is
 * then added as a way in, so it alone opens the budget the next time.
 */
export async function openWithRecovery(typed: string, session: Session): Promise<void> {
  recoveryTyped = typed;
  await start(session);
  if (state.status === 'failed') throw new Error(state.error ?? NOT_NOW);
}

/**
 * Opens the locked budget with its key, sealed to this device by a device that holds it (docs/privacy-keys.md
 * section 10), when the passkey just used is no way in to it. The passkey is then added as a way in, as after the
 * recovery key. The key is zeroed once used.
 */
export async function openWithAddedKey(bk: Uint8Array, session: Session): Promise<void> {
  addedKey = bk;
  try {
    await start(session);
  } finally {
    // Zeroed whether the open used it or not.
    zeroize(bk as never);
    addedKey = null;
  }
  if (state.status === 'failed') throw new Error(state.error ?? NOT_NOW);
}

/** The engine, the server and the budget's id, for a change to the ways in (copy/sealed-ways.ts). */
function waysOf(h: EngineHost, budgetId: string): Ways {
  return {
    host: h,
    budgetId,
    fetch: (path: string) =>
      fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
  };
}

/**
 * Opens the sealed budget in the engine: with the passkey's secret from the sign-in just made, or with the keys
 * held since (a refresh). The engine then knows its place in the log, or starts from a snapshot.
 */
async function enterSealed(
  way: { credentialId: string; slotPrf: ArrayBuffer | null } | null,
  heldKeys: unknown[] | null,
  online = true,
): Promise<void> {
  const h = host!;
  const deviceId = await logDeviceId(h);
  let keys: unknown[];
  // A refresh with the keys held: the public entries are read again on the way, as with the passkey. Keys that
  // a key change on another device has replaced open nothing, and the passkey is asked below.
  const lastHeld = !way?.slotPrf && heldKeys ? await lastPublicSeen(h, who!.budgetId) : null;
  const held =
    !way?.slotPrf && heldKeys
      ? await openSealedHeld({
          host: h,
          ...(online
            ? {
                fetch: (path: string) =>
                  fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
              }
            : {}),
          budgetId: who!.budgetId,
          deviceId,
          keys: heldKeys as never,
          workerKeys: WORKER_RUN_KEYS,
          ...(lastHeld ? { remembered: { number: lastHeld.number, hash: fromHex(lastHeld.hash) } } : {}),
        })
      : null;
  if (held) {
    if (held.publics && held.lastPublic) {
      await keepPublicSeen(h, who!.budgetId, {
        number: held.lastPublic.number,
        hash: toHex(held.lastPublic.hash),
      });
      await h.put('publics', JSON.stringify(held.publics));
    }
    keys = held.keys;
  } else {
    // No secret from the sign-in (this device opens a sealed budget for the first time, or the keys held are too
    // old): the passkey is asked once more, for the budget's secret alone. Nothing of this goes to the server.
    const w = way?.slotPrf ? way : (noSlotWay ?? (await askSlot()));
    const last = await lastPublicSeen(h, who!.budgetId);
    const publics = await h.get('publics');
    const passkey: PasskeySecret = {
      credentialId: new Uint8Array(fromB64url(w.credentialId)),
      prf: new Uint8Array(w.slotPrf!),
    };
    const typed = online ? recoveryTyped : null;
    recoveryTyped = null;
    const added = online ? addedKey : null;
    addedKey = null;
    let r: Awaited<ReturnType<typeof openSealedBudget>>;
    try {
      r = await openSealedBudget({
        host: h,
        ...(online
          ? {
              fetch: (path: string) =>
                fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }),
            }
          : {}),
        ...(publics ? { kept: JSON.parse(publics) as string[] } : {}),
        budgetId: who!.budgetId,
        deviceId,
        passkey,
        workerKeys: WORKER_RUN_KEYS,
        ...(last ? { remembered: { number: last.number, hash: fromHex(last.hash) } } : {}),
        ...(typed || added
          ? {
              ...(added ? { added: added as never } : { recovery: typed! }),
              // The passkey becomes a way in, so it alone opens the budget the next time. A slot change is never
              // held back; if it doesn't go through now, the recovery key is asked again the next time.
              onRecovered: async (budget: OpenBudget) => {
                const added = await addPasskeyWay(waysOf(h, who!.budgetId), budget, passkey).catch(
                  (e: unknown) => ({ ok: false as const, why: String(e) }),
                );
                if (!added.ok)
                  console.warn(JSON.stringify({ event: 'passkey_way_not_added', why: added.why }));
              },
            }
          : {}),
      });
    } catch (e) {
      // No way in for this passkey: the recovery key opens the budget (Copy.tsx asks for it). A typing mistake
      // in the key keeps the question open.
      if (e instanceof NoSlotError || ((typed || added) && e instanceof WayInError)) {
        noSlotWay = { credentialId: w.credentialId, slotPrf: w.slotPrf! };
        set({ needsRecovery: true });
      }
      throw e;
    }
    noSlotWay = null;
    if (state.needsRecovery) set({ needsRecovery: false });
    await keepPublicSeen(h, who!.budgetId, { number: r.lastPublic.number, hash: toHex(r.lastPublic.hash) });
    await h.put('publics', JSON.stringify(r.publics));
    keys = r.keys;
  }
  keysInEngine = keys;
  if (sealed) await h.put('sealed_session', JSON.stringify(sealed));
  if (record && dataKey) await holdKey(record.key, dataKey, Date.now(), keys);
  // Saved now: the place in the log, the writer's id and the marks above must outlive a closed app, or the next
  // start would join again as a new writer.
  if (record && online) {
    record = { ...record, sealed: true };
    await save();
  }
}

/** The engine's message when the server showed another history (local/device-log.ts LogFork). */
const FORK_TEXT = /showed this device a different history/;
/** What the person reads then (docs/copy.md). */
export const FORK_MESSAGE = 'The server showed this device a different history. Nothing was changed.';

/** The engine's message for a log request refused because the sign-in ended (local/http-transport.ts). */
const SIGNED_OUT_TEXT = 'Your sign-in ended. Sign in again.';
/** How often a device looks whether a snapshot is due (docs/privacy.md 5.3: "this runs rarely"). */
const UPKEEP_EVERY_MS = 6 * 60 * 60_000;
const UPKEEP_AT = 'ledgerline.upkeep-at';
let upkeeping = false;
/**
 * After a sealed sync, at most every 6 hours, while the app is in view: the engine writes a snapshot or checks
 * the newest one if either is due. In the background; a failure waits for the next time.
 */
function upkeep(): void {
  if (upkeeping || !host || !sealed || document.visibilityState !== 'visible') return;
  let last = 0;
  try {
    last = Number(localStorage.getItem(UPKEEP_AT) ?? 0);
  } catch {
    // No storage: every sync may try, and the engine decides there is nothing to do.
  }
  if (Date.now() - last < UPKEEP_EVERY_MS) return;
  upkeeping = true;
  const h = host;
  void h
    .sealedUpkeep(newUlid())
    .then(async (r) => {
      try {
        localStorage.setItem(UPKEEP_AT, String(Date.now()));
      } catch {
        // As above.
      }
      // A written snapshot moved nothing in the copy; a check that found the copy differs is told.
      if (r.did === 'check' && r.why === 'differs')
        console.warn(JSON.stringify({ event: 'snapshot_differs', tables: r.tables }));
      if (r.did !== 'nothing' && record) await save();
    })
    .catch(() => undefined)
    .finally(() => {
      upkeeping = false;
    });
}

/** The session the app shows for a sealed budget whose copy is open: the copy's facts, the server's account. */
async function sealedSessionNow(): Promise<Session | null> {
  if (!sealed || !host) return null;
  const m = mergedSession(sealed, await host.request('GET', '/api/session'));
  if (m) await host.put('session', JSON.stringify(m));
  return m;
}

/** Asks the passkey for the budget's secret alone (a challenge made here: the server has no part in it). */
async function askSlot(): Promise<{ credentialId: string; slotPrf: ArrayBuffer }> {
  const slot = (await slotPrfInput()).buffer as ArrayBuffer;
  let a;
  try {
    a = await assert(
      { challenge: toB64url(randomBytes(32)), rpId: location.hostname },
      { salt: record?.salt ?? randomBytes(32), credentialId: record?.credentialIdHint ?? null, slot },
    );
  } catch (e) {
    // Shown with the button that tries again: a passkey prompt needs a tap on some phones.
    if ((e as { name?: string }).name === 'UserVerificationRequired') throw e;
    throw new Error(NEEDS_PASSKEY);
  }
  if (!a.slotPrf) throw new Error('This passkey can’t open your budget on this device.');
  return { credentialId: a.credentialId, slotPrf: a.slotPrf };
}

// ---------------------------------------------------------------- the ways in of a locked budget

/**
 * Runs a change to the ways in (copy/sealed-ways.ts) with the budget key in hand: one passkey prompt checks the
 * person for the server and gives the budget's secret, the key is opened from the log's public entries, and
 * zeroed once `fn` is done. `onKeys` takes the new version's keys after a key change made here.
 */
export async function withBudgetKey<T>(
  fn: (
    ways: Ways,
    budget: OpenBudget,
    onKeys: (k: unknown) => Promise<void>,
    passkey: PasskeySecret,
  ) => Promise<T>,
): Promise<T> {
  if (!host || !who || !sealed || state.status !== 'ready') throw new Error(NOT_NOW);
  if (state.offline) throw new Error('Connect to the internet to change this.');
  const h = host;
  await signIn();
  const p = pending;
  pending = null;
  const w = p?.slotPrf ? { credentialId: p.credentialId, slotPrf: p.slotPrf } : await askSlot();
  const ways = waysOf(h, who.budgetId);
  const passkey: PasskeySecret = {
    credentialId: new Uint8Array(fromB64url(w.credentialId)),
    prf: new Uint8Array(w.slotPrf),
  };
  const last = await lastPublicSeen(h, who.budgetId);
  const { budget } = await openWithPasskey(
    await fetchPublicEntries(ways.fetch),
    who.budgetId,
    passkey,
    last ? { number: last.number, hash: fromHex(last.hash) } : undefined,
  );
  try {
    return await fn(
      ways,
      budget,
      async (k) => {
        keysInEngine = [...(keysInEngine ?? []), k];
        if (record && dataKey) await holdKey(record.key, dataKey, Date.now(), keysInEngine);
      },
      passkey,
    );
  } finally {
    zeroize(budget.bk);
    if (record) await save().catch(() => undefined);
    changed();
  }
}

/**
 * Checks a typed recovery key against the log's public entries: it opens this budget. Gives its public half for
 * sign-in (hex). Throws `WayInError` with words for the person.
 */
export async function checkRecoveryKey(typed: string): Promise<string> {
  if (!host || !who || !sealed) throw new Error(NOT_NOW);
  const ways = waysOf(host, who.budgetId);
  const { budget } = await openWithRecoveryKey(await fetchPublicEntries(ways.fetch), who.budgetId, typed);
  zeroize(budget.bk);
  const authPub = await authPubOf(typed);
  if (!authPub) throw new WayInError(KEY_TYPO);
  return authPub;
}

/**
 * The two headers of a request signed with the budget's key (docs/privacy-keys.md 11), over `bodyText`, the body
 * exactly as it is sent: a challenge from the Directory for this one request, signed in the engine, where the
 * signing key stays. For a locked budget whose copy is open only.
 */
export async function signedHeaders(action: string, bodyText: string): Promise<Record<string, string>> {
  if (!host || !sealed) throw new Error('Open your budget on this device, then try again.');
  const h = host;
  const ch = await server<{ challenge: string; token: string }>(
    'POST',
    '/api/settings/security/request-challenge',
    { action },
  );
  const sig = await h.sealedSign(action, fromHex(ch.challenge), new TextEncoder().encode(bodyText));
  return { [SIGNED_CHALLENGE_HEADER]: ch.token, [SIGNED_SIGNATURE_HEADER]: toHex(sig) };
}

/**
 * The log's public entries as the server has them now, walked by the log's rules: they must pass through the last
 * one this device saw. For the notices every device shows (copy/notices.ts). Null when the copy is not open.
 */
export async function publicLook(): Promise<{
  entries: Entry[];
  state: PublicState;
  deviceIds: string[];
  budgetId: string;
  session: SealedSession;
} | null> {
  if (!host || !who || !sealed || state.status !== 'ready' || state.offline) return null;
  const h = host;
  const budgetId = who.budgetId;
  const session = sealed;
  const ways = waysOf(h, budgetId);
  const entries = await fetchPublicEntries(ways.fetch);
  const last = await lastPublicSeen(h, budgetId);
  const st = await walkPublic(
    entries,
    budgetId,
    last ? { mustPass: { number: last.number, hash: fromHex(last.hash) } } : undefined,
  );
  // The writer's id as kept with the copy: none yet, nothing to tell (it is never made here).
  const deviceId = await h.get('log_device');
  if (!deviceId) return null;
  return { entries, state: st, deviceIds: [...new Set([deviceId, ...ownWriters()])], budgetId, session };
}

/** The changes planned in the log (intents) that wait, with the ways in each one removes. */
export async function plannedChanges(): Promise<ReturnType<typeof openPlans>> {
  if (!host || !who || !sealed) return [];
  const ways = waysOf(host, who.budgetId);
  return openPlans(await walkPublic(await fetchPublicEntries(ways.fetch), who.budgetId));
}

// ---------------------------------------------------------------- a new budget, locked from the start (D-102)

/** The server's clock as this device sees it, from its answer to the session: a first entry is dated by it. */
async function serverNow(): Promise<number> {
  const asked = Date.now();
  const r = await fetch('/api/session', {
    credentials: 'same-origin',
    headers: { accept: 'application/json', [SEALED_HEADER]: '1' },
  }).catch(() => null);
  const t = Number(r?.headers.get('x-ledgerline-time'));
  return Number.isFinite(t) && t > 0 ? Math.round(t + (Date.now() - asked) / 2) : Date.now();
}

/**
 * The first step of a new budget: the passkey is asked, and this device makes the budget's key, its recovery
 * key and the log's first entry. Nothing is sent.
 */
export async function lockStart(): Promise<NewBudget> {
  if (!host || !who || state.status !== 'fresh') throw new Error(NOT_NOW);
  const p = pending;
  pending = null;
  const w = p?.slotPrf ? { credentialId: p.credentialId, slotPrf: p.slotPrf } : await askSlot();
  return newBudget({
    budgetId: who.budgetId,
    deviceId: await logDeviceId(host),
    passkey: { credentialId: new Uint8Array(fromB64url(w.credentialId)), prf: new Uint8Array(w.slotPrf) },
    now: await serverNow(),
  });
}

/** A new budget's keys are given up: they are zeroed. */
export function lockGiveUp(p: NewBudget): void {
  dropNewBudget(p);
}

/**
 * The rest of a new budget's start: the recovery key typed back and a fresh passkey sign-in must both open the
 * new key; then the engine makes the copy, sends the first entry and the first snapshot, and the budget is
 * locked. `retype`: the typed key was wrong, or the passkey was not used; the same key is still in hand.
 */
export async function lockFinish(
  p: NewBudget,
  typed: string,
): Promise<{ ok: true } | { ok: false; why: string; retype?: boolean }> {
  if (!host || !who || state.status !== 'fresh' || !sealed) throw new Error(NOT_NOW);
  const h = host;
  // The first entry is dated when the key was made; the server takes it for an hour (seal/start.ts).
  if ((await serverNow()) - p.genesis.header.time > 50 * 60_000) {
    dropNewBudget(p);
    return { ok: false, why: 'This took too long. Start again: a new recovery key is made.' };
  }
  if (!(await recoveryKeyOpens(p, typed)))
    return { ok: false, why: 'That is not the recovery key shown. Check it and try again.', retype: true };
  // A fresh sign-in: the server asks for a recent passkey check, and the same prompt gives the budget's secret.
  let w: { credentialId: string; slotPrf: ArrayBuffer };
  try {
    await signIn();
    const q = pending;
    pending = null;
    w = q?.slotPrf ? { credentialId: q.credentialId, slotPrf: q.slotPrf } : await askSlot();
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : NOT_NOW, retype: true };
  }
  let proved: Awaited<ReturnType<typeof proveNewBudget>>;
  try {
    proved = await proveNewBudget(p, typed, {
      credentialId: new Uint8Array(fromB64url(w.credentialId)),
      prf: new Uint8Array(w.slotPrf),
    });
  } catch (e) {
    if (e instanceof WayInError) return { ok: false, why: e.message };
    throw e;
  } finally {
    dropNewBudget(p);
  }
  const keys = proved.keys as unknown as SealedKeys;
  const r = await h
    .startBudget(keys, proved.genesis, proved.deviceId, newUlid())
    .catch((e: unknown) => ({ ok: false as const, why: e instanceof Error ? e.message : NOT_NOW }));
  if (!r.ok) return { ok: false, why: `${r.why} Nothing was changed. Try again.` };
  // The budget is locked. From here this device treats it so, whatever the server says later.
  rememberSealed(who.budgetId);
  sealed = { ...sealed, fresh: false };
  await h.sealedOpen([keys], proved.deviceId, WORKER_RUN_KEYS);
  keysInEngine = [keys];
  // The recovery key signs in from now on (docs/privacy-keys.md 4.2): the server keeps its public half, in a
  // request signed with the budget's key (11). If this fails, Settings → Sign-in offers to set it.
  const authPub = await authPubOf(typed);
  if (authPub)
    await signedHeaders(ACTION.setRecoverySignIn, JSON.stringify({ authPub }))
      .then((headers) => server('POST', '/api/settings/security/recovery-key', { authPub }, headers))
      .catch(() => console.warn(JSON.stringify({ event: 'recovery_key_not_set' })));
  await keepPublicSeen(h, who.budgetId, { number: 1, hash: toHex(p.genesis.hash) });
  await h.put('publics', JSON.stringify([btoa(String.fromCharCode(...proved.genesis))]));
  await h.put('sealed_session', JSON.stringify(sealed));
  if (record && dataKey) {
    await holdKey(record.key, dataKey, Date.now(), [keys]);
    record = { ...record, sealed: true };
    await save();
  }
  const made = await sealedSessionNow();
  if (!made) throw new Error(NOT_NOW);
  window.dispatchEvent(new CustomEvent('ledgerline:session', { detail: made }));
  set({ status: 'ready' });
  watch();
  changed();
  return { ok: true };
}

const NOT_NOW = 'Something went wrong. Try again.';

// ---------------------------------------------------------------- server calls (plain fetch: no import cycle)

async function server<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers:
      method === 'GET'
        ? { accept: 'application/json', ...headers }
        : { 'content-type': 'application/json', [CSRF_HEADER]: '1', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  // Any answer means the network works (the offline banner goes).
  connectivity.reportOk();
  const text = await res.text();
  const json = (text ? JSON.parse(text) : null) as T & { error?: string; message?: string };
  if (!res.ok)
    throw Object.assign(new Error(json?.message ?? res.statusText), {
      code: json?.error,
      status: res.status,
    });
  return json;
}

// ---------------------------------------------------------------- sign-in and opening the copy

/**
 * Passkey sign-in. On an iPhone or iPad it asks the passkey for its PRF output in the same Face ID prompt, so the
 * copy can be set up or opened without a second one.
 */
export async function signIn(): Promise<void> {
  const options = await server<RequestOptionsJSON>('POST', '/api/auth/login/options');
  const saved = keepsCopy() ? await lastRecord() : null;
  const salt = saved?.salt ?? randomBytes(32);
  // Every budget is locked (D-102): the same prompt also gives the budget's secret, so a device that has never
  // opened it (a new browser, a Private window) isn't asked for the passkey a second time.
  const slot = (await slotPrfInput()).buffer as ArrayBuffer;
  const a = await assert(options, { salt, credentialId: saved?.credentialIdHint ?? null, slot });
  await server('POST', '/api/auth/login/verify', { response: a.json });
  pending = { credentialId: a.credentialId, prf: a.prf, salt, slotPrf: a.slotPrf };
}

function identityOf(s: Session): EngineIdentity {
  return {
    budgetId: s.budget.id,
    userId: s.user.email,
    email: s.user.email,
    ...(s.canLinkBanks ? {} : { noBanks: true }),
  };
}

/** Opens the copy for a confirmed session (online). Called by the router once the session is known. */
export async function start(session: Session): Promise<void> {
  if (MOCK || state.status === 'opening' || state.status === 'ready') return;
  who = identityOf(session);
  set({ status: 'opening', error: null, progress: 0, offline: false, why: null, forked: false });
  let why: FullWhy | null = keepsCopy() ? 'first' : 'memory';
  let memoryOnly = false;
  try {
    const key = recordKey(who.email, who.budgetId);
    let rec: CopyRecord | null = null;
    // Storage that can't be read isn't "no copy": the budget opens in memory and the saved copy is left alone.
    let unreadableStorage = false;
    if (keepsCopy())
      rec = await loadRecord(key).catch((e: unknown) => {
        if (!(e instanceof StorageUnavailable)) throw e;
        unreadableStorage = true;
        return null;
      });
    // Deleted when the app opened, because it was signed out from another device (checkSignedOut).
    if (!rec && turnedOff.delete(key)) why = 'turned_off';
    if (unreadableStorage) memoryOnly = true;
    const p = pending;
    pending = null;
    // Reloaded while the copy was open and in use (within 10 minutes): it opens again without Face ID.
    const kept = rec && !p?.prf ? await heldKey(key, IDLE_MS) : null;
    if (rec && kept) {
      // Too many checks from this address just now (several quick reloads): the copy opens all the same, and the
      // next start asks again. Only the server's "signed out" answer turns it off.
      const st = await server<{ off: boolean }>('POST', '/api/auth/copy-status', {
        device: rec.deviceId,
      }).catch((e: unknown) => {
        if (e instanceof Error && /Too many tries/.test(e.message)) return { off: false };
        throw e;
      });
      if (st.off) {
        await dropHeld(key);
        await deleteRecord(key);
        rec = null;
        why = 'turned_off';
      } else {
        try {
          const bytes = await openCopy(rec, kept);
          dataKey = kept;
          record = rec;
          await openHost(bytes);
          why = bytes ? null : 'empty';
        } catch (e) {
          if (!(e instanceof CopyUnreadable)) throw e;
          await dropHeld(key);
          return endSignIn();
        }
      }
    } else if (rec) {
      // Opened with a sign-in that's still valid but no Face ID (the app was closed in the background, past the
      // 10 minutes): the sign-in ends and the app shows Sign in, whose one Face ID opens the copy.
      if (!p) return endSignIn();
      // The passkey's PRF output only fits the salt this copy was set up with. A fresh sign-in without it opens the
      // budget in memory and leaves the saved copy for the next sign-in, instead of asking again.
      if (!p.prf || !sameBytes(p.salt, rec.salt)) memoryOnly = true;
    }
    if (rec && !memoryOnly && !kept && p?.prf) {
      const prf = p.prf;
      const share = await server<{ share: string }>(
        'POST',
        `/api/settings/security/devices/${rec.deviceId}/share`,
      ).catch(async (e: { code?: string }) => {
        if (e.code === 'revoked') {
          await dropHeld(key);
          await deleteRecord(key);
          why = 'turned_off';
          return null;
        }
        throw e;
      });
      if (share) {
        try {
          const u = await openKey(rec, p.credentialId, prf, fromB64url(share.share));
          const bytes = await openCopy(rec, u.dataKey);
          rec = { ...u.record, lastServerTime: Date.now() };
          dataKey = u.dataKey;
          record = rec;
          await openHost(bytes);
          why = bytes ? null : 'empty';
        } catch (e) {
          if (e instanceof Error && e.message === 'other_passkey')
            throw new Error('Use the passkey you set up this device with.');
          if (!(e instanceof CopyUnreadable)) throw e;
          // The copy can't be opened. The server has everything, so start a new copy (the server turns the old one
          // off when the new one is set up).
          console.warn(JSON.stringify({ event: 'copy_unreadable', step: e.step }));
          why = `unreadable_${e.step}`;
          await deleteRecord(key);
          rec = null;
          dataKey = null;
          record = null;
        }
      } else rec = null;
    }
    if (!rec || memoryOnly) {
      if (memoryOnly) {
        record = null;
        dataKey = null;
      } else if (keepsCopy() && p?.prf) {
        const dev = await server<{ id: string; share: string }>('POST', '/api/settings/security/devices', {
          name: deviceName(),
        });
        const made = await newKeys(
          {
            key,
            who,
            deviceId: dev.id,
            salt: p.salt,
            lastServerTime: Date.now(),
            savedAt: Date.now(),
            credentialIdHint: p.credentialId,
          },
          p.credentialId,
          p.prf,
          fromB64url(dev.share),
        );
        record = made.record;
        dataKey = made.dataKey;
      } else {
        record = null;
        dataKey = null;
        if (keepsCopy()) why = 'no_prf';
      }
      if (memoryOnly) why = unreadableStorage ? 'storage' : 'no_prf';
      await openHost(null);
    }
    // The budget's facts are in the copy itself: the session saved for an offline start is made from it once the
    // copy is open, not from the server's answer. A server that answers as if the budget were not locked gets
    // nothing (sealed-session.ts).
    if (!sealed) throw new Error(NOT_LOCKED);
    // Read before the data key is held anew, which would make old keys look fresh.
    const heldKeys = record ? await heldSealed(record.key, IDLE_MS) : null;
    if (record && dataKey) await holdKey(record.key, dataKey, Date.now(), undefined, IDLE_MS);
    // A new budget (D-102): nothing to open yet. The lock screen makes its key and its first entry.
    // A budget this device has known as locked is never made new: that would empty the copy (start-device.ts).
    if (sealed?.fresh && sealedBudgets().includes(sealed.budgetId)) throw new Error(NOT_LOCKED);
    if (sealed?.fresh) {
      if (p && !pending) pending = p;
      set({ saved: record !== null, hasSaved: record !== null, why: null, status: 'fresh' });
      return;
    }
    try {
      await enterSealed(p, heldKeys);
    } catch (e) {
      // The sign-in's secrets are kept for the button that tries again: the copy made above is opened with
      // them, not made a second time in memory.
      if (p && !pending) pending = p;
      throw e;
    }
    set({ saved: record !== null, hasSaved: record !== null, why });
    await syncNow();
    // The session the screens read is made from the copy, before the copy says it is ready: no screen shows a
    // budget with no name, in another time zone.
    const made = await sealedSessionNow();
    if (!made) throw new Error('Something went wrong. Try again.');
    if (record) await save();
    window.dispatchEvent(new CustomEvent('ledgerline:session', { detail: made }));
    set({ status: 'ready' });
    watch();
  } catch (e) {
    await host?.close();
    host = null;
    set({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
  }
}

/** Shown when the budget saved on this device can't be opened offline. */
const UNREADABLE =
  'The budget saved on this device couldn’t be opened. Connect to the internet to download it again.';

/** Opening with no signal: the passkey opens the copy on its own for up to 7 days after the last sign-in. */
export async function openWithoutSignal(onSession?: (s: Session) => void): Promise<Session> {
  const rec = await lastRecord();
  if (!rec)
    throw new Error('Your budget isn’t saved on this device yet. Connect to the internet to open it.');
  const a = await assert(
    {
      challenge: btoa(String.fromCharCode(...new Uint8Array(randomBytes(32))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      rpId: location.hostname,
    },
    {
      salt: rec.salt,
      credentialId: rec.credentialIdHint ?? null,
      // A sealed budget opens from the same prompt (its public entries are kept with the copy).
      ...(rec.sealed || sealedKnown(rec.who.budgetId)
        ? { slot: (await slotPrfInput()).buffer as ArrayBuffer }
        : {}),
    },
  );
  if (!a.prf)
    throw new Error('This passkey can’t open the budget saved here. Connect to the internet to open it.');
  set({ status: 'opening', error: null, offline: true, forked: false });
  try {
    const unreadable = (e: unknown): never => {
      if (e instanceof CopyUnreadable) throw new Error(UNREADABLE);
      throw e;
    };
    dataKey = await openKeyOffline(rec, a.credentialId, a.prf).catch((e: Error) => {
      if (e.message === 'offline_expired')
        throw new Error(
          'You’ve been offline for more than 7 days. Connect to the internet to open Ledgerline.',
        );
      if (e.message === 'other_passkey') throw new Error('Use the passkey you set up this device with.');
      return unreadable(e);
    });
    record = rec;
    who = rec.who;
    await openHost(await openCopy(rec, dataKey).catch(unreadable));
    const s = await host!.get('session');
    if (!s) throw new Error(UNREADABLE);
    const session = JSON.parse(s) as Session;
    const wasSealed = await host!.get('sealed_session');
    // A copy saved here before the budget was locked is not opened as the budget.
    if (!wasSealed) throw new Error('Connect to the internet to open your budget.');
    sealed = JSON.parse(wasSealed) as SealedSession;
    await enterSealed({ credentialId: a.credentialId, slotPrf: a.slotPrf }, null, false);
    // The saved session goes to the app first (onSession), then the copy says it's ready, so the app never shows a
    // moment with an open copy and no session ("Couldn't reach Ledgerline").
    onSession?.(session);
    set({ status: 'ready', saved: true, hasSaved: true });
    watch();
    return session;
  } catch (e) {
    await host?.close();
    host = null;
    dataKey = null;
    record = null;
    sealed = null;
    set({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function openHost(bytes: ArrayBuffer | null): Promise<void> {
  await host?.close();
  host = new EngineHost();
  host.onIdentity = (r) => void server('POST', '/api/identity-alert', r).catch(() => undefined);
  host.onRebuilding = () => set({ rebuilding: true });
  // Made again outside a sync (a way in added or removed): saved, and the screens read it again.
  host.onRebuilt = () => {
    set({ rebuilding: false });
    void save().catch(() => undefined);
    changed();
  };
  await host.open(who!, bytes);
}

/** The name this device's saved copy is known by on the server (Settings → Sign-in). */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Computer';
}

// ---------------------------------------------------------------- sync and save

let syncing: Promise<void> | null = null;
let lastSync = 0;

/**
 * Brings the copy up to date with the budget's log: reads the entries since, files the bank runs that wait, and
 * sends the changes made here, in one call to the engine; then saves the copy. Screens are told to read it again,
 * except after the app's own change (`quiet`): its mutation refreshes what it changed itself.
 */
export function syncNow(opts: { quiet?: boolean } = {}): Promise<void> {
  if (!host || !sealed) return Promise.resolve();
  if (syncing) return syncing.then(() => syncNow(opts));
  syncing = (async () => {
    try {
      lastSync = Date.now();
      // Nothing of it passes through this thread in the clear but counts.
      let r: Awaited<ReturnType<EngineHost['sealedSync']>>;
      try {
        r = await host!.sealedSync();
      } catch (e) {
        if (state.rebuilding) set({ rebuilding: false });
        // The server showed this device another history: the device stops, and the copy is left as it was.
        if (e instanceof Error && FORK_TEXT.test(e.message)) {
          if (record) await save().catch(() => undefined);
          await host?.close();
          host = null;
          set({ status: 'failed', forked: true, error: FORK_MESSAGE });
        }
        // The log's routes said the sign-in ended: the same as any other request that says so (client.ts).
        if (e instanceof Error && e.message === SIGNED_OUT_TEXT) {
          void dropSignedOut(true).finally(() => window.dispatchEvent(new Event('ledgerline:signedout')));
        }
        // Another device changed the budget key (a way in was removed): this device's passkey opens the new
        // key from the log. The copy is saved and closed; Try again signs in, which opens it.
        if (e instanceof Error && /does not hold key version/.test(e.message)) {
          if (record) await save().catch(() => undefined);
          await host?.close();
          host = null;
          set({ status: 'failed', error: NEEDS_PASSKEY });
        }
        throw e;
      }
      set({
        queued: (await queued()).length,
        ...(state.why ? { why: null } : {}),
        ...(state.rebuilding ? { rebuilding: false } : {}),
      });
      if (r.lost) window.dispatchEvent(new CustomEvent('ledgerline:edits-refused', { detail: r.lost }));
      const moved = r.entries > 0 || r.filed > 0 || r.sent > 0 || !!r.rebuilt;
      if (record && (moved || Date.now() - record.lastServerTime >= KEEP_ALIVE_MS)) {
        record = { ...record, lastServerTime: Date.now() };
        await save();
      }
      if ((r.entries > 0 || r.filed > 0 || r.rebuilt) && !opts.quiet) changed();
      upkeep();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * The copy on this device as one SQLite file, for the full backup of a locked budget (Settings → Backup, made on
 * the device: docs/privacy.md 5.8).
 */
export async function copyBytes(): Promise<ArrayBuffer> {
  if (!host || state.status !== 'ready')
    throw new Error('Your budget isn’t open on this device yet. Try again in a moment.');
  return host.export();
}

async function save(): Promise<void> {
  if (!record || !dataKey || !host) return;
  const started = performance.now();
  const bytes = await host.export();
  const kb = bytes.byteLength / 1024;
  const blob = await sealCopy(record, dataKey, bytes);
  record = { ...record, blob, savedAt: Date.now() };
  await saveRecord(record);
  // How long a whole-copy save takes, and its size, so the save can be split up only if it proves slow.
  usage.record('measure', 'copy.save.ms', performance.now() - started);
  usage.record('measure', 'copy.save.kb', kb);
}

// ---------------------------------------------------------------- reads and changes from the app

/** A read worked out from the copy: everything but what the server still answers itself (server-reads.ts). */
export function readsLocally(method: string, path: string): boolean {
  if (state.status !== 'ready' || !host) return false;
  if (method !== 'GET') return false;
  return !isServerRead(path);
}

export async function read(path: string): Promise<{ status: number; body: string }> {
  return host!.request('GET', path);
}

/** After a change: the log is read and the change sent (syncNow), then Ready to Assign. */
export async function afterChange(): Promise<{ rta: number; rtaUpdating: boolean } | null> {
  if (!host || state.status !== 'ready') return null;
  await syncNow({ quiet: true });
  const r = await host.rta();
  return { rta: r.rta, rtaUpdating: r.updating };
}

export interface EditStamp {
  id: string;
  at: number;
}

/** An id and a time for an edit: this device's clock, corrected by how far it is from the server's. */
export async function newEdit(): Promise<EditStamp> {
  return { id: crypto.randomUUID().replace(/-/g, ''), at: Date.now() + (await host!.state()).offset };
}

/** The copy is open, so a change can be made on it now. */
export function canEditHere(): boolean {
  return state.status === 'ready' && host !== null;
}

/**
 * What the server still does for a locked budget: sign-in, the banks, and the records it keeps about the app's
 * use. Every other change is made on the device.
 */
const SEALED_SERVER = [
  /^\/api\/auth\//,
  /^\/api\/settings\/security(\/|$)/,
  /^\/api\/settings\/connections\/(link-token|link-finish|refresh)$/,
  /^\/api\/settings\/connections\/[^/]+\/(refresh|remove)$/,
  /^\/api\/(usage|notes|identity-alert)$/,
];
export const sealedServerPath = (path: string): boolean =>
  SEALED_SERVER.some((r) => r.test(path.split('?')[0]!));

/** A change of the budget: applied to the copy now, and sent as an entry of the log with the next sync. */
export async function editOnDevice(method: string, path: string, body: unknown): Promise<unknown> {
  // The edit's own id and time, made before it runs: the copy runs it at that time and names its new rows from
  // that id.
  const edit = await newEdit();
  const shown = await shownFields(host!, method, path, body, () => syncNow({ quiet: true }));
  // One step in the engine: the edit runs on the copy and joins the queue, or neither.
  const r = await host!.enqueue({
    id: edit.id,
    at: edit.at,
    method,
    path,
    body: shown ? { ...(body as object | undefined), ...shown } : body,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  });
  const json = r.body ? (JSON.parse(r.body) as unknown) : null;
  if (r.status >= 300)
    throw Object.assign(
      new Error((json as { message?: string })?.message ?? 'Couldn’t save that. Try again.'),
      {
        code: (json as { error?: string })?.error,
        status: r.status,
      },
    );
  set({ queued: r.queued });
  await save();
  // The app's own mutation refreshes what it changed (as after an online change).
  return json;
}

declare const __APP_VERSION__: string;

async function queued(): Promise<QueuedEdit[]> {
  return host ? host.queue() : [];
}

/** Sends the changes made here: they go out as entries of the log, with the sync. A sync that fails is tried again by
 * the next one; nothing is dropped. */
export async function flush(): Promise<{ sent: number }> {
  if (!host || state.offline) return { sent: 0 };
  const before = (await queued()).length;
  if (!before) return { sent: 0 };
  await syncNow().catch(() => undefined);
  return { sent: Math.max(0, before - (await queued()).length) };
}

// ---------------------------------------------------------------- idle sign-out, wipe, timers

let lastActive = Date.now();
/** The activity time last written with the held key (a refresh within IDLE_MS of it skips Face ID). */
let heldActive = 0;
let hiddenAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function watch(): void {
  if (timer) return;
  const active = () => {
    lastActive = Date.now();
    // The other tabs share this sign-in: using any tab keeps them all from ending it after 10 idle minutes.
    if (lastActive - lastTold >= TELL_ACTIVE_MS) {
      lastTold = lastActive;
      tellOtherTabs('active');
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll'])
    window.addEventListener(ev, active, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      // Time away counts toward the idle sign-out from now, even if the app is closed in the background.
      if (record && dataKey) void holdKey(record.key, dataKey, lastActive);
      document.documentElement.dataset.covered = '1';
    } else {
      // Away since it was hidden, or since another tab was last used if that was later.
      const away = hiddenAt ? Date.now() - Math.max(hiddenAt, lastActive) : 0;
      hiddenAt = null;
      // Timers don't run while iOS has the app in the background: check before anything is drawn.
      if (away >= IDLE_MS) void signOutIdle();
      else {
        delete document.documentElement.dataset.covered;
        active();
        if (state.status === 'ready' && !state.offline) void syncNow().then(() => flush());
      }
    }
  });
  window.addEventListener('online', () => {
    if (state.status === 'ready') void flush();
  });
  timer = setInterval(
    () => {
      if (state.status !== 'ready') return;
      if (Date.now() - lastActive >= IDLE_MS) void signOutIdle();
      else if (record && dataKey && lastActive !== heldActive) {
        heldActive = lastActive;
        void holdKey(record.key, dataKey, lastActive);
      }
      if (Date.now() - lastActive >= IDLE_MS) return;
      if (document.visibilityState === 'visible' && !state.offline && Date.now() - lastSync >= SYNC_EVERY_MS)
        void syncNow().catch(() => undefined);
    },
    Math.min(SYNC_EVERY_MS, 30_000),
  );
}

/**
 * Ends the server session, then tells the app, which shows Sign in (or, with no signal, the screen that opens the
 * saved copy with Face ID). In this order so the app's next session check can't find the session that's ending.
 */
async function endSignIn(saved = true, here = true): Promise<void> {
  set({
    status: saved ? 'signed_out' : 'idle',
    hasSaved: saved || state.hasSaved,
    offline: false,
    progress: 0,
  });
  if (here) {
    await server('POST', '/api/settings/security/sign-out').catch(() => undefined);
    tellOtherTabs('locked');
  }
  window.dispatchEvent(new Event('ledgerline:signin-ended'));
}

// ---------------------------------------------------------------- other tabs

// The app's other tabs on this device share its sign-in. When one tab ends it (Sign out, or 10 idle minutes), the
// others are told at once, so none keeps showing the budget from its copy in memory until it next asks the server.
const SIGN_IN_CHANNEL = 'ledgerline-sign-in';
let channel: BroadcastChannel | null | undefined;
function otherTabs(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = new BroadcastChannel(SIGN_IN_CHANNEL);
      // Node (unit tests) would otherwise wait on it forever.
      (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    } catch {
      channel = null;
    }
  }
  return channel;
}

/**
 * `locked`: the sign-in ended and the saved copies stay. `deleted`: Sign out of this device deleted them. `active`:
 * someone is using that tab (at most once every TELL_ACTIVE_MS).
 */
type TabNotice = 'locked' | 'deleted' | 'active';
const TELL_ACTIVE_MS = 30_000;
let lastTold = 0;

function tellOtherTabs(notice: TabNotice): void {
  try {
    otherTabs()?.postMessage(notice);
  } catch {
    // A closed channel: the other tabs find out at their next request.
  }
}

// When another tab ends the sign-in, this one drops its keys and its copy in memory the same way, then shows Sign in.
// After Sign out of this device it deletes its copy instead of saving it, since that tab deleted every saved copy.
if (!MOCK)
  otherTabs()?.addEventListener('message', (e: MessageEvent) => {
    if (e.data === 'deleted') void wipe().then(() => endSignIn(false, false));
    else if (e.data === 'locked') void signOutIdle(false);
    else if (e.data === 'active') lastActive = Math.max(lastActive, Date.now());
  });

/**
 * 10 idle minutes: drops the keys, the copy in memory and the server session. The saved copy stays, encrypted.
 * `here` false: another tab already ended the session, so only this tab's part is done.
 */
export async function signOutIdle(here = true): Promise<void> {
  if (state.status !== 'ready' && state.status !== 'opening') return;
  if (record && dataKey && host && !state.offline) await save().catch(() => undefined);
  if (record) await dropHeld(record.key);
  await host?.close();
  host = null;
  dataKey = null;
  record = null;
  sealed = null;
  pending = null;
  delete document.documentElement.dataset.covered;
  return endSignIn(state.saved, here);
}

/** Deletes this person's copy (sign-out, signed out from another device, no longer a member); `all`: every copy. */
export async function wipe(all = false): Promise<void> {
  await host?.close();
  host = null;
  dataKey = null;
  const key = record?.key ?? (who ? recordKey(who.email, who.budgetId) : null);
  record = null;
  sealed = null;
  if (key) await dropHeld(key);
  if (all) await deleteAll();
  else if (key) await deleteRecord(key);
  set({ status: MOCK ? 'off' : 'idle', saved: false, hasSaved: false, queued: 0, offline: false });
}

/**
 * Signed out from another device (Settings → Sign-in): the copies it turned off are deleted before anything is shown.
 * Asked when the app opens and whenever the sign-in ends; with no signal it does nothing. A copy kept in memory only
 * goes too when the sign-in ends, since nothing on this device can say it's still wanted.
 */
/**
 * Sign out of this device: every copy saved here is deleted first, then the sign-in ends and the server forgets the
 * copies' shares.
 */
export async function signOutHere(): Promise<void> {
  const devices = MOCK ? [] : (await allRecords()).map((r) => r.deviceId);
  // The person's own act: this device forgets every budget it knew as sealed.
  forgetSealed(null);
  await wipe(true);
  await server('POST', '/api/settings/security/sign-out', { forget: true, devices });
  tellOtherTabs('deleted');
}

let dropping: Promise<void> | null = null;
export function dropSignedOut(signInEnded = false): Promise<void> {
  // Several screens' requests can end at once: one check answers them all.
  dropping ??= checkSignedOut(signInEnded).finally(() => {
    dropping = null;
  });
  return dropping;
}

async function checkSignedOut(signInEnded: boolean): Promise<void> {
  if (MOCK) return;
  const saved = keepsCopy() ? await allRecords() : [];
  if (!saved.length && signInEnded && host && !record && !state.offline) {
    await wipe();
    return;
  }
  for (const rec of saved) {
    const r = await server<{ off: boolean }>('POST', '/api/auth/copy-status', { device: rec.deviceId }).catch(
      () => null,
    );
    if (!r?.off) continue;
    turnedOff.add(rec.key);
    if (record?.key === rec.key) await wipe();
    else {
      await dropHeld(rec.key);
      await deleteRecord(rec.key);
    }
  }
}

/** Whether a saved copy exists on this device (for the no-signal screen). */
export async function checkSaved(): Promise<boolean> {
  if (!MOCK && canUsePasskeys() && keepsCopy()) await dropSignedOut();
  const has = !MOCK && canUsePasskeys() && keepsCopy() && (await lastRecord()) !== null;
  set({ hasSaved: has });
  return has;
}

export function getCopy(): CopyState {
  return state;
}

export function useCopy(): CopyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Tests only. */
export function resetCopyForTests(patch: Partial<CopyState> = {}): void {
  state = { ...state, ...patch };
  sealed = null;
  forgetSealed(null);
}
