// The full backup of a locked budget, made on the device (docs/privacy.md 5.8): the copy's database, sealed with
// the recovery key the person types (packages/seal backup.ts). The key is read back from what was typed, so a
// slip is caught before anything is saved, and zeroed as soon as the file is sealed.
import { readRecoveryKey, sealBackup } from '@ledgerline/seal';

/** The sealed file, or null when what was typed is not a recovery key. */
export async function sealedBackupFile(typed: string, plain: Uint8Array): Promise<Uint8Array | null> {
  const r = await readRecoveryKey(typed);
  if (!r) return null;
  try {
    return await sealBackup(r, plain);
  } finally {
    r.fill(0);
  }
}
