// A full backup made on the device, sealed with the recovery key (docs/privacy.md 5.8; docs/privacy-keys.md 5):
// the copy's whole database under AES-256-GCM, with a key the recovery key alone gives. The server never sees the
// file. It takes data out; nothing in the app loads it back.
import { aeadKey, aeadOpen, aeadSeal } from './aead.js';
import { type Bytes, concat, equal, FormatError, label, utf8 } from './bytes.js';
import { hkdf } from './hash.js';

/** The first bytes of a sealed backup: what it is, and its version. */
export const BACKUP_MAGIC: Bytes = utf8('LEDGERLINE-BACKUP\n1\n');
const ZERO = new Uint8Array(32);

async function backupKey(r: Uint8Array): Promise<CryptoKey> {
  if (r.length !== 32) throw new RangeError('recovery key');
  const raw = await hkdf(r, ZERO, label('ledgerline/v1/backup'), 32);
  try {
    return await aeadKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** `magic || AEAD(key, aad = magic, plain)`, key = HKDF(R, zero, "ledgerline/v1/backup", 32). */
export async function sealBackup(r: Uint8Array, plain: Uint8Array): Promise<Bytes> {
  return concat(BACKUP_MAGIC, await aeadSeal(await backupKey(r), BACKUP_MAGIC, plain));
}

/** The backup's plain bytes. Throws FormatError for a file that is not one, OpenError for the wrong key. */
export async function openBackup(r: Uint8Array, file: Uint8Array): Promise<Bytes> {
  const head = file.subarray(0, BACKUP_MAGIC.length);
  if (!equal(head, BACKUP_MAGIC)) throw new FormatError('not a sealed backup');
  return aeadOpen(await backupKey(r), BACKUP_MAGIC, file.subarray(BACKUP_MAGIC.length));
}
