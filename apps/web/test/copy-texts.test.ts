// A text that used to never show: the passkey's "Use your passkey to continue." (it was read as Cancelled).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assert, passkeyProblem } from '../src/copy/passkey';
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
    // The screens (sign-in, Confirm it's you, the copy, add a device, the recovery key) read it here.
    expect(passkeyProblem(e)).toBe('Use your passkey to continue.');
  });

  it('still reads a refused or stopped passkey as Cancelled', () => {
    const cancelled = 'Cancelled. Try again when you’re ready.';
    expect(passkeyProblem(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBe(cancelled);
    expect(passkeyProblem(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(cancelled);
    expect(passkeyProblem(new Error('other'))).toBeNull();
    expect(passkeyProblem(null)).toBeNull();
  });
});
