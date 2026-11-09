// Two texts that used to never show: the passkey's "Use your passkey to continue." (it was read as Cancelled) and
// the "Your budget was restored" download reason (nothing set it).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assert } from '../src/copy/passkey';
import { syncAll, type ApplyResult, type EngineHost, type SyncPage } from '../src/copy/host';
import { errorMessage } from '../src/api/client';

afterEach(() => vi.unstubAllGlobals());

describe('passkey without user verification', () => {
  it('says to use the passkey, not Cancelled', async () => {
    const authenticatorData = new Uint8Array(37).buffer; // flags byte 32 is 0: no user verification
    vi.stubGlobal('navigator', {
      credentials: {
        get: async () => ({
          response: { authenticatorData },
          rawId: new Uint8Array([1]).buffer,
          getClientExtensionResults: () => ({}),
        }),
      },
    });
    const e = await assert({ challenge: 'AAAA' }).catch((x: unknown) => x);
    expect((e as Error).name).not.toBe('NotAllowedError');
    expect(errorMessage(e)).toBe('Use your passkey to continue.');
  });
});

describe('syncAll', () => {
  it('reports a reset, so the download can say the budget was restored', async () => {
    const results: ApplyResult[] = [
      { reset: true, rows: 0, caughtUp: false },
      { reset: false, rows: 3, caughtUp: true },
    ];
    const host = {
      nextRequest: async () => ({ since: 0, cursor: null }),
      apply: async () => results.shift()!,
    } as unknown as EngineHost;
    const onReset = vi.fn();
    const r = await syncAll(host, async () => ({}) as SyncPage, onReset);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ pages: 2, rows: 3 });
  });
});
