// Small values wrapped under a budget key's wrap key (docs/privacy-keys.md section 5): an inbox private key, and the
// budget key before this one.
import { type Bytes, concat, FormatError, isUlid, label, randomBytes, str, u32, zeroize } from './bytes.js';
import { aeadOpen, aeadSeal } from './aead.js';
import { BUDGET_KEY_LEN, type BudgetKeys } from './budget-key.js';
import { type DhPair, dhPairFromSeed } from './curve.js';
import { assertBudgetKey } from './slots.js';

const version = (n: number): number => {
  if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new RangeError('version');
  return n;
};
const budget = (id: string): string => {
  if (!isUlid(id)) throw new RangeError('budget id');
  return id;
};

const inboxAad = (budgetId: string, i: number): Bytes =>
  concat(label('ledgerline/v1/wrap/inbox'), str(budget(budgetId)), u32(version(i)));
const prevKeyAad = (budgetId: string, v: number): Bytes =>
  concat(label('ledgerline/v1/wrap/prev-key'), str(budget(budgetId)), u32(version(v)));

/** A new inbox key pair, version `i`: its private half wrapped for the log, and the pair to use. */
export async function newInbox(
  keys: BudgetKeys,
  budgetId: string,
  i: number,
): Promise<{ pair: DhPair; wrapped: Bytes }> {
  const aad = inboxAad(budgetId, i);
  const seed = randomBytes(32);
  try {
    const pair = await dhPairFromSeed(seed);
    return { pair, wrapped: await aeadSeal(keys.wrap, aad, seed) };
  } finally {
    zeroize(seed);
  }
}

/** The inbox pair `i`, from its wrapped private half. */
export async function openInbox(
  keys: BudgetKeys,
  budgetId: string,
  i: number,
  wrapped: Uint8Array,
): Promise<DhPair> {
  const seed = await aeadOpen(keys.wrap, inboxAad(budgetId, i), wrapped);
  try {
    if (seed.length !== 32) throw new FormatError('inbox key');
    return await dhPairFromSeed(seed);
  } finally {
    zeroize(seed);
  }
}

/**
 * An inbox private half wrapped again under the next key version's wrap key (a key change carries every inbox key
 * that still has unfiled runs).
 */
export async function rewrapInbox(
  oldKeys: BudgetKeys,
  newKeys: BudgetKeys,
  budgetId: string,
  i: number,
  wrapped: Uint8Array,
): Promise<Bytes> {
  if (newKeys.version !== oldKeys.version + 1) throw new RangeError('key version');
  const aad = inboxAad(budgetId, i);
  const seed = await aeadOpen(oldKeys.wrap, aad, wrapped);
  try {
    if (seed.length !== 32) throw new FormatError('inbox key');
    return await aeadSeal(newKeys.wrap, aad, seed);
  } finally {
    zeroize(seed);
  }
}

/**
 * The budget key a key change replaces, wrapped under the new one. Without it a device that joins after the change
 * couldn't read what was sealed before it. It gives a removed way in nothing: that way in already held the older key.
 * `prevBk` must be the key `oldKeys` came from: the wrong 32 bytes here would be found only when a later device
 * could no longer read anything from before the change.
 */
export async function wrapPrevKey(
  oldKeys: BudgetKeys,
  newKeys: BudgetKeys,
  budgetId: string,
  prevBk: Uint8Array,
): Promise<Bytes> {
  if (newKeys.version !== oldKeys.version + 1) throw new RangeError('key version');
  await assertBudgetKey(prevBk, oldKeys, budget(budgetId));
  return aeadSeal(newKeys.wrap, prevKeyAad(budgetId, oldKeys.version), prevBk);
}

/** BK_{v-1}, from the key change to `v`. The caller zeroes it when done. */
export async function unwrapPrevKey(keys: BudgetKeys, budgetId: string, wrapped: Uint8Array): Promise<Bytes> {
  if (keys.version < 2) throw new RangeError('key version');
  const bk = await aeadOpen(keys.wrap, prevKeyAad(budgetId, keys.version - 1), wrapped);
  if (bk.length !== BUDGET_KEY_LEN) {
    zeroize(bk);
    throw new FormatError('budget key');
  }
  return bk;
}
