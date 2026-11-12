import { afterEach, describe, expect, it, vi } from 'vitest';
import { assert } from '../src/copy/passkey';

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;

/** A passkey whose PRF output for an input is that input with every byte + 1. */
function passkey(o: { second?: boolean } = {}) {
  const asked: unknown[] = [];
  const out = (b: ArrayBuffer | undefined) => (b ? new Uint8Array(b).map((x) => x + 1).buffer : undefined);
  vi.stubGlobal('navigator', {
    credentials: {
      get: async (req: {
        publicKey: { extensions?: { prf?: { eval?: { first?: ArrayBuffer; second?: ArrayBuffer } } } };
      }) => {
        const ev = req.publicKey.extensions?.prf?.eval;
        asked.push(ev);
        const authenticatorData = new Uint8Array(37);
        authenticatorData[32] = 0x05;
        return {
          rawId: bytes(16, 9),
          authenticatorAttachment: 'platform',
          response: {
            clientDataJSON: bytes(4, 1),
            authenticatorData: authenticatorData.buffer,
            signature: bytes(8, 2),
            userHandle: null,
          },
          getClientExtensionResults: () => ({
            prf: ev
              ? {
                  results: {
                    first: out(ev.first),
                    ...(o.second === false ? {} : { second: out(ev.second) }),
                  },
                }
              : undefined,
          }),
        };
      },
    },
  });
  return asked;
}
const first = (b: ArrayBuffer | null) => (b ? new Uint8Array(b)[0] : null);

describe('the passkey prompt and its PRF outputs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the copy’s output alone, as before', async () => {
    const asked = passkey();
    const a = await assert({ challenge: 'AAAA' }, { salt: bytes(32, 7) });
    expect(asked).toEqual([{ first: bytes(32, 7) }]);
    expect(first(a.prf)).toBe(8);
    expect(a.slotPrf).toBeNull();
    // Neither output is in what goes to the server.
    expect(JSON.stringify(a.json)).not.toContain('prf');
    expect(a.json.clientExtensionResults).toEqual({});
  });

  it('asks for the way in’s output first and the copy’s second, in one prompt', async () => {
    const asked = passkey();
    const a = await assert({ challenge: 'AAAA' }, { salt: bytes(32, 7), slot: bytes(32, 40) });
    expect(asked).toEqual([{ first: bytes(32, 40), second: bytes(32, 7) }]);
    // The copy's output is the same as when its salt was asked alone.
    expect(first(a.prf)).toBe(8);
    expect(first(a.slotPrf)).toBe(41);
    expect(a.json.clientExtensionResults).toEqual({});
  });

  it('a passkey that gives one output only: the way in has its output, the copy has none', async () => {
    passkey({ second: false });
    const a = await assert({ challenge: 'AAAA' }, { salt: bytes(32, 7), slot: bytes(32, 40) });
    expect(a.prf).toBeNull();
    expect(first(a.slotPrf)).toBe(41);
  });

  it('with no PRF asked, gives none', async () => {
    passkey();
    const a = await assert({ challenge: 'AAAA' });
    expect(a.prf).toBeNull();
    expect(a.slotPrf).toBeNull();
  });
});
