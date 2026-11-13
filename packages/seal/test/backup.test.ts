// A full backup sealed with the recovery key (docs/privacy-keys.md 5): it opens with that key only, and its key is
// the HKDF written out by hand with WebCrypto.
import { describe, expect, it } from 'vitest';
import {
  BACKUP_MAGIC,
  FormatError,
  newRecoveryKey,
  OpenError,
  openBackup,
  sealBackup,
  utf8,
} from '../src/index.js';

describe('a backup sealed with the recovery key', () => {
  it('opens with the same key, and with no other', async () => {
    const r = newRecoveryKey();
    const plain = utf8('SQLite format 3\u0000 and a whole budget');
    const file = await sealBackup(r, plain);
    expect(file.subarray(0, BACKUP_MAGIC.length)).toEqual(BACKUP_MAGIC);
    expect(new TextDecoder().decode(file)).not.toContain('whole budget');
    expect(await openBackup(r, file)).toEqual(plain);
    await expect(openBackup(newRecoveryKey(), file)).rejects.toThrow(OpenError);
    const changed = file.slice();
    changed[changed.length - 1]! ^= 1;
    await expect(openBackup(r, changed)).rejects.toThrow(OpenError);
    await expect(openBackup(r, plain)).rejects.toThrow(FormatError);
  });

  it('is sealed under HKDF(R, zero, "ledgerline/v1/backup", 32), with the magic as associated data', async () => {
    const r = newRecoveryKey();
    const file = await sealBackup(r, utf8('budget'));
    const ikm = await crypto.subtle.importKey('raw', r, 'HKDF', false, ['deriveBits']);
    const raw = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode('ledgerline/v1/backup\u0000'),
      },
      ikm,
      256,
    );
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const body = file.subarray(BACKUP_MAGIC.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: body.slice(0, 12), additionalData: BACKUP_MAGIC, tagLength: 128 },
      key,
      body.slice(12),
    );
    expect(new TextDecoder().decode(plain)).toBe('budget');
  });
});
