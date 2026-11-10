import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, parseKeyring, tokenKeyBytes } from '../src/token-crypto.js';
import { ulid } from '../src/ids.js';

const k1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const k2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));

describe('access token encryption (AES-256-GCM, versioned keys)', () => {
  it('round-trips, and decrypts old rows after rotation', async () => {
    const ring1 = parseKeyring(`1:${k1}`, '1');
    const a = await encryptToken(ring1, 'access-sandbox-abc', 'con_1');
    expect(a.keyVersion).toBe(1);
    expect(a.enc).not.toContain('access');
    const ring2 = parseKeyring(`1:${k1},2:${k2}`, '2');
    expect(await decryptToken(ring2, a.enc, 1, 'con_1')).toBe('access-sandbox-abc');
    const b = await encryptToken(ring2, 'access-2', 'con_1');
    expect(b.keyVersion).toBe(2);
    expect(await decryptToken(ring2, b.enc, 2, 'con_1')).toBe('access-2');
  });

  it('fails for another connection id (bound as additional data) or a missing key version', async () => {
    const ring = parseKeyring(`1:${k1}`, '1');
    const a = await encryptToken(ring, 'secret', 'con_1');
    await expect(decryptToken(ring, a.enc, 1, 'con_2')).rejects.toThrow();
    await expect(decryptToken(ring, a.enc, 3, 'con_1')).rejects.toThrow(/version 3/);
  });

  it('accepts a passphrase of 32+ characters as key version 1, with or without the prefix', async () => {
    const pass = 'abcdef-ghijk2-lmNopq-rstuvw-xyz123-ABCdef';
    const a = await encryptToken(parseKeyring(pass, undefined), 'tok', 'con_1');
    expect(a.keyVersion).toBe(1);
    expect(await decryptToken(parseKeyring(`1:${pass}`, '1'), a.enc, 1, 'con_1')).toBe('tok');
    await expect(encryptToken(parseKeyring('too-short', '1'), 'tok', 'con_1')).rejects.toThrow(/32/);
    // An existing base64 key still decrypts as before.
    const b = await encryptToken(parseKeyring(`1:${k1}`, '1'), 'tok', 'con_1');
    expect(await decryptToken(parseKeyring(`1:${k1},2:${pass}`, '2'), b.enc, 1, 'con_1')).toBe('tok');
  });

  it('ULIDs sort by time', () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('the 32 bytes of a keyring entry (docs/privacy-keys.md 9.1)', () => {
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

  it('a base64 key gives its decoded bytes', async () => {
    expect(hex(await tokenKeyBytes(k1))).toBe('01'.repeat(32));
  });

  it('a passphrase gives its SHA-256', async () => {
    const phrase = 'correct horse battery staple, twice over';
    expect(hex(await tokenKeyBytes(phrase))).toBe(
      hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phrase)))),
    );
    // Pinned: the Worker's run-signing key comes from these bytes, and the app is built with its public half.
    expect(hex(await tokenKeyBytes(phrase))).toBe(
      '5e840d5252a9a589f0de5b9c834652a1f320719f295e22745bbd8b58932c6cea',
    );
  });

  it('anything shorter is refused', async () => {
    await expect(tokenKeyBytes('too short')).rejects.toThrow();
  });
});
