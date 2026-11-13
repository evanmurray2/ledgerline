// A text that used to never show: the passkey's "Use your passkey to continue." (it was read as Cancelled).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assert } from '../src/copy/passkey';
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
