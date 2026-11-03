// The budget's copy on this device (docs/phone-budget.md, decisions.md D-45): every screen is worked out from it by
// the engine in a Web Worker; changes go to the server and come back through the sync. On any device whose passkey
// supports PRF (D-53), the copy is saved encrypted (vault.ts), reopens downloading only what changed, and opens with
// no signal; without PRF it's kept in memory for the visit only.
//
// Lock (13.4): after 10 idle minutes, or 10 minutes in the background, the keys, the copy and the server session are
// dropped; opening again needs Face ID. Wipe: signing out, here or from another device (Settings → Sign-in), no longer
// a member, or 7 days offline.
import { useSyncExternalStore } from 'react';
import { CSRF_HEADER, type Session } from '@ledgerline/contracts';
import { connectivity } from '../state/connectivity';
import { EngineHost, syncAll, type EngineIdentity, type SyncPage } from './host';
import { assert, canUsePasskeys, keepsCopy, type RequestOptionsJSON } from './passkey';
import {
  type CopyRecord,
  allRecords,
  deleteAll,
  deleteRecord,
  fromB64url,
  lastRecord,
  loadRecord,
  newKeys,
  openCopy,
  randomBytes,
  recordKey,
  saveRecord,
  sealCopy,
  unlock,
  unlockOffline,
  CopyUnreadable,
  sameBytes,
} from './vault';

export const LOCK_MS = 10 * 60_000;
const SYNC_EVERY_MS = 2 * 60_000;

export type CopyStatus =
  | 'off' // the mock API (development and tests)
  | 'idle' // nobody signed in yet
  | 'locked' // a saved copy waits for Face ID
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
/** A sign-in that just produced a PRF output, for start() to use without asking for Face ID again. */
let pending: { credentialId: string; prf: ArrayBuffer | null; salt: ArrayBuffer } | null = null;

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

// ---------------------------------------------------------------- sign-in and unlock

/**
 * Passkey sign-in. On an iPhone or iPad it asks the passkey for its PRF output in the same Face ID prompt, so the
 * copy can be set up or unlocked without a second one.
 */
export async function signIn(): Promise<void> {
  const options = await server<RequestOptionsJSON>('POST', '/api/auth/login/options');
  const saved = keepsCopy() ? await lastRecord() : null;
  const salt = saved?.salt ?? randomBytes(32);
  const a = await assert(
    options,
    keepsCopy() ? { salt, credentialId: saved?.credentialIdHint ?? null } : undefined,
  );
  await server('POST', '/api/auth/login/verify', { response: a.json });
  pending = { credentialId: a.credentialId, prf: a.prf, salt };
}

function identityOf(s: Session): EngineIdentity {
  return { budgetId: s.budget.id, userId: s.user.email, email: s.user.email };
}

/** Opens the copy for a confirmed session (online). Called by the router once the session is known. */
export async function start(session: Session): Promise<void> {
  if (MOCK || state.status === 'opening' || state.status === 'ready') return;
  who = identityOf(session);
  set({ status: 'opening', error: null, progress: 0, offline: false, why: null });
  let why: FullWhy | null = keepsCopy() ? 'first' : 'memory';
  try {
    const key = recordKey(who.email, who.budgetId);
    let rec = keepsCopy() ? await loadRecord(key) : null;
    const p = pending;
    pending = null;
    if (rec) {
      // The passkey's PRF output only fits the salt this copy was set up with; any other sign-in asks again.
      if (!p?.prf || !sameBytes(p.salt, rec.salt)) {
        set({ status: 'locked', hasSaved: true });
        return;
      }
      const share = await server<{ share: string }>(
        'POST',
        `/api/settings/security/devices/${rec.deviceId}/share`,
      ).catch(async (e: { code?: string }) => {
        if (e.code === 'revoked') {
          await deleteRecord(key);
          why = 'turned_off';
          return null;
        }
        throw e;
      });
      if (share) {
        try {
          const u = await unlock(rec, p.credentialId, p.prf, fromB64url(share.share));
          const bytes = await openCopy(rec, u.dataKey);
          rec = { ...u.record, lastServerTime: Date.now() };
          dataKey = u.dataKey;
          record = rec;
          await openHost(bytes);
          why = bytes ? null : 'empty';
        } catch (e) {
          if (e instanceof Error && e.message === 'other_passkey')
            throw new Error('Use the passkey you set this phone up with.');
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
    if (!rec) {
      if (keepsCopy() && p?.prf) {
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
      await openHost(null);
    }
    await host!.put('session', JSON.stringify(session));
    set({ saved: record !== null, hasSaved: record !== null, why });
    await syncNow();
    set({ status: 'ready' });
    watch();
    void flush();
  } catch (e) {
    await host?.close();
    host = null;
    set({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
  }
}

/** The Unlock button: a fresh sign-in with Face ID that also unlocks the saved copy. */
export async function unlockOnline(session: Session | null): Promise<void> {
  await signIn();
  set({ status: 'idle' });
  if (session) await start(session);
}

/** Opening with no signal: the passkey unlocks the copy on its own for up to 7 days after the last sign-in. */
export async function unlockWithoutSignal(onSession?: (s: Session) => void): Promise<Session> {
  const rec = await lastRecord();
  if (!rec) throw new Error('There’s no copy on this phone yet.');
  const a = await assert(
    {
      challenge: btoa(String.fromCharCode(...new Uint8Array(randomBytes(32))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, ''),
      rpId: location.hostname,
    },
    { salt: rec.salt, credentialId: rec.credentialIdHint ?? null },
  );
  if (!a.prf) throw new Error('This passkey can’t unlock the copy.');
  set({ status: 'opening', error: null, offline: true });
  try {
    const unreadable = (e: unknown): never => {
      if (e instanceof CopyUnreadable)
        throw new Error(
          `This phone’s saved copy couldn’t be opened (${e.step}). Turn Airplane Mode off and open Ledgerline: it downloads your budget again.`,
        );
      throw e;
    };
    dataKey = await unlockOffline(rec, a.credentialId, a.prf).catch((e: Error) => {
      if (e.message === 'offline_expired')
        throw new Error('Connect to the internet to open Ledgerline: it’s been more than 7 days.');
      if (e.message === 'other_passkey') throw new Error('Use the passkey you set this phone up with.');
      return unreadable(e);
    });
    record = rec;
    who = rec.who;
    await openHost(await openCopy(rec, dataKey).catch(unreadable));
    const s = await host!.get('session');
    if (!s) throw new Error('The copy has no session saved.');
    const session = JSON.parse(s) as Session;
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

/** The name Settings → Sign-in shows for this device's saved copy while it's locked. */
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
export function syncNow(opts: { quiet?: boolean } = {}): Promise<void> {
  if (!host) return Promise.resolve();
  if (syncing) return syncing.then(() => syncNow(opts));
  syncing = (async () => {
    try {
      lastSync = Date.now();
      const r = await syncAll(host!, async (since, cursor) => {
        const p = await fetchPage(since, cursor);
        set({ progress: state.progress + p.rows.length });
        return p;
      });
      if (state.why) set({ why: null });
      if (r.rows > 0 || !(await host!.state()).through) await host!.derive();
      if (record) {
        record = { ...record, lastServerTime: Date.now() };
        await save();
      }
      if (r.rows > 0 && !opts.quiet) changed();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function save(): Promise<void> {
  if (!record || !dataKey || !host) return;
  const bytes = await host.export();
  const blob = await sealCopy(record, dataKey, bytes);
  record = { ...record, blob, savedAt: Date.now() };
  await saveRecord(record);
}

// ---------------------------------------------------------------- reads and changes from the app

/** Reads the server still answers itself (everything else is worked out from the copy). */
const SERVER_READS = [
  /^\/api\/session$/,
  /^\/api\/sync(\/|\?|$)/,
  /^\/api\/auth\//,
  /^\/api\/settings\/connections$/,
  /^\/api\/settings\/security/,
  /^\/api\/settings\/rules\/export$/,
  /^\/api\/export\//,
];

export function readsLocally(method: string, path: string): boolean {
  if (state.status !== 'ready' || !host) return false;
  if (method !== 'GET') return false;
  const p = path.split('?')[0]!;
  return !SERVER_READS.some((r) => r.test(p));
}

export async function read(path: string): Promise<{ status: number; body: string }> {
  return host!.request('GET', path);
}

/** After a change on the server: sync it into the copy, then the new Ready to Assign. */
export async function afterChange(): Promise<{ rta: number; rtaUpdating: boolean } | null> {
  if (!host || state.status !== 'ready') return null;
  await syncNow({ quiet: true });
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

// ---- offline edits (docs/phone-budget.md section 12)

const OFFLINE_EDITS: [string, RegExp][] = [
  ['PATCH', /^\/api\/transactions\/[^/]+$/],
  ['POST', /^\/api\/transactions\/categorize$/],
  ['POST', /^\/api\/budget\/(assign|set|move)$/],
  ['PUT', /^\/api\/categories\/[^/]+\/target$/],
];

interface Queued {
  id: string;
  at: number;
  method: string;
  path: string;
  body: unknown;
  appVersion: string;
}

export function canEditOffline(method: string, path: string): boolean {
  return state.status === 'ready' && !!host && OFFLINE_EDITS.some(([m, r]) => m === method && r.test(path));
}

/** A change made with no signal: applied to the copy now, sent to the server when there's a connection. */
export async function editOffline(method: string, path: string, body: unknown): Promise<unknown> {
  const r = await host!.request(method, path, body);
  const json = r.body ? (JSON.parse(r.body) as unknown) : null;
  if (r.status >= 300)
    throw Object.assign(new Error((json as { message?: string })?.message ?? 'Couldn’t save'), {
      code: (json as { error?: string })?.error,
      status: r.status,
    });
  const st = await host!.state();
  const q = await queued();
  q.push({
    id: crypto.randomUUID().replace(/-/g, ''),
    at: Date.now() + st.offset,
    method,
    path,
    body,
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  });
  await host!.put('outbox', JSON.stringify(q));
  set({ queued: q.length });
  await save();
  // The app's own mutation refreshes what it changed (as after an online change).
  return json;
}

declare const __APP_VERSION__: string;

async function queued(): Promise<Queued[]> {
  const s = host ? await host.get('outbox') : null;
  return s ? (JSON.parse(s) as Queued[]) : [];
}

let flushing = false;
/** Sends changes made offline, in order. One the server refuses is dropped and the copy is downloaded again. */
export async function flush(): Promise<{ sent: number; refused: number }> {
  if (!host || flushing || state.offline) return { sent: 0, refused: 0 };
  flushing = true;
  let sent = 0;
  let refused = 0;
  try {
    const q = await queued();
    while (q.length) {
      const e = q[0]!;
      try {
        await server(e.method, e.path, e.body, { 'x-edit-id': e.id, 'x-edit-at': String(e.at) });
        sent++;
      } catch (err) {
        if (!(err as { status?: number }).status) break; // no connection: try again later
        refused++;
      }
      q.shift();
      await host.put('outbox', JSON.stringify(q));
      set({ queued: q.length });
    }
    if (refused) {
      // The copy holds edits the server didn't take: download it again so it shows what the server has.
      await host.clear();
      window.dispatchEvent(new CustomEvent('ledgerline:edits-refused', { detail: refused }));
    }
    if (sent || refused) await syncNow();
  } finally {
    flushing = false;
  }
  return { sent, refused };
}

// ---------------------------------------------------------------- lock, wipe, timers

let lastActive = Date.now();
let hiddenAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function watch(): void {
  if (timer) return;
  const active = () => {
    lastActive = Date.now();
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart', 'scroll'])
    window.addEventListener(ev, active, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      document.documentElement.dataset.covered = '1';
    } else {
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      // Timers don't run while iOS has the app in the background: check before anything is drawn.
      if (away >= LOCK_MS) void lock();
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
      if (Date.now() - lastActive >= LOCK_MS) void lock();
      else if (
        document.visibilityState === 'visible' &&
        !state.offline &&
        Date.now() - lastSync >= SYNC_EVERY_MS
      )
        void syncNow().catch(() => undefined);
    },
    Math.min(SYNC_EVERY_MS, 30_000),
  );
}

/** Drops the keys, the copy in memory and the server session. The saved copy stays, encrypted. */
export async function lock(): Promise<void> {
  if (state.status !== 'ready' && state.status !== 'opening') return;
  if (record && dataKey && host && !state.offline) await save().catch(() => undefined);
  await host?.close();
  host = null;
  dataKey = null;
  record = null;
  pending = null;
  delete document.documentElement.dataset.covered;
  set({ status: state.saved ? 'locked' : 'idle', offline: false, progress: 0 });
  window.dispatchEvent(new Event('ledgerline:locked'));
  await server('POST', '/api/settings/security/sign-out').catch(() => undefined);
}

/** Deletes this person's copy (sign-out, signed out from another device, no longer a member); `all`: every copy. */
export async function wipe(all = false): Promise<void> {
  await host?.close();
  host = null;
  dataKey = null;
  const key = record?.key ?? (who ? recordKey(who.email, who.budgetId) : null);
  record = null;
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
  await wipe(true);
  await server('POST', '/api/settings/security/sign-out', { forget: true, devices });
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
    if (record?.key === rec.key) await wipe();
    else await deleteRecord(rec.key);
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
}
