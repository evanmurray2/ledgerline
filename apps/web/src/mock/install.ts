// Mock mode (VITE_MOCK=1, dev and tests only): answers every /api request from a November copy worked out by the
// phone's real engine (server.ts), so the SPA runs and is testable without the Worker. `?mock=<scenario>` in the URL picks a starting state (readonly, firstrun,
// empty, syncfail, newmonth). window.__ledgerlineMock lets end-to-end tests inspect and reset it.
import { MockServer, type OpenCopy, type Scenario } from './server';

const SCENARIOS: Scenario[] = ['default', 'firstrun', 'empty', 'readonly', 'resting', 'syncfail', 'newmonth'];

declare global {
  interface Window {
    __ledgerlineMock?: MockServer;
  }
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export function scenarioFromUrl(search: string): Scenario {
  const s = new URLSearchParams(search).get('mock');
  return SCENARIOS.includes(s as Scenario) ? (s as Scenario) : 'default';
}

/** The browser's copy (sql.js's wasm from the bundle); tests in Node pass their own. */
const browserCopy: OpenCopy = async (now) => (await import('#november-browser')).openNovemberCopy(now);

export function installMock(
  scenario: Scenario = 'default',
  delayMs = 40,
  open: OpenCopy = browserCopy,
): MockServer {
  const server = new MockServer(scenario, open);
  const realFetch = globalThis.fetch?.bind(globalThis);
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://mock.local').pathname;
    if (!path.startsWith('/api/')) {
      if (!realFetch) throw new TypeError('fetch unavailable');
      return realFetch(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string' && init.body) body = JSON.parse(init.body);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const res = await server.handle(method, url, headersToRecord(init?.headers), body);
    return new Response(res.status === 204 ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  globalThis.fetch = mockFetch as typeof fetch;
  if (typeof window !== 'undefined') window.__ledgerlineMock = server;
  return server;
}
