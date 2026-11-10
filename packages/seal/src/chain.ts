// What a device checks on every entry it takes, and the walk a device with no key makes over the public entries
// (docs/privacy-keys.md sections 4.4, 6 and 7). The server may lie, so a device checks for itself everything the
// server checks: the signature, the key version in force, the chain of hashes, each device's counter, the rules for
// parts, and the rules of the public entries. Nothing here reads a sealed body.
//
// Not here: the server's own rules that need its clock or its session (the 5-minute time bound, "bank runs first",
// when an intent is required), and the check of a bank entry's receipts against run manifests (section 9.3).
import { type Bytes, equal, isUlid } from './bytes.js';
import type { BudgetKeys } from './budget-key.js';
import {
  type Entry,
  isPublicKind,
  KIND,
  type KeyChange,
  type PublicRef,
  readCancel,
  readGenesis,
  readIntent,
  readKeyChange,
  readSlotChange,
  verifyEntry,
} from './entry.js';
import { MAX_SLOTS, openSlotRecord, type SlotRecord, type SlotSecrets } from './slots.js';
import { unwrapPrevKey } from './wrap.js';
import { deriveBudgetKeys } from './budget-key.js';

/** The least time between writing an intent to remove a way in and the key change that does it. */
export const INTENT_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** An entry that breaks the chain's rules: the server sent something a real log could not hold. */
export class ChainError extends Error {
  constructor(readonly why: string) {
    super(`chain: ${why}`);
  }
}

const fail = (why: string): never => {
  throw new ChainError(why);
};

interface IntentState {
  hash: Bytes;
  notBefore: number;
  slotIds: string[];
  /** Cancelled, or carried out by a key change. */
  closed: boolean;
}

/** What the public entries say: which keys are in force, and who may open them. */
export interface PublicState {
  budgetId: string;
  genesisSignPub: Bytes;
  keyVersion: number;
  signPub: Bytes;
  /** The signing public key of every key version so far. */
  signPubs: Map<number, Bytes>;
  inboxVersion: number;
  inboxPub: Bytes;
  /** The highest bank run that existed at the last key change; 0 before any. */
  lastOldRun: number;
  /** The slots in force, by id, each with its newest record. */
  slots: Map<string, SlotRecord>;
  /** The wrapped inbox private keys the log carries, by inbox version. */
  inboxes: Map<number, Bytes>;
  /** For each key version v the log has left behind: BK_v wrapped under BK_{v+1}. */
  prevKeys: Map<number, Bytes>;
  intents: Map<number, IntentState>;
  lastPublic: PublicRef;
}

async function startPublic(e: Entry): Promise<PublicState> {
  const h = e.header;
  if (h.kind !== KIND.genesis || h.number !== 1 || h.keyVersion !== 1) fail('not a genesis entry');
  if (h.filedThrough !== 0 || h.receipts.length !== 0) fail('genesis files no bank run');
  const g = readGenesis(e.body);
  if (!(await verifyEntry(e, g.signPub))) fail('signature');
  return {
    budgetId: h.budgetId,
    genesisSignPub: g.signPub,
    keyVersion: 1,
    signPub: g.signPub,
    signPubs: new Map([[1, g.signPub]]),
    inboxVersion: 1,
    inboxPub: g.inboxPub,
    lastOldRun: 0,
    slots: new Map(g.slots.map((s) => [s.slotId, s])),
    inboxes: new Map([[1, g.wrappedInbox]]),
    prevKeys: new Map(),
    intents: new Map(),
    lastPublic: { number: 1, hash: e.hash },
  };
}

function sameRef(a: PublicRef, b: PublicRef): boolean {
  return a.number === b.number && equal(a.hash, b.hash);
}

function applyKeyChange(p: PublicState, e: Entry, k: KeyChange, filedThrough: number | null): PublicState {
  if (k.version !== p.keyVersion + 1) fail('key version must step by 1');
  if (k.inboxVersion !== p.inboxVersion + 1) fail('inbox version must step by 1');
  if (filedThrough !== null && k.lastOldRun < filedThrough) fail('last old run');
  if (k.lastOldRun < p.lastOldRun) fail('last old run');
  // The slots that stay: each one in force today, with its anchor unchanged. A key change adds no way in.
  for (const s of k.slots) {
    const old = p.slots.get(s.slotId);
    if (!old) fail('a key change adds no slot');
    else if (!equal(old.anchor, s.anchor)) fail('anchor changed');
  }
  // The inbox keys it carries: the new one, and older ones the log already holds; none twice.
  const versions = k.inboxes.map((i) => i.version);
  if (new Set(versions).size !== versions.length) fail('inbox twice');
  if (!versions.includes(k.inboxVersion)) fail('the new inbox key is missing');
  for (const v of versions) if (v !== k.inboxVersion && !p.inboxes.has(v)) fail('unknown inbox');
  // The intent it carries out, if it names one.
  const removed = [...p.slots.keys()].filter((id) => !k.slots.some((s) => s.slotId === id));
  const intents = new Map(p.intents);
  if (k.intent) {
    const it = intents.get(k.intent.number);
    if (!it || !equal(it.hash, k.intent.hash)) fail('unknown intent');
    else {
      if (it.closed) fail('intent cancelled or used');
      if (e.header.time < it.notBefore) fail('intent not yet due');
      if (it.slotIds.length !== removed.length || !removed.every((id) => it.slotIds.includes(id)))
        fail('intent names other slots');
      intents.set(k.intent.number, { ...it, closed: true });
    }
  }
  return {
    ...p,
    keyVersion: k.version,
    signPub: k.signPub,
    signPubs: new Map(p.signPubs).set(k.version, k.signPub),
    inboxVersion: k.inboxVersion,
    inboxPub: k.inboxPub,
    lastOldRun: k.lastOldRun,
    slots: new Map(k.slots.map((s) => [s.slotId, s])),
    inboxes: new Map(k.inboxes.map((i) => [i.version, i.wrapped])),
    prevKeys: new Map(p.prevKeys).set(p.keyVersion, k.wrappedPrevKey),
    intents,
  };
}

/** Applies one public entry (kinds 4, 5, 9, 10) whose header and signature are already checked. */
function applyPublic(p: PublicState, e: Entry, filedThrough: number | null): PublicState {
  const h = e.header;
  const here: PublicRef = { number: h.number, hash: e.hash };
  let next: PublicState;
  if (h.kind === KIND.slotChange) {
    const body = readSlotChange(e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    const slots = new Map(p.slots);
    for (const s of body.slots) {
      if (slots.has(s.slotId)) fail('slot already there');
      slots.set(s.slotId, s);
    }
    if (slots.size > MAX_SLOTS) fail('too many slots');
    next = { ...p, slots };
  } else if (h.kind === KIND.keyChange) {
    const body = readKeyChange(e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    next = applyKeyChange(p, e, body, filedThrough);
  } else if (h.kind === KIND.intent) {
    const body = readIntent(e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    if (!body.slotIds.every((id) => p.slots.has(id))) fail('intent names an unknown slot');
    if (body.notBefore < h.time + INTENT_WAIT_MS) fail('intent wait too short');
    const intents = new Map(p.intents);
    intents.set(h.number, { hash: e.hash, notBefore: body.notBefore, slotIds: body.slotIds, closed: false });
    next = { ...p, intents };
  } else if (h.kind === KIND.cancel) {
    const body = readCancel(e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    const it = p.intents.get(body.intent.number);
    if (!it || !equal(it.hash, body.intent.hash)) return fail('unknown intent');
    if (it.closed) fail('intent cancelled or used');
    const intents = new Map(p.intents);
    intents.set(body.intent.number, { ...it, closed: true });
    next = { ...p, intents };
  } else {
    return fail('not a public entry');
  }
  return { ...next, lastPublic: here };
}

// ---------------------------------------------------------------- the whole log, entry by entry

/** A part set that has started and not finished. */
interface Pending {
  entryId: Bytes;
  kind: number;
  deviceId: string;
  keyVersion: number;
  time: number;
  filedThrough: number;
  scanThrough: number;
  parts: number;
  /** The part expected next. */
  next: number;
}

/** Where a device stands in a budget's log. */
export interface ChainState {
  public: PublicState;
  /** The last entry taken. */
  number: number;
  hash: Bytes;
  time: number;
  filedThrough: number;
  scanThrough: number;
  /** Each device's last counter. */
  counters: Map<string, number>;
  /** True while every entry since the genesis entry has been seen, so a new device's counter must be 1. */
  fromGenesis: boolean;
  pending: Pending | null;
}

/** Starts a chain at the genesis entry. */
export async function startChain(genesis: Entry): Promise<ChainState> {
  const p = await startPublic(genesis);
  const h = genesis.header;
  if (h.deviceCounter !== 1) fail('device counter');
  return {
    public: p,
    number: 1,
    hash: genesis.hash,
    time: h.time,
    filedThrough: 0,
    scanThrough: h.scanThrough,
    counters: new Map([[h.deviceId, 1]]),
    fromGenesis: true,
    pending: null,
  };
}

/** True when the log does not end inside a part set: a log that does is a cut-off download, not a shorter log. */
export const isWhole = (s: ChainState): boolean => s.pending === null;

/**
 * Takes the next entry, or throws ChainError. Checks (7.2): the budget; `number` and `prevHash` against the entry
 * before; the signature against the signing key in force, and that `keyVersion` is the version in force; that time
 * doesn't run backwards; the writer's counter; the part rules (6.4); `filedThrough`, `receipts` and `scanThrough`;
 * and, for a public entry, its own rules (6.3).
 */
export async function advance(s: ChainState, e: Entry): Promise<ChainState> {
  const h = e.header;
  const p = s.public;
  if (h.budgetId !== p.budgetId) fail('another budget');
  if (h.number !== s.number + 1 || !equal(h.prevHash, s.hash)) fail('not the next entry');
  if (h.keyVersion !== p.keyVersion) fail('key version not in force');
  if (!(await verifyEntry(e, p.signPub))) fail('signature');
  if (h.time < s.time) fail('time runs backwards');
  if (!isUlid(h.deviceId)) fail('device id');
  const last = s.counters.get(h.deviceId);
  if (last === undefined ? s.fromGenesis && h.deviceCounter !== 1 : h.deviceCounter !== last + 1)
    fail('device counter');
  if (h.scanThrough < s.scanThrough) fail('scan date goes down');

  // Parts: a set is consecutive entries that agree on everything but their part number and counter.
  let pending: Pending | null = null;
  if (s.pending) {
    const q = s.pending;
    if (
      h.part !== q.next ||
      h.parts !== q.parts ||
      h.kind !== q.kind ||
      h.deviceId !== q.deviceId ||
      h.keyVersion !== q.keyVersion ||
      h.time !== q.time ||
      h.filedThrough !== q.filedThrough ||
      h.scanThrough !== q.scanThrough ||
      !equal(h.entryId, q.entryId)
    )
      fail('part set broken');
    if (h.receipts.length !== 0) fail('receipts belong in part 1');
    pending = h.part < h.parts ? { ...q, next: q.next + 1 } : null;
  } else {
    if (h.part !== 1) fail('part set starts at part 1');
    // What this entry files: a bank entry files the next runs, one receipt each; no other kind files any.
    const filed = h.filedThrough - s.filedThrough;
    if (
      h.kind === KIND.bank ? filed < 1 || h.receipts.length !== filed : filed !== 0 || h.receipts.length !== 0
    )
      fail('filed runs');
    if (h.parts > 1)
      pending = {
        entryId: h.entryId,
        kind: h.kind,
        deviceId: h.deviceId,
        keyVersion: h.keyVersion,
        time: h.time,
        filedThrough: h.filedThrough,
        scanThrough: h.scanThrough,
        parts: h.parts,
        next: 2,
      };
  }

  return {
    public: isPublicKind(h.kind) ? applyPublic(p, e, s.filedThrough) : p,
    number: h.number,
    hash: e.hash,
    time: h.time,
    filedThrough: h.filedThrough,
    scanThrough: h.scanThrough,
    counters: new Map(s.counters).set(h.deviceId, h.deviceCounter),
    fromGenesis: s.fromGenesis,
    pending,
  };
}

// ---------------------------------------------------------------- a device that holds nothing yet (4.4)

/**
 * Walks the public entries alone (kinds 0, 4, 5, 9, 10), in order, as a device with no key does: the genesis entry
 * signs itself; every later one is signed by the signing key of its key version, names the public entry before it,
 * and obeys the same rules as in the whole log. The sealed entries between them are not needed.
 */
export async function walkPublic(entries: Entry[]): Promise<PublicState> {
  const [genesis, ...rest] = entries;
  if (!genesis) return fail('no genesis entry');
  let p = await startPublic(genesis);
  for (const e of rest) {
    const h = e.header;
    if (!isPublicKind(h.kind) || h.kind === KIND.genesis) fail('not a public entry');
    if (h.budgetId !== p.budgetId) fail('another budget');
    if (h.number <= p.lastPublic.number) fail('public entries out of order');
    if (h.keyVersion !== p.keyVersion) fail('key version not in force');
    if (!(await verifyEntry(e, p.signPub))) fail('signature');
    p = applyPublic(p, e, null);
  }
  return p;
}

/**
 * Opens a budget with one way in, from the public entries (4.4, steps 4 to 6): the newest record for this slot among
 * the entries of the last key version; its anchor against the first signing key; then the sealed key, which must
 * derive the signing key the chain names. The caller zeroes `bk` when done.
 */
export async function openBudget(
  p: PublicState,
  slot: SlotSecrets,
): Promise<{ bk: Bytes; keys: BudgetKeys }> {
  const record = p.slots.get(slot.slotId);
  if (!record) return fail('this way in was removed, or was never part of this budget');
  return openSlotRecord(slot, record, p.budgetId, p.keyVersion, p.genesisSignPub, p.signPub);
}

/**
 * The keys of an older key version, walking back from the one in force through the budget keys each key change
 * carried (4.4, step 7). Used to read a snapshot or entries sealed before the last key change.
 */
export async function olderKeys(
  p: PublicState,
  current: { bk: Uint8Array; keys: BudgetKeys },
  version: number,
): Promise<{ bk: Bytes; keys: BudgetKeys }> {
  if (!Number.isInteger(version) || version < 1 || version > current.keys.version)
    throw new RangeError('version');
  let bk = new Uint8Array(current.bk) as Bytes;
  let keys = current.keys;
  while (keys.version > version) {
    const wrapped = p.prevKeys.get(keys.version - 1);
    if (!wrapped) return fail('the log does not carry that key');
    const prev = await unwrapPrevKey(keys, p.budgetId, wrapped);
    bk.fill(0);
    bk = prev;
    keys = await deriveBudgetKeys(bk, p.budgetId, keys.version - 1);
    // The key must be the one the chain named for that version.
    const named = p.signPubs.get(keys.version);
    if (!named || !equal(named, keys.sign.pub)) {
      bk.fill(0);
      return fail("the wrapped key is not that version's key");
    }
  }
  return { bk, keys };
}
