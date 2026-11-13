// Changes to who can open a budget (docs/privacy.md 5.2; docs/privacy-keys.md 4.2, 5 and 6.3): the public
// entries a device writes to replace the budget key (which is how a way in is removed), to plan such a change
// ahead (an intent, and its cancel), and to make a new recovery key. Each function builds one entry, signed by
// the key in force; the caller sends it to the log, and only what the log took is in force.
//
// No screen, no network, no storage. `keys/budget.ts` makes and opens a budget.
import {
  type Bytes,
  deriveBudgetKeys,
  encodeCancel,
  encodeIntent,
  encodeKeyChange,
  encodeSlotChange,
  type Entry,
  KIND,
  type Kind,
  newInbox,
  newRecoveryKey,
  newSlotRecord,
  publicEntry,
  type PublicRef,
  type PublicState,
  randomBytes,
  recoverySlot,
  resealSlotRecord,
  rewrapInbox,
  showRecoveryKey,
  wrapPrevKey,
} from '@ledgerline/seal';
import { type OpenBudget, PROCESSING_VERSION, SCHEMA_VERSION, WayInError } from './budget';

/** Where the log stands, and this device's own last counter: the next entry goes on top. */
export interface LogPlace {
  number: number;
  hash: Bytes;
  /** The last counter of the device that writes. */
  deviceCounter: number;
  filedThrough: number;
  scanThrough: number;
}

interface Writing {
  state: PublicState;
  budget: OpenBudget;
  deviceId: string;
  at: LogPlace;
  /** The device's clock, as the server's. */
  now: number;
}

const fields = (kind: Kind, w: Writing) => ({
  kind,
  budgetId: w.state.budgetId,
  number: w.at.number + 1,
  prevHash: w.at.hash,
  entryId: randomBytes(16),
  time: w.now,
  deviceId: w.deviceId,
  deviceCounter: w.at.deviceCounter + 1,
  // A public entry is signed by the key in force before it: a key change too.
  keyVersion: w.budget.keys.version,
  schemaVersion: SCHEMA_VERSION,
  processingVersion: PROCESSING_VERSION,
  part: 1,
  parts: 1,
  filedThrough: w.at.filedThrough,
  receipts: [],
  scanThrough: w.at.scanThrough,
});

function inForce(w: Writing): void {
  if (w.budget.keys.version !== w.state.keyVersion) throw new Error('not the key in force');
}

/**
 * A key change: a new budget key, sealed to every way in that stays. A way in left out of `keep` is removed: it
 * can't open anything sealed from here on. The old budget key and the inbox keys that may still have unfiled bank
 * runs travel on, wrapped under the new key. Gives the entry and the budget as it is once the log has taken it.
 *
 * `lastOldRun` is the highest bank run that is complete on the server now (the log refuses any other number).
 * `intent`: the intent this change carries out, when the server asks for one (a change made from a recovery
 * sign-in or a new passkey waits 7 days, D-89).
 */
export async function keyChangeEntry(
  w: Writing & { keep: readonly string[]; lastOldRun: number; intent?: PublicRef | null },
): Promise<{ entry: Entry; next: OpenBudget }> {
  inForce(w);
  const p = w.state;
  const budgetId = p.budgetId;
  if (!w.keep.length) throw new WayInError('A budget needs at least one way in.');
  if (new Set(w.keep).size !== w.keep.length) throw new Error('a way in twice');
  for (const id of w.keep)
    if (!p.slots.has(id)) throw new WayInError('That way in is not part of this budget.');
  const old = w.budget;
  const bk = randomBytes(32);
  const keys = await deriveBudgetKeys(bk, budgetId, old.keys.version + 1);
  const inboxVersion = p.inboxVersion + 1;
  const inbox = await newInbox(keys, budgetId, inboxVersion);
  // The new inbox key, and every older one whose runs a device may still have to open: the one in force until
  // now (runs up to `lastOldRun`), and replaced ones whose last run is not filed yet.
  const inboxes = [{ version: inboxVersion, wrapped: inbox.wrapped }];
  for (const [v, wrapped] of p.inboxes) {
    const lastRun = v === p.inboxVersion ? w.lastOldRun : (p.retiredAt.get(v) ?? 0);
    if (v === p.inboxVersion || lastRun > w.at.filedThrough)
      inboxes.push({ version: v, wrapped: await rewrapInbox(old.keys, keys, budgetId, v, wrapped) });
  }
  const slots = [];
  for (const id of w.keep) slots.push(await resealSlotRecord(p.slots.get(id)!, old.keys, bk, keys, budgetId));
  const entry = await publicEntry(
    fields(KIND.keyChange, w),
    encodeKeyChange({
      prevPublic: p.lastPublic,
      version: keys.version,
      signPub: keys.sign.pub,
      wrappedPrevKey: await wrapPrevKey(old.keys, keys, budgetId, old.bk),
      inboxVersion,
      inboxPub: inbox.pair.pub,
      lastOldRun: w.lastOldRun,
      inboxes,
      slots,
      intent: w.intent ?? null,
    }),
    old.keys,
  );
  return { entry, next: { bk, keys } };
}

/**
 * An intent: this device plans a key change that removes the ways in `remove`, not before `notBefore`. Every
 * device shows it, and any way in that is still listed can cancel it.
 */
export async function intentEntry(
  w: Writing & { remove: readonly string[]; notBefore: number },
): Promise<Entry> {
  inForce(w);
  for (const id of w.remove)
    if (!w.state.slots.has(id)) throw new WayInError('That way in is not part of this budget.');
  return publicEntry(
    fields(KIND.intent, w),
    encodeIntent({ prevPublic: w.state.lastPublic, notBefore: w.notBefore, slotIds: [...w.remove] }),
    w.budget.keys,
  );
}

/** Cancels an intent that is neither carried out nor cancelled. */
export async function cancelEntry(w: Writing & { intent: PublicRef }): Promise<Entry> {
  inForce(w);
  return publicEntry(
    fields(KIND.cancel, w),
    encodeCancel({ prevPublic: w.state.lastPublic, intent: w.intent }),
    w.budget.keys,
  );
}

/**
 * The first of the two entries that make a new recovery key (4.2): a slot change that adds the way in of the
 * next generation. The old recovery key still opens the budget until a key change leaves it out
 * (`keyChangeEntry` with `keep` without `replaces`). The new key is shown once, by the caller.
 */
export async function newRecoveryKeyEntry(
  w: Writing & {
    /** The new key, made (and shown) before the entry is: the person types it back first. Made here if not given. */
    recoveryKey?: Bytes;
  },
): Promise<{ entry: Entry; recoveryKey: Bytes; recoveryText: string; slotId: string; replaces: string[] }> {
  inForce(w);
  const p = w.state;
  const old = [...p.slots.keys()].filter((id) => /^r:[1-9][0-9]*$/.test(id));
  // The next generation after the highest this budget ever listed in force now. A generation is never used twice:
  // the log refuses a slot id that is already there.
  const generation = Math.max(0, ...old.map((id) => Number(id.slice(2)))) + 1;
  const recoveryKey = w.recoveryKey ?? newRecoveryKey();
  const slot = await recoverySlot(recoveryKey, generation);
  const record = await newSlotRecord(slot, w.budget.bk, w.budget.keys, p.budgetId, p.genesisSignPub);
  const entry = await publicEntry(
    fields(KIND.slotChange, w),
    encodeSlotChange({ prevPublic: p.lastPublic, slots: [record] }),
    w.budget.keys,
  );
  return {
    entry,
    recoveryKey,
    recoveryText: await showRecoveryKey(recoveryKey),
    slotId: slot.slotId,
    replaces: old,
  };
}
