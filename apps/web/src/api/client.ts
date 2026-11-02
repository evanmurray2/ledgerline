// Thin fetch wrapper for the Worker API. Same-origin session cookie (passkey sign-in), JSON in and out, every
// response parsed with the shared Zod schema. Mutations carry the CSRF header; the Worker also checks Origin.
import { ApiError as ApiErrorBody, CSRF_HEADER } from '@ledgerline/contracts';
import type { z } from 'zod';
import { connectivity } from '../state/connectivity';
import { clearSavedData } from '../state/saved';

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

/** Error codes the UI maps to friendlier text. Anything else shows the server's message. */
const FRIENDLY: Record<string, string> = {
  offline: 'You’re offline. Changes are turned off until you’re back online.',
  network: 'Couldn’t reach Ledgerline. Check your connection and try again.',
  read_only: 'Changes are paused until the daily limit resets.',
  readonly: 'Changes are paused until the daily limit resets.',
  bad_response: 'Ledgerline sent something unexpected. Try again.',
  unauthorized: 'Your session ended. Sign in again.',
  unauthenticated: 'Your session ended. Sign in again.',
  reauth: 'Confirm it’s you with your passkey, then try again.',
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return FRIENDLY[err.code] ?? err.message;
  return 'Something went wrong. Try again.';
}

let onReadOnly: (() => void) | null = null;
/** Called when the Worker says writes are refused, so the app can refresh the session state. */
export function setReadOnlyHandler(fn: () => void) {
  onReadOnly = fn;
}

export async function request<S extends z.ZodType>(
  method: Method,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  const mutation = method !== 'GET';
  if (mutation && !connectivity.canWrite()) {
    throw new ApiError(
      connectivity.isOffline() ? 'offline' : 'read_only',
      'Changes are turned off right now.',
    );
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: mutation ? { ...MUTATION_HEADERS } : { accept: 'application/json' },
      body: mutation && body !== undefined ? JSON.stringify(body) : mutation ? '{}' : undefined,
    });
  } catch {
    connectivity.reportNetworkError();
    throw new ApiError('network', 'Network request failed', 0, true);
  }
  connectivity.reportOk();
  if (res.status === 204) return schema.parse(undefined);
  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('bad_response', 'Response was not JSON', res.status);
    }
  }
  if (!res.ok) {
    const parsed = ApiErrorBody.safeParse(json);
    const code = parsed.success ? parsed.data.error : `http_${res.status}`;
    const message = parsed.success ? parsed.data.message : res.statusText || 'Request failed';
    if (code === 'read_only' || code === 'readonly' || code === 'moving') onReadOnly?.();
    // Signed out (session ended) or a fresh passkey check is needed: the app shows sign-in or "Confirm it's you".
    if (code === 'unauthenticated' && !path.startsWith('/api/auth/')) {
      clearSavedData();
      window.dispatchEvent(new Event('ledgerline:signedout'));
    }
    if (code === 'reauth') window.dispatchEvent(new Event('ledgerline:reauth'));
    throw new ApiError(code, message, res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError('bad_response', `Unexpected response from ${method} ${path}`, res.status);
  }
  return parsed.data;
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
