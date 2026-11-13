// The budget's keys on a device (docs/privacy.md 5.2; docs/privacy-keys.md 2 and 4): making them when a budget
// is made, and getting them back through a way in (a passkey, or the recovery key). Everything here is the
// arithmetic of `@ledgerline/seal` put in the order a device does it; no screen, no network, no storage.
//
// A device makes a key only for a budget it is making. For a budget that exists, the key comes out of the log's
// public entries, through one way in, and only after that way in's own check (its anchor) says the budget is
// the one it was made for.
import {
  type BudgetKeys,
  type Bytes,
  deriveBudgetKeys,
  encodeGenesis,
  encodeSlotChange,
  type Entry,
  equal,
  KIND,
  newInbox,
  newRecoveryKey,
  newSlotRecord,
  olderKeys,
  openBudget,
  passkeySlot,
  prfInput,
  publicEntry,
  type PublicRef,
  type PublicState,
  randomBytes,
  readRecoveryKey,
  recoverySlot,
  showRecoveryKey,
  type SlotSecrets,
  walkPublic,
  zeroize,
} from '@ledgerline/seal';

/** What a passkey gives at sign-in: its id, and its PRF output for `slotPrfInput()`. */
export interface PasskeySecret {
  credentialId: Uint8Array;
  prf: Uint8Array;
}

/** The one PRF input every sign-in sends first, for the whole app (4.1). */
export const slotPrfInput = (): Promise<Bytes> => prfInput();

/** The entry versions this app writes. */
export const SCHEMA_VERSION = 1;
export const PROCESSING_VERSION = 1;

/** An open budget: its key and the keys derived from it. `bk` is zeroed by whoever holds it last. */
export interface OpenBudget {
  bk: Bytes;
  keys: BudgetKeys;
}

/** A way in that does not open this budget. The message says which case it is, in words for a person. */
export class WayInError extends Error {}

/** A typed recovery key whose check letters don't match: refused before anything else. */
export const KEY_TYPO = 'That recovery key has a typing mistake. Check it and try again.';

/**
 * The passkey just used is no way in to this budget: it was made after the budget was locked (a recovery, or a
 * new passkey that did not reach this budget yet), or it was removed. The recovery key opens it (4.4).
 */
export class NoSlotError extends WayInError {
  constructor() {
    super('This passkey can’t open your budget yet. Open it with your recovery key.');
  }
}

/**
 * Makes a budget's keys and its first entry: the budget key, the passkey's way in, a new recovery key and its way
 * in, and the inbox pair. Before anything is handed back, both ways in are opened from the entry's own bytes, as
 * a device that holds nothing would open them: an entry that can't be opened is never sent.
 *
 * The recovery key is shown once, by the caller; this hands back its bytes and its text and keeps neither.
 */
export async function createBudget(o: {
  budgetId: string;
  deviceId: string;
  passkey: PasskeySecret;
  /** The device's clock, as the server's. */
  now: number;
}): Promise<{ budget: OpenBudget; genesis: Entry; recoveryKey: Bytes; recoveryText: string }> {
  const bk = randomBytes(32);
  const keys = await deriveBudgetKeys(bk, o.budgetId, 1);
  const recoveryKey = newRecoveryKey();
  const passkey = await passkeySlot(o.passkey.prf, o.budgetId, o.passkey.credentialId);
  const recovery = await recoverySlot(recoveryKey, 1);
  const inbox = await newInbox(keys, o.budgetId, 1);
  const signPub = keys.sign.pub;
  const genesis = await publicEntry(
    {
      kind: KIND.genesis,
      budgetId: o.budgetId,
      number: 1,
      prevHash: new Uint8Array(32) as Bytes,
      entryId: randomBytes(16),
      time: o.now,
      deviceId: o.deviceId,
      deviceCounter: 1,
      keyVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      processingVersion: PROCESSING_VERSION,
      part: 1,
      parts: 1,
      filedThrough: 0,
      receipts: [],
      scanThrough: 0,
    },
    encodeGenesis({
      signPub,
      inboxPub: inbox.pair.pub,
      wrappedInbox: inbox.wrapped,
      slots: [
        await newSlotRecord(passkey, bk, keys, o.budgetId, signPub),
        await newSlotRecord(recovery, bk, keys, o.budgetId, signPub),
      ],
    }),
    keys,
  );
  // Both ways in open the key, from the entry as it will be stored.
  for (const slot of [passkey, recovery]) {
    const opened = await openFrom([genesis], o.budgetId, slot);
    const same = equal(opened.budget.bk, bk);
    zeroize(opened.budget.bk);
    if (!same) throw new Error('a way in does not open the budget key');
  }
  return { budget: { bk, keys }, genesis, recoveryKey, recoveryText: await showRecoveryKey(recoveryKey) };
}

/** Walks the public entries and opens the budget with one way in (4.4, steps 3 to 6). */
async function openFrom(
  publics: Entry[],
  budgetId: string,
  slot: SlotSecrets,
  remembered?: PublicRef,
): Promise<{ budget: OpenBudget; state: PublicState }> {
  const state = await walkPublic(publics, budgetId, remembered ? { mustPass: remembered } : {});
  return { budget: await openBudget(state, slot), state };
}

/**
 * Opens a budget with a passkey, from the log's public entries. `remembered`: a public entry this device saw
 * before; the entries must pass through it, or the server is hiding a change.
 */
export async function openWithPasskey(
  publics: Entry[],
  budgetId: string,
  passkey: PasskeySecret,
  remembered?: PublicRef,
): Promise<{ budget: OpenBudget; state: PublicState }> {
  const slot = await passkeySlot(passkey.prf, budgetId, passkey.credentialId);
  const state = await walkPublic(publics, budgetId, remembered ? { mustPass: remembered } : {});
  if (!state.slots.has(slot.slotId)) throw new NoSlotError();
  return { budget: await openBudget(state, slot), state };
}

/**
 * Opens a budget with the recovery key as the person typed it. A key with a typing slip is refused before
 * anything else (`WayInError`). The key's generation is the one the log lists: a recovery key that was replaced
 * opens nothing.
 */
export async function openWithRecoveryKey(
  publics: Entry[],
  budgetId: string,
  typed: string,
  remembered?: PublicRef,
): Promise<{ budget: OpenBudget; state: PublicState }> {
  const r = await readRecoveryKey(typed);
  if (!r) throw new WayInError(KEY_TYPO);
  try {
    const state = await walkPublic(publics, budgetId, remembered ? { mustPass: remembered } : {});
    const generations = [...state.slots.keys()]
      .filter((id) => /^r:[1-9][0-9]*$/.test(id))
      .map((id) => Number(id.slice(2)))
      .sort((a, b) => b - a);
    if (!generations.length) throw new WayInError('This budget has no recovery key.');
    for (const g of generations) {
      try {
        return { budget: await openBudget(state, await recoverySlot(r, g)), state };
      } catch {
        // Another generation may be this key.
      }
    }
    throw new WayInError('That recovery key doesn’t open this budget. Check it and try again.');
  } finally {
    zeroize(r);
  }
}

/**
 * Opens a budget with its key itself, sealed to this device by a device that holds it (docs/privacy-keys.md
 * section 10), which checked the offer against the log already. The key must be the key of the signing key in
 * force at the end of the public chain.
 */
export async function openWithBudgetKey(
  publics: Entry[],
  budgetId: string,
  bk: Bytes,
  remembered?: PublicRef,
): Promise<{ budget: OpenBudget; state: PublicState }> {
  const state = await walkPublic(publics, budgetId, remembered ? { mustPass: remembered } : {});
  const keys = await deriveBudgetKeys(bk, budgetId, state.keyVersion);
  if (!equal(keys.sign.pub, state.signPub))
    throw new WayInError('Your budget changed meanwhile. Start again on the device that opens it.');
  return { budget: { bk, keys }, state };
}

/**
 * The budget's keys of every version from 1 to the one in force: what a device needs to read a snapshot or
 * entries sealed before a key change. The older budget keys themselves are zeroed here; their derived keys stay.
 */
export async function keysOfEveryVersion(state: PublicState, budget: OpenBudget): Promise<BudgetKeys[]> {
  const out: BudgetKeys[] = [];
  for (let v = 1; v < budget.keys.version; v++) {
    const older = await olderKeys(state, budget, v);
    zeroize(older.bk);
    out.push(older.keys);
  }
  out.push(budget.keys);
  return out;
}

/**
 * The entry that adds a passkey as a way in: a slot change, written by a device that holds the budget key, with
 * the new passkey's secret at hand (the same device, right after the passkey was made and asked once more for
 * its PRF output). `at` is where the log stands; the entry goes on top of it.
 */
export async function addPasskeyEntry(o: {
  state: PublicState;
  budget: OpenBudget;
  passkey: PasskeySecret;
  deviceId: string;
  at: { number: number; hash: Bytes; deviceCounter: number; filedThrough: number; scanThrough: number };
  now: number;
}): Promise<Entry> {
  const { state, budget } = o;
  const slot = await passkeySlot(o.passkey.prf, state.budgetId, o.passkey.credentialId);
  if (state.slots.has(slot.slotId)) throw new WayInError('This passkey is already a way in to this budget.');
  const record = await newSlotRecord(slot, budget.bk, budget.keys, state.budgetId, state.genesisSignPub);
  return publicEntry(
    {
      kind: KIND.slotChange,
      budgetId: state.budgetId,
      number: o.at.number + 1,
      prevHash: o.at.hash,
      entryId: randomBytes(16),
      time: o.now,
      deviceId: o.deviceId,
      deviceCounter: o.at.deviceCounter + 1,
      keyVersion: budget.keys.version,
      schemaVersion: SCHEMA_VERSION,
      processingVersion: PROCESSING_VERSION,
      part: 1,
      parts: 1,
      filedThrough: o.at.filedThrough,
      receipts: [],
      scanThrough: o.at.scanThrough,
    },
    encodeSlotChange({ prevPublic: state.lastPublic, slots: [record] }),
    budget.keys,
  );
}
