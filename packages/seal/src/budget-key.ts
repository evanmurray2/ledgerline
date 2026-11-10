// What comes from a budget key (docs/privacy-keys.md section 2): for key version v, the AES-256-GCM keys for entry
// bodies, snapshots and small wrapped values, and the Ed25519 signing pair.
import { type Bytes, concat, isUlid, label, str, u32, zeroize } from './bytes.js';
import { aeadKey } from './aead.js';
import { signPairFromSeed, type SignPair } from './curve.js';
import { hkdf } from './hash.js';

export const BUDGET_KEY_LEN = 32;

export interface BudgetKeys {
  version: number;
  /** Entry bodies. */
  log: CryptoKey;
  /** Snapshot chunks and manifests. */
  snapshot: CryptoKey;
  /** Small wrapped values: slot public halves, inbox private keys, the budget key before this one. */
  wrap: CryptoKey;
  sign: SignPair;
}

/** salt_v = str(budgetId) || u32(v) */
export function keySalt(budgetId: string, version: number): Bytes {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (!Number.isInteger(version) || version < 1) throw new RangeError('key version');
  return concat(str(budgetId), u32(version));
}

/**
 * Everything derived from BK_v. The keys are non-extractable; the caller keeps or zeroes the budget key itself
 * (it is held as bytes only during a key change).
 */
export async function deriveBudgetKeys(
  bk: Uint8Array,
  budgetId: string,
  version: number,
): Promise<BudgetKeys> {
  if (bk.length !== BUDGET_KEY_LEN) throw new RangeError('budget key');
  const salt = keySalt(budgetId, version);
  const raw: Bytes[] = [];
  try {
    for (const name of [
      'ledgerline/v1/log',
      'ledgerline/v1/snapshot',
      'ledgerline/v1/wrap',
      'ledgerline/v1/sign',
    ])
      raw.push(await hkdf(bk, salt, label(name), 32));
    return {
      version,
      log: await aeadKey(raw[0]!),
      snapshot: await aeadKey(raw[1]!),
      wrap: await aeadKey(raw[2]!),
      sign: await signPairFromSeed(raw[3]!),
    };
  } finally {
    zeroize(...raw);
  }
}
