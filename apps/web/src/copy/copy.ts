// The budget's copy on this device (docs/phone-budget.md, decisions.md D-45): every screen is worked out from it by
// the engine in a Web Worker; changes go to the server and come back through the sync. On any device whose passkey
// supports PRF (D-53), the copy is saved encrypted (vault.ts), reopens downloading only what changed, and opens with
// no signal; without PRF it's kept in memory for the visit only.
//
// Idle sign-out (D-57): after 10 idle minutes, or 10 minutes in the background, the keys, the copy in memory and the
// server session are dropped and the app shows Sign in; that one Face ID also opens the saved copy. A refresh or the
// app restarting within 10 minutes of the last activity reopens it with the data key held in IndexedDB (vault.ts
// holdKey). Wipe: signing out, here or from another device (Settings → Sign-in), no longer a member, or 7 days
// offline.
import { useSyncExternalStore } from 'react';
import { CSRF_HEADER, type SealedSession, type Session } from '@ledgerline/contracts';
import { slotPrfInput, WayInError } from '../keys/budget';
import { dropMove, prepareMove, proveMove, recoveryKeyOpens, type PreparedMove } from '../keys/move';
import { WORKER_RUN_KEYS } from '../keys/worker-keys';
import { logDeviceId, newUlid, openSealedBudget } from './sealed';
import { mergedSession } from './sealed-session';
import { connectivity } from '../state/connectivity';
import {
  EngineHost,
  syncAll,
  type EngineIdentity,
  type QueuedEdit,
  type SealedKeys,
  type SyncPage,
} from './host';
import { shadowBefore, shadowFinish, type Started } from './shadow';
import { usage } from '../usage/tracker';
import { isServerRead } from './server-reads';
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
  const first = sealed === null;
  sealed = s;
  rememberSealed(s.budgetId);
  // A copy that was open as a plain budget (another device moved the budget meanwhile) holds no place in the
  // log, and its queue was made for the old routes: the app starts again and opens the budget from the log.
  if (first && state.status === 'ready' && who && !MOCK) {
    void host?.close();
    host = null;
    window.location.reload();
  }
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
/** Only the person's own act on this device forgets it: the way back, or signing out here. */
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

// The last public entry of the log this device saw, kept in the copy and, as a second mark, outside it: a copy
// that is made again (or lives in memory only) still refuses a log that does not pass through it.
const PUBLIC_MARK = 'ledgerline.public.';
type PublicMark = { number: number; hash: string };
async function lastPublicSeen(h: EngineHost, budgetId: string): Promise<PublicMark | null> {
  const marks: PublicMark[] = [];
  const kept = await h.get('last_public');
  if (kept) marks.push(JSON.parse(kept) as PublicMark);
  try {
    const out = localStorage.getItem(PUBLIC_MARK + budgetId);
    if (out) marks.push(JSON.parse(out) as PublicMark);
  } catch {
    // The copy's own mark is all there is.
  }
  return marks.sort((a, b) => b.number - a.number)[0] ?? null;
}
async function keepPublicSeen(h: EngineHost, budgetId: string, m: PublicMark): Promise<void> {
  await h.put('last_public', JSON.stringify(m));
  try {
    localStorage.setItem(PUBLIC_MARK + budgetId, JSON.stringify(m));
  } catch {
    // The copy's own mark stays.
  }
}
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
const knowsSealed = (): boolean => sealedBudgets().length > 0;
/** Shown, with the button that tries again, when a sealed budget needs the passkey once more. */
export const NEEDS_PASSKEY = 'Your passkey is needed once more to open your budget. Try again.';

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

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
  if (!way?.slotPrf && heldKeys) {
    const o = await h.sealedOpen(heldKeys as never, deviceId, WORKER_RUN_KEYS);
    if (!o.ready) await h.sealedJoin();
    keys = heldKeys;
  } else {
    // No secret from the sign-in (this device opens a sealed budget for the first time, or the keys held are too
    // old): the passkey is asked once more, for the budget's secret alone. Nothing of this goes to the server.
    const w = way?.slotPrf ? way : await askSlot();
    const last = await lastPublicSeen(h, who!.budgetId);
    const publics = await h.get('publics');
    const r = await openSealedBudget({
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
      passkey: { credentialId: new Uint8Array(fromB64url(w.credentialId)), prf: new Uint8Array(w.slotPrf!) },
      workerKeys: WORKER_RUN_KEYS,
      ...(last ? { remembered: { number: last.number, hash: fromHex(last.hash) } } : {}),
    });
    await keepPublicSeen(h, who!.budgetId, { number: r.lastPublic.number, hash: toHex(r.lastPublic.hash) });
    await h.put('publics', JSON.stringify(r.publics));
    keys = r.keys;
  }
  if (sealed) await h.put('sealed_session', JSON.stringify(sealed));
  if (record && dataKey) await holdKey(record.key, dataKey, Date.now(), keys);
  // Saved now: the place in the log, the writer's id and the marks above must outlive a closed app, or the next
  // start would join again as a new writer.
  if (record && online) {
    record = { ...record, sealed: true };
    await save();
  }
}

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

// ---------------------------------------------------------------- moving a budget to its sealed log

export type MoveInHand = PreparedMove;
const NOT_NOW = 'Something went wrong. Try again.';

/**
 * The first step of the move (docs/privacy.md section 8 step 6): the passkey is asked, and this device makes
 * the budget's key, its recovery key and the log's first entry. Nothing is sent.
 */
export async function moveStart(): Promise<MoveInHand> {
  if (!host || !who || state.status !== 'ready' || sealed) throw new Error(NOT_NOW);
  if (state.offline) throw new Error('Connect to the internet to lock your budget.');
  // Asked of the server, not of this device's memory: an earlier try may have sealed the budget.
  if ((await server<{ sealed: boolean }>('GET', '/api/cutover/state')).sealed)
    throw new Error('This budget is locked already.');
  // Every change made here must be on the server first: the move takes the budget as the server holds it.
  await flush();
  if ((await queued()).length)
    throw new Error('Some changes are not sent yet. Wait a moment, then try again.');
  const w = await askSlot();
  return prepareMove({
    budgetId: who.budgetId,
    deviceId: await logDeviceId(host),
    passkey: { credentialId: new Uint8Array(fromB64url(w.credentialId)), prf: new Uint8Array(w.slotPrf) },
    // The server's clock as this device measured it: the log refuses a first entry dated by another clock.
    now: Date.now() + (await host.state()).offset,
  });
}

/** The move is given up: the keys made for it are zeroed. */
export function moveGiveUp(p: MoveInHand): void {
  dropMove(p);
}

/**
 * The rest of the move: the recovery key typed back and a fresh passkey prompt must both open the new key; then
 * the engine freezes the budget, sends the first entry and the first snapshot, and reads the snapshot back.
 * `retype`: the typed key was wrong, or the prompt was not answered; the same key is still in hand.
 */
export async function moveFinish(
  p: MoveInHand,
  typed: string,
): Promise<{ ok: true } | { ok: false; why: string; retype?: boolean; again?: boolean }> {
  if (!host || !who || state.status !== 'ready' || sealed) throw new Error(NOT_NOW);
  const h = host;
  // The first entry is dated when the key was made; the server takes it for an hour (seal/cutover.ts).
  if (Date.now() + (await h.state()).offset - p.genesis.header.time > 50 * 60_000) {
    dropMove(p);
    return { ok: false, why: 'This took too long. Start again: a new recovery key is made.' };
  }
  if (!(await recoveryKeyOpens(p, typed)))
    return { ok: false, why: 'That is not the recovery key shown. Check it and try again.', retype: true };
  let w: { credentialId: string; slotPrf: ArrayBuffer };
  try {
    w = await askSlot();
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : NOT_NOW, retype: true };
  }
  let proved: Awaited<ReturnType<typeof proveMove>>;
  try {
    proved = await proveMove(p, typed, {
      credentialId: new Uint8Array(fromB64url(w.credentialId)),
      prf: new Uint8Array(w.slotPrf),
    });
  } catch (e) {
    dropMove(p);
    if (e instanceof WayInError) return { ok: false, why: e.message };
    throw e;
  } finally {
    dropMove(p);
  }
  const keys = proved.keys as unknown as SealedKeys;
  let r: Awaited<ReturnType<EngineHost['cutover']>>;
  try {
    r = await h.cutover(keys, proved.genesis, proved.deviceId, newUlid());
  } catch (e) {
    r = { ok: false, why: e instanceof Error ? e.message : NOT_NOW };
  }
  if (!r.ok) return { ok: false, why: await moveFailed(r.why), again: true };
  // The budget is sealed. From here this device treats it so, whatever the server says later.
  rememberSealed(who.budgetId);
  sealed = {
    sealed: true,
    user: { email: who.email },
    budgetId: who.budgetId,
    appVersion: '',
    writeState: 'ok',
    readOnlyUntil: null,
    readsPaused: false,
    canLinkBanks: false,
    recoveryNoticeAt: null,
  };
  await h.sealedOpen([keys], proved.deviceId, WORKER_RUN_KEYS);
  await keepPublicSeen(h, who.budgetId, { number: 1, hash: toHex(p.genesis.hash) });
  await h.put('publics', JSON.stringify([btoa(String.fromCharCode(...proved.genesis))]));
  await h.put('sealed_session', JSON.stringify(sealed));
  if (record && dataKey) {
    await holdKey(record.key, dataKey, Date.now(), [keys]);
    record = { ...record, sealed: true };
    await save();
  }
  const made = await sealedSessionNow();
  if (made) window.dispatchEvent(new CustomEvent('ledgerline:session', { detail: made }));
  // The server's own answer for a sealed budget replaces the account facts made up above.
  window.dispatchEvent(new Event('ledgerline:readonly'));
  changed();
  return { ok: true };
}

/**
 * The move stopped after the engine began it. The copy on this device may be empty now, and the server may hold
 * a freeze or even a sealed budget whose first snapshot this device never read back. The server is asked where
 * it stands: a freeze is ended; a sealed budget is taken back at once (nothing was changed since). Gives what
 * to tell the person. The caller then deletes the copy and starts the app again (`moveAgain`).
 */
async function moveFailed(why: string): Promise<string> {
  const st = await server<{ sealed: boolean }>('GET', '/api/cutover/state').catch(() => null);
  if (!st) return `${why} Check Settings → Privacy when you are online again.`;
  if (!st.sealed) {
    await server('POST', '/api/cutover/unfreeze').catch(() => undefined);
    return `${why} Nothing was changed.`;
  }
  const back = await server('POST', '/api/cutover/back').then(
    () => true,
    () => false,
  );
  if (back) return `${why} The move was undone. Nothing was lost.`;
  // The budget is sealed and stays so: this device treats it so, and opens it from the log.
  if (who) rememberSealed(who.budgetId);
  return `${why} Your budget is locked. To undo it, open Settings → Privacy and go back.`;
}

/** After a move that failed: the copy (which the engine may have emptied) is deleted and the app starts again. */
export async function moveAgain(): Promise<void> {
  await wipe();
  window.location.reload();
}

/**
 * Before the way back is asked of the server: this device forgets that the budget was sealed, so that it takes
 * the plain budget even if the app is closed before `moveBack` runs. The person's own act, on this device.
 */
export function moveBackStart(): void {
  forgetSealed(who?.budgetId ?? sealed?.budgetId ?? null);
}

/**
 * After the way back was taken on the server (`POST /api/cutover/back`): this device forgets that the budget was
 * sealed, deletes its copy and starts again, from the budget as it was.
 */
export async function moveBack(): Promise<void> {
  forgetSealed(who?.budgetId ?? sealed?.budgetId ?? null);
  await wipe();
  window.location.reload();
}

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

const fetchPage = (since: number, cursor: string | null) =>
  server<SyncPage>(
    'GET',
    `/api/sync?since=${since}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${
      since === 0 && !cursor ? `&why=${state.why ?? 'reset'}` : ''
    }`,
  );

// ---------------------------------------------------------------- sign-in and opening the copy

/**
 * Passkey sign-in. On an iPhone or iPad it asks the passkey for its PRF output in the same Face ID prompt, so the
 * copy can be set up or opened without a second one.
 */
export async function signIn(): Promise<void> {
  const options = await server<RequestOptionsJSON>('POST', '/api/auth/login/options');
  const saved = keepsCopy() ? await lastRecord() : null;
  const salt = saved?.salt ?? randomBytes(32);
  // On a device that opened a sealed budget before, the same prompt also gives the budget's secret.
  const slot = knowsSealed() ? ((await slotPrfInput()).buffer as ArrayBuffer) : undefined;
  const a = await assert(
    options,
    keepsCopy() || slot
      ? { salt, credentialId: saved?.credentialIdHint ?? null, ...(slot ? { slot } : {}) }
      : undefined,
  );
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
  set({ status: 'opening', error: null, progress: 0, offline: false, why: null });
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
      const st = await server<{ off: boolean }>('POST', '/api/auth/copy-status', { device: rec.deviceId });
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
    // A sealed budget's facts are in the copy itself: the session saved for an offline start is made from it
    // once the copy is open (client.ts), not from the server's answer.
    // A copy from a sealed budget, on a device that was told (by the person, with the way back) that the
    // budget is not sealed any more: it is deleted, and the app starts again with the budget as the server has it.
    if (!sealed && (await host!.get('sealed_session'))) {
      await wipe();
      window.location.reload();
      return;
    }
    if (!sealed) await host!.put('session', JSON.stringify(session));
    // Read before the data key is held anew, which would make old keys look fresh.
    const heldKeys = sealed && record ? await heldSealed(record.key, IDLE_MS) : null;
    if (record && dataKey) await holdKey(record.key, dataKey, Date.now(), undefined, IDLE_MS);
    if (sealed) {
      try {
        await enterSealed(p, heldKeys);
      } catch (e) {
        // The sign-in's secrets are kept for the button that tries again: the copy made above is opened with
        // them, not made a second time in memory.
        if (p && !pending) pending = p;
        throw e;
      }
    }
    set({ saved: record !== null, hasSaved: record !== null, why });
    await syncNow();
    if (sealed) {
      // The session the screens read is made from the copy, before the copy says it is ready: no screen shows
      // a budget with no name, in another time zone.
      const made = await sealedSessionNow();
      if (!made) throw new Error('Something went wrong. Try again.');
      if (record) await save();
      window.dispatchEvent(new CustomEvent('ledgerline:session', { detail: made }));
    }
    set({ status: 'ready' });
    watch();
    void flush();
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
  set({ status: 'opening', error: null, offline: true });
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
    if (wasSealed) {
      sealed = JSON.parse(wasSealed) as SealedSession;
      await enterSealed({ credentialId: a.credentialId, slotPrf: a.slotPrf }, null, false);
    } else if (sealedKnown(rec.who.budgetId))
      // The copy saved here is from before the budget was sealed: it is not opened as the budget.
      throw new Error('Connect to the internet to open your budget.');
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
 * Brings the copy up to date with the server, works out the budget again and saves it. Screens are told to read it
 * again, except after the app's own change (`quiet`): its mutation refreshes what it changed itself.
 */
export function syncNow(opts: { quiet?: boolean; first?: EditAnswerSync } = {}): Promise<void> {
  if (!host) return Promise.resolve();
  if (syncing) return syncing.then(() => syncNow(opts));
  syncing = (async () => {
    try {
      lastSync = Date.now();
      if (sealed) {
        // A sealed budget: the engine reads the log, files the bank runs that wait, and sends the changes made
        // here, in one call. Nothing of it passes through this thread in the clear but counts.
        let r: Awaited<ReturnType<EngineHost['sealedSync']>>;
        try {
          r = await host!.sealedSync();
        } catch (e) {
          // The log's routes said the sign-in ended: the same as any other request that says so (client.ts).
          if (e instanceof Error && e.message === SIGNED_OUT_TEXT) {
            void dropSignedOut(true).finally(() => window.dispatchEvent(new Event('ledgerline:signedout')));
          }
          throw e;
        }
        set({ queued: (await queued()).length, ...(state.why ? { why: null } : {}) });
        if (r.lost) window.dispatchEvent(new CustomEvent('ledgerline:edits-refused', { detail: r.lost }));
        const moved = r.entries > 0 || r.filed > 0 || r.sent > 0;
        if (record && (moved || Date.now() - record.lastServerTime >= KEEP_ALIVE_MS)) {
          record = { ...record, lastServerTime: Date.now() };
          await save();
        }
        if ((r.entries > 0 || r.filed > 0) && !opts.quiet) changed();
        upkeep();
        return;
      }
      // An edit's answer carries the changes since the copy's change number: use them as the first page, but only if
      // the copy is still there (another sync may have moved it on meanwhile).
      let first = opts.first;
      let shadowing: Started | null = null;
      let pages = 0;
      const r = await syncAll(
        host!,
        async (since, cursor) => {
          const given = first && !cursor && since === first.since ? first.page : null;
          first = undefined;
          if (given) return given;
          const p = await fetchPage(since, cursor);
          set({ progress: state.progress + p.rows.length });
          return p;
        },
        () => set({ why: 'reset', progress: 0 }),
        // The shadow run (shadow.ts): when the server filed bank updates this device hasn't seen, the device files
        // them too, on a scratch copy made now, before the server's rows arrive. Nothing here uses the network.
        async (page) => {
          pages++;
          const started = await shadowBefore(host!, page, pages === 1, (path, body) =>
            server('POST', path, body),
          );
          if (started) shadowing = started;
        },
      );
      if (r.lost) {
        // The engine ran the queue again on the server's newer rows, and some edits no longer pass.
        set({ queued: (await queued()).length });
        window.dispatchEvent(new CustomEvent('ledgerline:edits-refused', { detail: r.lost }));
      }
      if (state.why) set({ why: null });
      const derived = r.rows > 0 || !(await host!.state()).through;
      if (derived) await host!.derive();
      // The saved copy is the whole database, encrypted: write it again only when it changed, or once an hour to
      // move the 7-day offline limit along (lastServerTime). A sync that brings nothing costs no save.
      if (record && (derived || Date.now() - record.lastServerTime >= KEEP_ALIVE_MS)) {
        record = { ...record, lastServerTime: Date.now() };
        await save();
      }
      if (r.rows > 0 && !opts.quiet) changed();
      // In the background: it files and compares after the screens have what the server sent.
      if (shadowing)
        void shadowFinish(
          host!,
          shadowing,
          (path) => server('GET', path),
          (path, body) => server('POST', path, body),
        );
    } finally {
      syncing = null;
    }
  })();
  return syncing;
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

/** The changes an edit's answer carried (`sync`), and the change number they start after. */
export interface EditAnswerSync {
  since: number;
  page: SyncPage;
}

/**
 * The change number to send with an online edit (`x-sync-since`), so its answer carries what changed: null while
 * the copy isn't open or is still downloading.
 */
export async function syncSince(): Promise<number | null> {
  if (!host || state.status !== 'ready') return null;
  const st = await host.state();
  return st.cursor || !st.through ? null : st.through;
}

/** After a change on the server: sync it into the copy (from the answer when it carried the changes), then RTA. */
export async function afterChange(
  answer?: EditAnswerSync | null,
): Promise<{ rta: number; rtaUpdating: boolean } | null> {
  if (!host || state.status !== 'ready') return null;
  await syncNow({ quiet: true, first: answer ?? undefined });
  const r = await host.rta();
  return { rta: r.rta, rtaUpdating: r.updating };
}

/** Archiving a category: the amount the phone shows and the change number it was worked out at (D-45). */
export async function archiveFields(
  categoryId: string,
): Promise<{ available: number; through: number } | null> {
  if (!host || state.status !== 'ready') return null;
  await syncNow();
  const r = await host.request('GET', `/api/categories/${encodeURIComponent(categoryId)}/sheet`);
  if (r.status !== 200) return null;
  const available = (JSON.parse(r.body) as { available: number }).available;
  return { available, through: (await host.state()).through };
}

/** Close account (D-73): the working balance and card payment category available this phone shows, and `through`. */
export async function closeFields(
  accountId: string,
): Promise<{ working: number; available: number; through: number } | null> {
  if (!host || state.status !== 'ready') return null;
  await syncNow();
  const r = await host.request('GET', `/api/accounts/${encodeURIComponent(accountId)}/register`);
  if (r.status !== 200) return null;
  const v = JSON.parse(r.body) as { account: { working: number }; cardAvailable: number | null };
  return {
    working: v.account.working,
    available: v.cardAvailable ?? 0,
    through: (await host.state()).through,
  };
}

// ---- offline edits (docs/phone-budget.md section 12)

// Every route here has a twin case (apps/worker/test/twin.test.ts): the copy and the server write the same rows for
// it. Left out on purpose: archiving or removing a category and closing an account (the server takes them only when
// nothing changed since the phone worked out a balance, which a queue can't promise), joining payees, setup, and
// everything that needs the server (bank links, sign-in).
const OFFLINE_EDITS: [string, RegExp][] = [
  ['PATCH', /^\/api\/transactions\/[^/]+$/],
  // An entry added by hand, and its removal. The entry's id comes from the edit's id, so a later queued edit of
  // the entry finds it on the server.
  ['POST', /^\/api\/transactions$/],
  ['DELETE', /^\/api\/transactions\/[^/]+$/],
  ['POST', /^\/api\/transactions\/[^/]+\/(review|pending|not-same|not-same\/undo)$/],
  // What you're owed, matching money in, transfers, "Same purchase?" and alerts: each acts on rows the copy holds.
  ['POST', /^\/api\/owed\/[^/]+$/],
  ['POST', /^\/api\/match$/],
  ['POST', /^\/api\/match\/[^/]+\/unlink$/],
  ['POST', /^\/api\/transfers\/[^/]+\/(pick|unpair)$/],
  ['POST', /^\/api\/same-purchase\/[^/]+$/],
  ['POST', /^\/api\/alerts\/[^/]+\/dismiss$/],
  // Names and order: an account's name, a category or group (new or renamed), their order. (Not PATCH /settings:
  // the app reads those settings from the session, which only the server answers.)
  ['POST', /^\/api\/accounts\/[^/]+\/name$/],
  ['POST', /^\/api\/settings\/(categories|groups)$/],
  ['POST', /^\/api\/settings\/(categories|groups)\/reorder$/],
  ['POST', /^\/api\/transactions\/categorize$/],
  ['POST', /^\/api\/budget\/(assign|set|move)$/],
  ['PUT', /^\/api\/categories\/[^/]+\/target$/],
  // Pinning a category to the top of Budget (D-74): one category and its new state, so a late one undoes nothing else.
  ['POST', /^\/api\/settings\/categories\/[^/]+\/pin$/],
  // Renaming a payee (not joining: that needs a connection). Its id is in the path, so a rename that arrives after
  // the payee was joined into another is refused instead of renaming the other one (docs/payees.md 5.3).
  ['POST', /^\/api\/settings\/payees\/(?!merge(?:\/|$))[^/]+$/],
];

export interface EditStamp {
  id: string;
  at: number;
}

/** An id and a time for an edit: this device's clock, corrected by how far it is from the server's. */
export async function newEdit(): Promise<EditStamp> {
  return { id: crypto.randomUUID().replace(/-/g, ''), at: Date.now() + (await host!.state()).offset };
}

export function canEditOffline(method: string, path: string): boolean {
  if (state.status !== 'ready' || !host) return false;
  // A sealed budget: every change of the budget is made on the device (each has a twin check against the
  // server's own route, apps/worker/test/twin.test.ts). Only what needs the server goes to it.
  if (sealed) return !sealedServerPath(path);
  return OFFLINE_EDITS.some(([m, r]) => m === method && r.test(path));
}

/**
 * What the server still does for a sealed budget: sign-in, the banks, the move itself, and the records it keeps
 * about the app's use. The list is the twin test's "never run on a phone's copy" (SERVER_ONLY).
 */
const SEALED_SERVER = [
  /^\/api\/auth\//,
  /^\/api\/settings\/security(\/|$)/,
  /^\/api\/cutover\//,
  /^\/api\/settings\/connections\/(link-token|link-finish|exchange|refresh)$/,
  /^\/api\/settings\/connections\/[^/]+\/refresh$/,
  /^\/api\/settings\/restore$/,
  /^\/api\/(usage|notes|identity-alert)$/,
  /^\/api\/sync\/shadow$/,
];
export const sealedServerPath = (path: string): boolean =>
  SEALED_SERVER.some((r) => r.test(path.split('?')[0]!));

/** A change made with no signal: applied to the copy now, sent to the server when there's a connection. */
export async function editOffline(
  method: string,
  path: string,
  body: unknown,
  /** The id and time this edit already went to the server with, when its connection dropped on the way. */
  edit?: EditStamp,
): Promise<unknown> {
  // The edit's own id and time, made before it runs: the copy runs it at that time and names its new rows from that
  // id, and the queue sends both to the server, which then makes the same rows.
  // An edit that was given its id went to the server once already, and the answer was lost: the server may hold
  // it. The queue sends it again under the same id, and the copy never runs it again by itself.
  const resend = !!edit;
  edit ??= await newEdit();
  // One step in the engine: the edit runs on the copy and joins the queue, or neither.
  const r = await host!.enqueue({
    id: edit.id,
    at: edit.at,
    method,
    path,
    body,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    ...(resend ? { sending: true } : {}),
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

let flushing = false;
/** Sends changes made offline, in order. One the server refuses is dropped and the copy is downloaded again. */
export async function flush(): Promise<{ sent: number; refused: number }> {
  if (!host || flushing || state.offline) return { sent: 0, refused: 0 };
  if (sealed) {
    // A sealed budget's changes go out as entries of its log, with the sync. A sync that fails is tried again
    // by the next one; nothing is dropped.
    const before = (await queued()).length;
    if (!before) return { sent: 0, refused: 0 };
    await syncNow().catch(() => undefined);
    return { sent: Math.max(0, before - (await queued()).length), refused: 0 };
  }
  flushing = true;
  let sent = 0;
  let refused = 0;
  let redownload = false;
  try {
    // The queue is read again each round: the engine may have changed it meanwhile (a new edit, or a sync that ran
    // it again), and every change to it is one step of the engine.
    for (;;) {
      const e = (await queued())[0];
      if (!e) break;
      // From here the server may hold this edit: the copy must never run it again by itself (engine.ts apply).
      await host.queueSending(e.id);
      try {
        await server(e.method, e.path, e.body, { 'x-edit-id': e.id, 'x-edit-at': String(e.at) });
        sent++;
        set({ queued: await host.queueDone(e.id) });
      } catch (err) {
        if (!(err as { status?: number }).status) break; // no connection: try again later
        refused++;
        // The engine takes the refused edit out of the copy and runs the later ones again, when that can be done
        // exactly. Otherwise the copy is downloaded again below.
        const out = await host.queueRefused(e.id);
        refused += out.lost;
        set({ queued: out.left });
        if (out.redownload) redownload = true;
        else await save();
      }
    }
    if (refused) {
      // The copy may hold edits the server didn't take: download it again so it shows what the server has.
      if (redownload) await host.clear();
      window.dispatchEvent(new CustomEvent('ledgerline:edits-refused', { detail: refused }));
    }
    if (sent || refused) await syncNow();
  } finally {
    flushing = false;
  }
  return { sent, refused };
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
