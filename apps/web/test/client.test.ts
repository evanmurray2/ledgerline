import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/endpoints';
import { ApiError, errorMessage } from '../src/api/client';
import { connectivity } from '../src/state/connectivity';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = { ok: true, rta: 96365, rtaUpdating: false };

describe('API client', () => {
  it('sends the CSRF header and JSON content type on every mutation', async () => {
    respond = () => json(ok);
    await api.assign({ month: '2026-11', items: [{ categoryId: 'dining', amount: 1825 }] });
    await api.patchTxn('uber', { memo: 'x' });
    await api.setTarget('groceries', { categoryId: 'groceries', month: '2026-11', target: { type: 'none' } });
    await api.deleteTxn('check');
    await api.unlink('zelle');
    for (const c of calls) {
      const h = c.init.headers as Record<string, string>;
      expect(h['x-ledgerline']).toBe('1');
      expect(h['content-type']).toBe('application/json');
      expect(c.init.credentials).toBe('same-origin');
      expect(typeof c.init.body).toBe('string');
    }
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'PATCH', 'PUT', 'DELETE', 'POST']);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      month: '2026-11',
      items: [{ categoryId: 'dining', amount: 1825 }],
    });
  });

  it('sends no CSRF header or body on reads', async () => {
    respond = () => json({ out: 0, items: [], projected: [] });
    await api.owed();
    const c = calls[0]!;
    expect(c.init.method).toBe('GET');
    expect(c.init.credentials).toBe('same-origin');
    expect((c.init.headers as Record<string, string>)['x-ledgerline']).toBeUndefined();
    expect(c.init.body).toBeUndefined();
  });

  it('builds query strings and encodes path segments', async () => {
    respond = () => json({});
    await api.activity('attention', 'uber eats').catch(() => undefined);
    await api.txn('a/b').catch(() => undefined);
    expect(calls[0]!.url).toBe('/api/activity?filter=attention&q=uber+eats');
    expect(calls[1]!.url).toBe('/api/transactions/a%2Fb');
  });

  it('parses responses with the contract schema', async () => {
    respond = () => json({ ok: true, rta: 'lots', rtaUpdating: false });
    await expect(
      api.assign({ month: '2026-11', items: [{ categoryId: 'x', amount: 1 }] }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('maps API errors by code', async () => {
    respond = () => json({ error: 'read_only', message: 'Writes are paused' }, 503);
    const err = await api
      .assign({ month: '2026-11', items: [{ categoryId: 'x', amount: 1 }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'read_only', status: 503 });
    expect(errorMessage(err)).toMatch(/paused/);
  });

  it('flags network failures so the app goes view-only', async () => {
    respond = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(api.session()).rejects.toMatchObject({ code: 'network', network: true });
    expect(connectivity.canWrite()).toBe(false);
    expect(connectivity.isOffline()).toBe(true);
  });

  it('refuses mutations while offline or read-only, without calling the server', async () => {
    respond = () => json(ok);
    connectivity.setOnline(false);
    await expect(
      api.assign({ month: '2026-11', items: [{ categoryId: 'x', amount: 1 }] }),
    ).rejects.toMatchObject({ code: 'offline' });
    connectivity.setOnline(true);
    connectivity.setReadOnly(true, '2026-11-15T00:00:00Z');
    await expect(api.move({ month: '2026-11', from: 'rta', to: 'x', amount: 1 })).rejects.toMatchObject({
      code: 'read_only',
    });
    expect(calls).toHaveLength(0);
  });
});
