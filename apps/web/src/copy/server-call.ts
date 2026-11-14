// The copy's own calls to the server: plain fetch, so copy.ts and the API client (api/client.ts) don't import each
// other. Split from copy.ts.
import { CSRF_HEADER } from '@ledgerline/contracts';
import { connectivity } from '../state/connectivity';

export async function server<T>(
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
