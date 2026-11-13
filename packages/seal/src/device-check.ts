// The device check (D-116; docs/privacy-keys.md 2 and 5.1): each device works out the budget by itself from the
// same log, so a fault in that work could make two devices show different numbers with no warning. Once a device's
// copy stands at log entry N with nothing of its own waiting, it hashes what its screens show for the month (its
// caller writes that text) and sends an HMAC of the hash, keyed with the budget's check key and bound to the
// budget, the device, N, the month and the key version. The server keeps the latest one per device and can neither
// read nor make one. Another device that stood at the same N and month makes the HMAC from its own hash, under the
// first device's id, and compares: a different one says the two devices worked out different numbers.
import { type Bytes, concat, isUlid, label, str, u32, u64, utf8 } from './bytes.js';
import type { BudgetKeys } from './budget-key.js';
import { hmac, hmacVerify, sha256 } from './hash.js';

export const CHECK_MAC_LEN = 32;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** What one device check states: who, where in the log, which month, and the hash of what it showed. */
export interface CheckFacts {
  budgetId: string;
  deviceId: string;
  /** The log entry the copy stood at. */
  number: number;
  /** `YYYY-MM`. */
  month: string;
  /** SHA-256 of what the screens showed (`checkDigest`). */
  digest: Uint8Array;
}

/** The hash of what a device's screens show, as its caller wrote it out (one canonical text). */
export const checkDigest = (text: string): Promise<Bytes> => sha256(utf8(text));

/** Whether these keys can make a device check: derived keys held from an earlier release have no check key. */
export const canCheck = (keys: BudgetKeys): boolean => !!(keys as Partial<BudgetKeys>).check;

/**
 * "ledgerline/v1/device-check/record" || str(budgetId) || str(deviceId) || u64(number) || str(month) || u32(v)
 * || str(digest)
 */
function input(f: CheckFacts, version: number): Bytes {
  if (!isUlid(f.budgetId) || !isUlid(f.deviceId)) throw new RangeError('device check id');
  if (!MONTH.test(f.month)) throw new RangeError('device check month');
  if (f.digest.length !== 32) throw new RangeError('device check digest');
  return concat(
    label('ledgerline/v1/device-check/record'),
    str(f.budgetId),
    str(f.deviceId),
    u64(f.number),
    str(f.month),
    u32(version),
    str(f.digest),
  );
}

/** The HMAC a device sends for its check, under the check key of `keys`' version. */
export async function checkMac(keys: BudgetKeys, f: CheckFacts): Promise<Bytes> {
  if (!canCheck(keys)) throw new Error('These keys make no device check.');
  return hmac(keys.check, input(f, keys.version));
}

/** Whether `mac` is the HMAC these facts give: another device's check, tried with this device's own hash. */
export async function checkMacSame(keys: BudgetKeys, f: CheckFacts, mac: Uint8Array): Promise<boolean> {
  if (!canCheck(keys) || mac.length !== CHECK_MAC_LEN) return false;
  return hmacVerify(keys.check, input(f, keys.version), mac);
}
