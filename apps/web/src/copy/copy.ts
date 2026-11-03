// The budget's copy on this device (docs/phone-budget.md, decisions.md D-44): every screen is worked out from it by
// the engine in a Web Worker; changes go to the server and come back through the sync. In the Home Screen app with
// a passkey that supports PRF, the copy is saved encrypted (vault.ts) and opens with no signal; anywhere else it's
// kept in memory for the visit only.
//
// Lock (13.4): after 10 idle minutes, or 10 minutes in the background, the keys, the copy and the server session are
// dropped; opening again needs Face ID. Wipe: sign-out, a revoked device, no longer a member, or 7 days offline.
import { useSyncExternalStore } from 'react';
import { CSRF_HEADER, type Session } from '@ledgerline/contracts';
import { EngineHost, syncAll, type EngineIdentity, type SyncPage } from './host';
import { assert, canUsePasskeys, isStandalone, type RequestOptionsJSON } from './passkey';
import {
  type CopyRecord,
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
  error: null,
  queued: 0,
  hasSaved: false,
};
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
  server<SyncPage>('GET', `/api/sync?since=${since}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);

// ---------------------------------------------------------------- sign-in and unlock

/**
 * Passkey sign-in. In the Home Screen app it asks the passkey for its PRF output in the same Face ID prompt, so the
 * copy can be set up or unlocked without a second one.
 */
export async function signIn(): Promise<void> {
  const options = await server<RequestOptionsJSON>('POST', '/api/auth/login/options');
  const saved = isStandalone() ? await lastRecord() : null;
  const salt = saved?.salt ?? randomBytes(32);
  const a = await assert(
    options,
    isStandalone() ? { salt, credentialId: saved?.credentialIdHint ?? null } : undefined,
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
  set({ status: 'opening', error: null, progress: 0, offline: false });
  try {
    const key = recordKey(who.email, who.budgetId);
    let rec = isStandalone() ? await loadRecord(key) : null;
    const p = pending;
    pending = null;
    if (rec) {
      if (!p?.prf) {
        set({ status: 'locked', hasSaved: true });
        return;
      }
      const share = await server<{ share: string }>(
        'POST',
        `/api/settings/security/devices/${rec.deviceId}/share`,
      ).catch(async (e: { code?: string }) => {
        if (e.code === 'revoked') {
          await deleteRecord(key);
          return null;
        }
        throw e;
      });
      if (share) {
        const u = await unlock(rec, p.credentialId, p.prf, fromB64url(share.share)).catch((e: Error) => {
          if (e.message === 'other_passkey') throw new Error('Use the passkey you set this phone up with.');
          throw e;
        });
        rec = { ...u.record, lastServerTime: session ? Date.now() : rec.lastServerTime };
        dataKey = u.dataKey;
        record = rec;
        await openHost(await openCopy(rec, u.dataKey));
      } else rec = null;
    }
    if (!rec) {
      if (isStandalone() && p?.prf) {
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
      }
      await openHost(null);
    }
    await host!.put('session', JSON.stringify(session));
    set({ saved: record !== null, hasSaved: record !== null });
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
export async function unlockWithoutSignal(): Promise<Session> {
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
    dataKey = await unlockOffline(rec, a.credentialId, a.prf).catch((e: Error) => {
      if (e.message === 'offline_expired')
        throw new Error('Connect to the internet to open Ledgerline: it’s been more than 7 days.');
      if (e.message === 'other_passkey') throw new Error('Use the passkey you set this phone up with.');
      throw e;
    });
    record = rec;
    who = rec.who;
    await openHost(await openCopy(rec, dataKey));
    const s = await host!.get('session');
    if (!s) throw new Error('The copy has no session saved.');
    set({ status: 'ready', saved: true, hasSaved: true });
    watch();
    return JSON.parse(s) as Session;
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

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return 'This device';
}

// ---------------------------------------------------------------- sync and save

let syncing: Promise<void> | null = null;

/**
 * Brings the copy up to date with the server, works out the budget again and saves it. Screens are told to read it
 * again, except after the app's own change (`quiet`): its mutation refreshes what it changed itself.
 */
export function syncNow(opts: { quiet?: boolean } = {}): Promise<void> {
  if (!host) return Promise.resolve();
  if (syncing) return syncing.then(() => syncNow(opts));
  syncing = (async () => {
    try {
      const r = await syncAll(host!, async (since, cursor) => {
        const p = await fetchPage(since, cursor);
        set({ progress: state.progress + p.rows.length });
        return p;
      });
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

/** Archiving a category: the amount the phone shows and the change number it was worked out at (D-44). */
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
      else if (document.visibilityState === 'visible' && !state.offline)
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

/** Deletes this person's copy (sign-out, a revoked device, no longer a member). */
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

/** Whether a saved copy exists on this device (for the no-signal screen). */
export async function checkSaved(): Promise<boolean> {
  const has = !MOCK && canUsePasskeys() && isStandalone() && (await lastRecord()) !== null;
  set({ hasSaved: has });
  return has;
}

/** This device's id, when it holds a saved copy (Sign out other devices keeps it on). */
export function currentDeviceId(): string | null {
  return record?.deviceId ?? null;
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
