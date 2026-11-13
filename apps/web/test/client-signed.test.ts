// A locked budget's signed request (docs/privacy-keys.md 11) refused for its signature, just after another device
// changed the budget's key: the copy reads the log, and the request is signed and sent once more (src/api/client.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  signedHeaders: vi.fn(),
  syncNow: vi.fn(),
}));
vi.mock('../src/copy/copy', async (orig) => ({
  ...(await orig<object>()),
  isSealed: () => true,
  signedHeaders: m.signedHeaders,
  syncNow: m.syncNow,
}));

import { api } from '../src/api/endpoints';
import { ApiError, resetRecentChanges } from '../src/api/client';
import { connectivity } from '../src/state/connectivity';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const UNSIGNED = { error: 'unsigned', message: 'Open your budget on this device, then try again.' };
let answers: Response[] = [];
let sent: Record<string, string>[] = [];

beforeEach(() => {
  resetRecentChanges();
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  sent = [];
  let n = 0;
  m.signedHeaders.mockImplementation(async () => ({ 'x-signed': `sig-${++n}` }));
  m.syncNow.mockResolvedValue(undefined);
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(init?.headers as Record<string, string>);
    return answers.shift() ?? json({ ok: true });
  }) as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

describe('a signed request after another device’s key change', () => {
  it('reads the log, signs again and sends once more', async () => {
    answers = [json(UNSIGNED, 403), json({ ok: true })];
    await expect(api.deleteAccount('Home')).resolves.toMatchObject({ ok: true });
    expect(m.syncNow).toHaveBeenCalledTimes(1);
    expect(sent.map((h) => h['x-signed'])).toEqual(['sig-1', 'sig-2']);
  });

  it('tries only once more: a second refusal is shown', async () => {
    answers = [json(UNSIGNED, 403), json(UNSIGNED, 403)];
    const e = await api.deleteAccount('Home').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('unsigned');
    expect(m.syncNow).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it('does not read the log again for any other refusal', async () => {
    answers = [json({ error: 'not_found', message: 'This was changed or removed.' }, 404)];
    await expect(api.deleteAccount('Home')).rejects.toBeInstanceOf(ApiError);
    expect(sent).toHaveLength(1);
    expect(m.signedHeaders).toHaveBeenCalledTimes(1);
  });
});
