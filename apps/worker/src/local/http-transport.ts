// How a device reaches the server's sealed log over HTTP (seal/log-routes.ts): the entries, the bank runs and
// the snapshots, as the session and the snapshot code ask for them (log-session.ts, device-snapshot.ts). Nothing
// here is trusted because the server said it: every byte this hands on is checked by the code that asked.
import type { FreezeStep } from '../seal/cutover.js';
import type { AppendResult } from '../seal/log-store.js';
import type { CutoverTransport } from './cutover-device.js';
import type { SnapshotTransport } from './device-snapshot.js';
import type { StartTransport } from './start-device.js';
import type { LogTransport, RunTransport } from './log-session.js';

/** The server answered in a way that is no answer (not its JSON, or a fault): try again later. */
export class TransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const b64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** The message of a request the server refused because the sign-in ended (the app then shows sign-in). */
export const SIGNED_OUT = 'Your sign-in ended. Sign in again.';
const fault = (status: number): TransportError =>
  new TransportError(status, status === 401 ? SIGNED_OUT : 'The server gave no answer. Try again.');

/** Guards a paged read against a server that says "more" for ever. */
const MAX_PAGES = 10_000;

export type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The transports of one sealed budget. `fetch` is given a path under the app's own origin. */
export function httpTransport(fetch: Fetch): LogTransport & RunTransport & SnapshotTransport {
  const headers = { 'content-type': 'application/json', 'x-ledgerline': '1' };
  const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const r = await fetch(path, init);
    let body: unknown;
    if (r.status === 401) throw fault(401);
    try {
      body = await r.json();
    } catch {
      throw fault(r.status);
    }
    return { status: r.status, body: body as T };
  };
  const get = async <T>(path: string): Promise<T> => {
    const r = await json<T>(path);
    if (r.status !== 200) throw fault(r.status);
    return r.body;
  };
  const bytes = async (path: string): Promise<Uint8Array | null> => {
    const r = await fetch(path);
    if (r.status === 404) return null;
    if (r.status !== 200) throw fault(r.status);
    return new Uint8Array(await r.arrayBuffer());
  };
  /** A write's answer: the store's own (200 or 409), as it gave it. */
  const answer = async <T>(path: string, init: RequestInit): Promise<T> => {
    const r = await json<T>(path, init);
    if (r.status !== 200 && r.status !== 409)
      throw new TransportError(r.status, 'The server gave no answer. Try again.');
    return r.body;
  };
  const post = <T>(path: string, body: unknown): Promise<T> =>
    answer<T>(path, { method: 'POST', headers, body: JSON.stringify(body) });

  /** The entries after `number`: one page (the session asks again from its new place). */
  const after = async (number: number): Promise<Uint8Array[]> => {
    const page = await get<{ entries: string[] }>(`/api/log?after=${number}`);
    return page.entries.map(unb64);
  };

  return {
    after,
    append: (base, entries) =>
      post<AppendResult>('/api/log/append', { base, entries: entries.map((e) => b64(e)) }),

    runs: async (afterRun) => {
      const page = await get<{ runs: { run: number; manifest: string; signature: string; pages: number }[] }>(
        `/api/log/runs?after=${afterRun}`,
      );
      return page.runs.map((r) => ({
        run: r.run,
        manifest: unb64(r.manifest),
        signature: unb64(r.signature),
        pages: r.pages,
      }));
    },
    page: async (run, page) => {
      const b = await bytes(`/api/log/runs/${run}/${page}`);
      // A page the server doesn't give is a page that doesn't open: the run is then refused by its own checks.
      return b ?? new Uint8Array(0);
    },

    list: async () => {
      const r = await get<{
        snapshots: {
          id: string;
          number: number;
          header: string;
          signature: string;
          chunks: number;
          check: { deviceId: string; signature: string } | null;
        }[];
      }>('/api/log/snapshots');
      return r.snapshots.map((s) => ({
        id: s.id,
        number: s.number,
        header: unb64(s.header),
        signature: unb64(s.signature),
        chunks: s.chunks,
        check: s.check ? { deviceId: s.check.deviceId, signature: unb64(s.check.signature) } : null,
      }));
    },
    manifest: (id) => bytes(`/api/log/snapshots/${encodeURIComponent(id)}/manifest`),
    chunk: (id, k) => bytes(`/api/log/snapshots/${encodeURIComponent(id)}/chunks/${k}`),
    begin: (s) =>
      post<{ ok: boolean; why?: string }>('/api/log/snapshots', {
        header: b64(s.header),
        signature: b64(s.signature),
        manifest: b64(s.manifest),
        chunks: s.chunks,
      }),
    put: (id, k, body) =>
      answer<{ ok: boolean; why?: string }>(`/api/log/snapshots/${encodeURIComponent(id)}/chunks/${k}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-ledgerline': '1' },
        body: body as Uint8Array<ArrayBuffer>,
      }),
    check: (id, deviceId, signature, baseId) =>
      post<{ ok: boolean; why?: string }>(`/api/log/snapshots/${encodeURIComponent(id)}/check`, {
        deviceId,
        signature: b64(signature),
        base: baseId,
      }),
    publics: async () => {
      const out: Uint8Array[] = [];
      let from = 0;
      for (let n = 0; ; n++) {
        if (n > MAX_PAGES) throw new TransportError(200, 'The server gave no answer. Try again.');
        const page = await get<{ entries: string[]; last: number; more: boolean }>(
          `/api/log/public?after=${from}`,
        );
        out.push(...page.entries.map(unb64));
        if (!page.more || !page.entries.length) return out;
        from = page.last;
      }
    },
  };
}

/** The cutover's routes (seal/cutover-routes.ts), for the phone's side of it (local/cutover-device.ts). */
export function cutoverTransport(fetch: Fetch): CutoverTransport {
  const headers = { 'content-type': 'application/json', 'x-ledgerline': '1' };
  const call = async <T>(path: string, init: RequestInit): Promise<T> => {
    const r = await fetch(path, init);
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      throw new TransportError(r.status, 'The server gave no answer. Try again.');
    }
    // The store's own answer, a yes or a no with its reason; anything else is a fault.
    if ((r.status !== 200 && r.status !== 409) || typeof (body as { ok?: unknown }).ok !== 'boolean')
      throw new TransportError(
        r.status,
        (body as { message?: string }).message ?? 'The server gave no answer. Try again.',
      );
    return body as T;
  };
  const post = <T>(path: string, body: unknown = {}): Promise<T> =>
    call<T>(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    // The server hashes the budget a few hundred rows a call: asked again until the answer is whole.
    freeze: async () => {
      for (let n = 0; n < 5_000; n++) {
        const r = await post<FreezeStep>('/api/cutover/freeze');
        if (!r.ok || !('more' in r)) return r;
      }
      throw new TransportError(200, 'The server gave no answer. Try again.');
    },
    begin: (s) =>
      post('/api/cutover/begin', {
        genesis: b64(s.genesis),
        header: b64(s.header),
        signature: b64(s.signature),
        manifest: b64(s.manifest),
        chunks: s.chunks,
        tables: s.tables,
      }),
    chunk: (id, k, bytes) =>
      call(`/api/cutover/chunks/${encodeURIComponent(id)}/${k}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-ledgerline': '1' },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
    seal: () => post('/api/cutover/seal'),
  };
}

/** The routes of a new budget's start (seal/start-routes.ts), for the device's side of it (local/start-device.ts). */
export function startTransport(fetch: Fetch): StartTransport {
  const headers = { 'content-type': 'application/json', 'x-ledgerline': '1' };
  const call = async (path: string, init: RequestInit): Promise<{ ok: boolean; why?: string }> => {
    const r = await fetch(path, init);
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      throw new TransportError(r.status, 'The server gave no answer. Try again.');
    }
    // The store's own answer, a yes or a no with its reason; anything else is a fault.
    if ((r.status !== 200 && r.status !== 409) || typeof (body as { ok?: unknown }).ok !== 'boolean')
      throw new TransportError(
        r.status,
        (body as { message?: string }).message ?? 'The server gave no answer. Try again.',
      );
    return body as { ok: boolean; why?: string };
  };
  const post = (path: string, body: unknown = {}) =>
    call(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    begin: (s) =>
      post('/api/start/begin', {
        genesis: b64(s.genesis),
        header: b64(s.header),
        signature: b64(s.signature),
        manifest: b64(s.manifest),
        chunks: s.chunks,
      }),
    chunk: (id, k, bytes) =>
      call(`/api/start/chunks/${encodeURIComponent(id)}/${k}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-ledgerline': '1' },
        body: bytes as Uint8Array<ArrayBuffer>,
      }),
    seal: () => post('/api/start/seal'),
  };
}
