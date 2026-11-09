import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/endpoints';
import {
  ApiError,
  download,
  errorMessage,
  errorText,
  resetRecentChanges,
  setPasskeyCheck,
} from '../src/api/client';
import { connectivity } from '../src/state/connectivity';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

beforeEach(() => {
  calls = [];
  resetRecentChanges();
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.setReadsPaused(false);
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
    expect(errorMessage(err)).toMatch(/View only until/);
  });

  it('flags network failures so the app goes view-only', async () => {
    respond = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(api.session()).rejects.toMatchObject({ code: 'network', network: true });
    expect(connectivity.canWrite()).toBe(false);
    expect(connectivity.isOffline()).toBe(true);
  });

  it('after a dropped request, checks again on its own and turns changes back on', async () => {
    vi.useFakeTimers();
    try {
      let down = true;
      respond = () => (down ? Promise.reject(new TypeError('Failed to fetch')) : json(ok));
      await expect(api.session()).rejects.toMatchObject({ code: 'network' });
      expect(connectivity.canWrite()).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connectivity.canWrite()).toBe(false);
      down = false;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectivity.canWrite()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a double tap sends a change once; a different change, or a retry after a failure, is sent', async () => {
    respond = () => json(ok);
    const move = { month: '2026-11', from: 'rta', to: 'dining', amount: 1000 };
    const [a, b] = await Promise.all([api.move(move), api.move(move)]);
    expect(a).toEqual(b);
    await api.move(move);
    expect(calls).toHaveLength(1);
    await api.move({ ...move, amount: 2000 });
    expect(calls).toHaveLength(2);
    respond = () => json({ error: 'conflict', message: 'no' }, 409);
    await expect(api.move({ ...move, amount: 3000 })).rejects.toMatchObject({ code: 'conflict' });
    respond = () => json(ok);
    await api.move({ ...move, amount: 3000 });
    expect(calls).toHaveLength(4);
    // Changing something and changing it back is sent every time.
    await api.patchTxn('uber', { memo: 'a' });
    await api.patchTxn('uber', { memo: 'b' });
    await api.patchTxn('uber', { memo: 'a' });
    expect(calls).toHaveLength(7);
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

  it('while resting, asks only for the session and stops after a resting answer', async () => {
    respond = () => json({ error: 'resting', message: 'resting' }, 503);
    await expect(api.budget('2026-11')).rejects.toMatchObject({ code: 'resting' });
    expect(connectivity.get().readsPaused).toBe(true);
    expect(calls).toHaveLength(1);
    await expect(api.budget('2026-11')).rejects.toMatchObject({ code: 'resting' });
    expect(calls).toHaveLength(1);
    await api.session().catch(() => null);
    expect(calls).toHaveLength(2);
    expect(errorMessage(new ApiError('resting', 'x'))).toMatch(/Paused until/);
    expect(connectivity.staleMs(120_000)).toBe(15 * 60_000);
  });
});

describe('error text', () => {
  it('keeps good sentences and hides raw and technical text', () => {
    const good = 'You have a payee named Lyft. Join them instead.';
    expect(errorMessage(new ApiError('name_taken', good))).toBe(good);
    expect(errorMessage(new ApiError('invalid', 'amount: Expected number, received string'))).toBe(
      'Something went wrong. Try again.',
    );
    expect(errorMessage(new ApiError('not_found', 'category'))).toBe(
      'This was changed or removed. Pull down to refresh.',
    );
    expect(errorMessage(new ApiError('http_502', 'Bad Gateway'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(new Error('Response was not JSON.'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(new SyntaxError('Unexpected token < in JSON at position 0'))).toBe(
      'Something went wrong. Try again.',
    );
    expect(errorText(undefined, 'Couldn’t save that. Try again.')).toBe('Couldn’t save that. Try again.');
    expect(errorText({ message: 42 }, 'Couldn’t save that. Try again.')).toBe(
      'Couldn’t save that. Try again.',
    );
    expect(errorMessage(new ApiError('unauthenticated', 'Sign in with your passkey'))).toBe(
      'Sign in again with your passkey.',
    );
  });
});

describe('passkey check', () => {
  it('sends a change again once the passkey check succeeds, sharing one check between requests', async () => {
    let checked = false;
    respond = (c) =>
      checked || c.url.includes('session')
        ? json({ linkToken: 'link-x' })
        : json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
    const asked = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return (checked = true);
    });
    setPasskeyCheck(asked);
    const [a, b] = await Promise.all([
      api.linkToken({ mode: 'new' }),
      api.deviceLink().catch((e: unknown) => e),
    ]);
    setPasskeyCheck(null);
    expect(a).toEqual({ linkToken: 'link-x' });
    expect(b).toBeDefined();
    expect(asked).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(4);
  });

  it('gives up with the refusal when the person says Not now', async () => {
    respond = () => json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
    setPasskeyCheck(async () => false);
    await expect(api.renamePasskey('pk', 'Mine')).rejects.toMatchObject({ code: 'reauth' });
    setPasskeyCheck(null);
    expect(calls).toHaveLength(1);
  });
});

describe('download', () => {
  it('asks for the passkey check instead of saving the refusal as the file', async () => {
    respond = () => json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
    const asked = vi.fn(async () => false); // Not now
    setPasskeyCheck(asked);
    const save = vi.spyOn(URL, 'createObjectURL');
    const err = await download('/api/export/usage', 'ledgerline-usage.json').catch((e: unknown) => e);
    setPasskeyCheck(null);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('reauth');
    expect(asked).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('downloads by itself once the passkey check succeeds', async () => {
    let checked = false;
    respond = () =>
      checked
        ? json({ events: [], daily: [], notes: [] })
        : json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
    setPasskeyCheck(async () => (checked = true));
    URL.createObjectURL = vi.fn(() => 'blob:usage');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await download('/api/export/usage', 'ledgerline-usage.json');
    setPasskeyCheck(null);
    expect(calls).toHaveLength(2);
    expect(click).toHaveBeenCalledOnce();
  });

  it('saves the file under its name when the export is allowed', async () => {
    respond = () => json({ events: [], daily: [], notes: [] });
    URL.createObjectURL = vi.fn(() => 'blob:usage');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('ledgerline-usage.json');
      expect(this.href).toBe('blob:usage');
    });
    await download('/api/export/usage', 'ledgerline-usage.json');
    expect(click).toHaveBeenCalledOnce();
    expect(calls[0]!.init.credentials).toBe('same-origin');
  });
});
