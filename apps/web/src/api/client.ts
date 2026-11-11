// Thin fetch wrapper for the Worker API. Same-origin session cookie (passkey sign-in), JSON in and out, every
// response parsed with the shared Zod schema. Mutations carry the CSRF header; the Worker also checks Origin.
import { ApiError as ApiErrorBody, CSRF_HEADER, SYNC_SINCE_HEADER } from '@ledgerline/contracts';
import type { z } from 'zod';
import { connectivity } from '../state/connectivity';
import { budgetTime } from '../lib/dates';
import { clearSavedData } from '../state/saved';
import {
  afterChange,
  archiveFields,
  canEditOffline,
  newEdit,
  closeFields,
  dropSignedOut,
  editOffline,
  read as readCopy,
  readsLocally,
  syncSince,
  wipe,
} from '../copy/copy';
import type { SyncPage } from '../copy/host';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly network: boolean;
  constructor(code: string, message: string, status = 0, network = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.network = network;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const MUTATION_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  [CSRF_HEADER]: '1',
};

const TRY_AGAIN = 'Something went wrong. Try again.';
const OFFLINE = 'You’re offline. Connect to the internet and try again.';
const CHANGED = 'This was changed or removed. Pull down to refresh.';

/** The next reset of Cloudflare's daily limits (midnight UTC), as a clock time in the budget's time zone. */
export function dailyResetTime(now = new Date()): string {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return budgetTime(reset.getTime());
}

/** When changes come back: the session's own time if it gave one, else the next daily reset. */
function viewOnlyUntil(): string {
  const until = connectivity.get().readOnlyUntil;
  return (until && budgetTime(until)) || dailyResetTime();
}

/** Text for an error code, whatever the server said (docs/copy.md, Terms). */
function codeText(code: string): string | null {
  switch (code) {
    case 'offline':
    case 'network':
      return OFFLINE;
    case 'read_only':
    case 'readonly':
      return `View only until ${viewOnlyUntil()}. Try again then.`;
    case 'resting':
    case 'daily_limit':
      return `Paused until ${dailyResetTime()}. Nothing is lost.`;
    case 'unauthorized':
    case 'unauthenticated':
      return 'Sign in again with your passkey.';
    case 'reauth':
      return 'Confirm it’s you with your passkey, then try again.';
    case 'bad_response':
    case 'bad_json':
    case 'csrf':
    case 'internal':
      return TRY_AGAIN;
    default:
      return null;
  }
}

/** Texts written for logs or by the browser, never shown on screen (docs/copy.md rule 7). */
const RAW =
  /json|unexpected response|request failed|failed to fetch|load failed|network|expected .*received|\butc\b|session|database|worker|https?\b|undefined|null|\bapi\b/i;

/** A message that is already a full sentence for the reader: kept as it is. */
function readable(m: unknown): m is string {
  return (
    typeof m === 'string' &&
    m.length <= 240 &&
    /^[A-Z0-9‘“"]/.test(m) &&
    m.includes(' ') &&
    /[.!?]$/.test(m) &&
    !RAW.test(m)
  );
}

/**
 * What to show for any failure: the glossary text for a known code, the server's message when it is a good
 * sentence, else `fallback`. Safe for any value. Use it in toasts: `errorText(e, 'Couldn’t save that. Try again.')`.
 */
export function errorText(err: unknown, fallback: string): string {
  try {
    if (err instanceof ApiError) {
      const byCode = codeText(err.code);
      if (byCode) return byCode;
      if (readable(err.message)) return err.message;
      if (err.code === 'not_found' || err.code === 'changed' || err.code === 'payee_changed') return CHANGED;
      return fallback;
    }
    // fetch() itself failing: the device lost its connection.
    if (err instanceof TypeError && connectivity.isOffline()) return OFFLINE;
    if (err instanceof Error && readable(err.message)) return err.message;
    if (readable(err)) return err;
  } catch {
    // Anything odd (a getter that throws, a revoked proxy): the fallback.
  }
  return fallback;
}

/** errorText() with "Something went wrong. Try again." as the fallback. */
export function errorMessage(err: unknown): string {
  return errorText(err, TRY_AGAIN);
}

// Any answer from the server, even a 401, means the network is back (state/connectivity.ts).
connectivity.setProbe(async () => {
  try {
    await fetch('/api/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    return true;
  } catch {
    return false;
  }
});

let onReadOnly: (() => void) | null = null;
/** Called when the Worker says writes are refused, so the app can refresh the session state. */
export function setReadOnlyHandler(fn: () => void) {
  onReadOnly = fn;
}

// A double tap must not change money twice. The same change (method, path and body) sent again while the first is
// on its way, or within REPEAT_MS after it answered, gets the first one's answer instead of a second request. Only
// the latest change to each path is remembered, so changing something and changing it back is always sent.
// Nothing in the app sends the very same change twice on purpose that fast; sign-in ceremonies are left alone.
const REPEAT_MS = 2_000;
interface Recent {
  body: string;
  promise: Promise<unknown>;
  settledAt: number | null;
}
const recent = new Map<string, Recent>();

export function request<S extends z.ZodType>(
  method: Method,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  if (method === 'GET' || path.startsWith('/api/auth/')) return send(method, path, schema, body);
  const now = Date.now();
  for (const [k, v] of recent) if (v.settledAt !== null && now - v.settledAt > REPEAT_MS) recent.delete(k);
  const key = `${method} ${path}`;
  const bodyKey = JSON.stringify(body ?? null);
  const seen = recent.get(key);
  if (seen && seen.body === bodyKey) return seen.promise as Promise<z.infer<S>>;
  const entry: Recent = { body: bodyKey, promise: Promise.resolve(), settledAt: null };
  entry.promise = send(method, path, schema, body).finally(() => {
    entry.settledAt = Date.now();
  });
  // A failed change can be tried again at once.
  entry.promise.catch(() => {
    if (recent.get(key) === entry) recent.delete(key);
  });
  recent.set(key, entry);
  return entry.promise as Promise<z.infer<S>>;
}

/** Tests only: forget recent changes. */
export function resetRecentChanges(): void {
  recent.clear();
}

// "Confirm it's you" (D-27): a request refused for want of a recent passkey check waits while the app asks for the
// passkey, then is sent once more, so the person doesn't have to do the thing again. Requests refused together share
// one check. Without a dialog (or when the person says Not now) the refusal is thrown as before.
let askForPasskey: (() => Promise<boolean>) | null = null;
let asking: Promise<boolean> | null = null;
/** The "Confirm it's you" dialog registers itself here; it resolves true once the passkey check succeeded. */
export function setPasskeyCheck(fn: (() => Promise<boolean>) | null): void {
  askForPasskey = fn;
}
async function afterPasskeyCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'reauth') || !askForPasskey) throw e;
    asking ??= askForPasskey().finally(() => {
      asking = null;
    });
    if (!(await asking)) throw e;
    return fn();
  }
}

function send<S extends z.ZodType>(
  method: Method,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  return afterPasskeyCheck(() => sendOnce(method, path, schema, body));
}

async function sendOnce<S extends z.ZodType>(
  method: Method,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const mutation = method !== 'GET';
  // Screens are worked out from the copy on this device (D-45, src/copy).
  if (readsLocally(method, path)) return answer(schema, await readCopy(path));
  // Changes made with no signal go to the copy now and to the server later (a short list; copy.ts).
  if (mutation && connectivity.isOffline() && canEditOffline(method, path))
    return schema.parse(
      withRta(await editOffline(method, path, body), await afterChange().catch(() => null)),
    );
  // Archiving sends the amount this phone shows, with the change number it was worked out at.
  const archive = mutation ? /^\/api\/settings\/categories\/([^/]+)\/(archive|remove)$/.exec(path) : null;
  if (archive && (archive[2] === 'remove' || (body as { archived?: boolean } | undefined)?.archived)) {
    const f = await archiveFields(decodeURIComponent(archive[1]!));
    if (f) body = { ...(body as object | undefined), ...f };
  }
  // Closing an account sends the balances this phone shows, with the change number (D-73).
  const close = mutation ? /^\/api\/accounts\/([^/]+)\/close$/.exec(path) : null;
  if (close) {
    const f = await closeFields(decodeURIComponent(close[1]!));
    if (f) body = { ...(body as object | undefined), ...f };
  }
  // Resting (95% of a daily limit): only the session is asked, so the app knows when it's over.
  if (!mutation && connectivity.get().readsPaused && path !== '/api/session')
    throw new ApiError('resting', `Paused until ${dailyResetTime()}. Nothing is lost.`, 503);
  if (mutation && !connectivity.canWrite() && !canEditOffline(method, path)) {
    const code = connectivity.isOffline() ? 'offline' : 'read_only';
    throw new ApiError(code, codeText(code)!);
  }
  // An edit's answer carries the changes since the copy's change number, so no second request syncs them.
  const since = mutation ? await syncSince().catch(() => null) : null;
  // A change that can wait in the queue gets its id and time now, and the server gets both. If the connection
  // drops on the way, the queue sends the same id again, and the server, which may have taken the change before
  // the answer was lost, applies it once (routes/sync.ts editOnce).
  const edit = mutation && canEditOffline(method, path) ? await newEdit().catch(() => null) : null;
  const headers = (): Record<string, string> => ({
    ...MUTATION_HEADERS,
    ...(since === null ? {} : { [SYNC_SINCE_HEADER]: String(since) }),
    ...(edit ? { 'x-edit-id': edit.id, 'x-edit-at': String(edit.at) } : {}),
  });
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: mutation ? headers() : { accept: 'application/json' },
      body: mutation && body !== undefined ? JSON.stringify(body) : mutation ? '{}' : undefined,
    });
  } catch {
    connectivity.reportNetworkError();
    // The connection dropped on the way: an offline-capable change is kept on the phone instead.
    if (mutation && canEditOffline(method, path))
      return schema.parse(
        withRta(
          await editOffline(method, path, body, edit ?? undefined),
          await afterChange().catch(() => null),
        ),
      );
    throw new ApiError('network', OFFLINE, 0, true);
  }
  connectivity.reportOk();
  if (res.status === 204) return schema.parse(undefined);
  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('bad_response', TRY_AGAIN, res.status);
    }
  }
  if (!res.ok) throw failure(res, json, path);
  // The server no longer works out Ready to Assign: fill it from the copy once this change is synced into it.
  // The changes the answer carried (routes/sync.ts syncInAnswer) go into the copy, not to the screen.
  let sync: SyncPage | null = null;
  if (mutation && json && typeof json === 'object' && 'sync' in json) {
    ({ sync, ...json } = json as { sync: SyncPage });
  }
  if (mutation && isAck(json))
    json = withRta(
      json,
      await afterChange(sync && since !== null ? { since, page: sync } : null).catch(() => null),
    );
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('bad_response', TRY_AGAIN, res.status);
  }
  return parsed.data;
}

function isAck(x: unknown): x is { ok: true } {
  return typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === true && !('rta' in x);
}

function withRta(json: unknown, r: { rta: number; rtaUpdating: boolean } | null): unknown {
  return r && typeof json === 'object' && json !== null && !('rta' in json) ? { ...json, ...r } : json;
}

/** A screen answered by the copy, parsed like a server answer. */
function answer<S extends z.ZodType>(schema: S, r: { status: number; body: string }): z.infer<S> {
  const json = r.body ? (JSON.parse(r.body) as unknown) : null;
  if (r.status >= 300) {
    const parsed = ApiErrorBody.safeParse(json);
    throw new ApiError(
      parsed.success ? parsed.data.error : `http_${r.status}`,
      parsed.success ? parsed.data.message : TRY_AGAIN,
      r.status,
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError('bad_response', TRY_AGAIN, r.status);
  return parsed.data;
}

/** The error a failed response stands for, after telling the app (read-only, resting, signed out, passkey check). */
function failure(res: Response, json: unknown, path: string): ApiError {
  const parsed = ApiErrorBody.safeParse(json);
  const code = parsed.success ? parsed.data.error : `http_${res.status}`;
  const message = parsed.success ? parsed.data.message : TRY_AGAIN;
  if (code === 'read_only' || code === 'readonly') onReadOnly?.();
  if (code === 'resting') connectivity.setReadsPaused(true);
  // The session ended (24 hours, or 10 idle minutes): sign in again. The saved copy stays, encrypted (D-45), unless this
  // device was signed out from another one: then it's deleted first. A passkey check ("reauth") is handled by
  // afterPasskeyCheck.
  if (code === 'unauthenticated' && !path.startsWith('/api/auth/')) {
    clearSavedData();
    void dropSignedOut(true).finally(() => window.dispatchEvent(new Event('ledgerline:signedout')));
  }
  // No longer a member of this budget: this phone's copy goes (D-45).
  if (code === 'not_member') void wipe();
  return new ApiError(code, message, res.status);
}

/**
 * Downloads a file from the Worker and saves it on the device. A refusal is thrown like any API error, instead of
 * being saved as the file; the 15-minute passkey check exports need asks for the passkey and then downloads.
 */
export function download(path: string, filename: string): Promise<void> {
  return afterPasskeyCheck(() => downloadOnce(path, filename));
}

async function downloadOnce(path: string, filename: string): Promise<void> {
  if (connectivity.get().readsPaused)
    throw new ApiError('resting', `Paused until ${dailyResetTime()}. Nothing is lost.`, 503);
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    connectivity.reportNetworkError();
    throw new ApiError('network', OFFLINE, 0, true);
  }
  connectivity.reportOk();
  if (!res.ok) {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status alone says what went wrong.
    }
    throw failure(res, json, path);
  }
  saveFile(await res.blob(), filename);
}

/** Saves a file on the device. The link is freed a minute later: Safari on iPhone can drop a download freed at once. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const get = <S extends z.ZodType>(path: string, schema: S) => request('GET', path, schema);
export const post = <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
  request('POST', path, schema, body);
export const put = <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
  request('PUT', path, schema, body);
export const patch = <S extends z.ZodType>(path: string, schema: S, body?: unknown) =>
  request('PATCH', path, schema, body);
export const del = <S extends z.ZodType>(path: string, schema: S) => request('DELETE', path, schema);

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
