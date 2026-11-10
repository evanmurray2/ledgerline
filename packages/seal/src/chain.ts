// The rules of a budget's log (docs/privacy-keys.md sections 4.4, 6 and 7), as one set of checks that both sides run:
// the server on every append before it stores an entry, and a device on every entry it takes, because the server may
// lie. Since both run the same code, an entry a device would refuse is a refused write, never an entry that sits in
// the log and stops every device for good. Nothing here reads a sealed body.
//
// Not here: the server's rules that need its session (when an intent is required, "bank runs first"), its own time
// bound (an entry's time within 5 minutes of its clock), and the check of a bank entry's receipts against run
// manifests (section 9.3).
import { type Bytes, equal, FormatError } from './bytes.js';
import { OpenError } from './aead.js';
import { type BudgetKeys, deriveBudgetKeys } from './budget-key.js';
import { signPublicKey } from './curve.js';
import { sha256 } from './hash.js';
import {
  encodeHeader,
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

/** The least time between an intent to remove a way in and the key change that does it. */
export const INTENT_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** How far ahead of the checker's clock an entry's time, or a scan date, may be. */
export const CLOCK_SLACK_MS = 10 * 60 * 1000;
/** Intents that are neither cancelled nor carried out, at one time. */
export const MAX_OPEN_INTENTS = 16;
const DAY_MS = 86_400_000;

/** An entry that breaks the log's rules. From the server, it means the server sent what a real log could not hold. */
export class ChainError extends Error {
  constructor(readonly why: string) {
    super(`chain: ${why}`);
  }
}

/** The entry was written by a newer app than this one: update before reading on. */
export class UpdateNeededError extends Error {
  constructor() {
    super('update needed');
  }
}

const fail = (why: string): never => {
  throw new ChainError(why);
};

/** Parses a public body; one that doesn't parse breaks the rules like any other. */
function parse<T>(read: (body: Uint8Array) => T, body: Uint8Array): T {
  try {
    return read(body);
  } catch (e) {
    if (e instanceof FormatError) return fail(`public body: ${e.message}`);
    throw e;
  }
}

/** The entry's hash and body hash, worked out again: an Entry that didn't come from readEntry proves nothing. */
async function checkBound(e: Entry): Promise<void> {
  let header: Bytes;
  try {
    header = encodeHeader(e.header);
  } catch (x) {
    if (x instanceof FormatError || x instanceof RangeError) return fail(`header: ${x.message}`);
    throw x;
  }
  if (!equal(await sha256(header), e.hash)) fail('entry hash');
  if (!equal(await sha256(e.body), e.header.bodyHash)) fail('body hash');
}

interface IntentState {
  hash: Bytes;
  /** The intent entry's own time. */
  time: number;
  notBefore: number;
  slotIds: string[];
}

/** What the public entries say: which keys are in force, and who may open them. */
export interface PublicState {
  budgetId: string;
  genesisSignPub: Bytes;
  keyVersion: number;
  signPub: Bytes;
  /** `signPub`, imported once. */
  signKey: CryptoKey;
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
  /** For an inbox version a key change replaced: the last bank run that may be sealed to it. */
  retiredAt: Map<number, number>;
  /** For each key version v the log has left behind: BK_v wrapped under BK_{v+1}. */
  prevKeys: Map<number, Bytes>;
  /** Intents neither cancelled nor carried out, by entry number. */
  intents: Map<number, IntentState>;
  lastPublic: PublicRef;
  /** Of the last public entry. */
  time: number;
  filedThrough: number;
}

async function startPublic(e: Entry, budgetId?: string): Promise<PublicState> {
  await checkBound(e);
  const h = e.header;
  if (h.kind !== KIND.genesis || h.number !== 1 || h.keyVersion !== 1) fail('not a genesis entry');
  if (budgetId !== undefined && h.budgetId !== budgetId) fail('another budget');
  if (h.filedThrough !== 0 || h.receipts.length !== 0 || h.scanThrough !== 0)
    fail('genesis files and scans nothing');
  const g = parse(readGenesis, e.body);
  if (!(await verifyEntry(e, g.signPub))) fail('signature');
  return {
    budgetId: h.budgetId,
    genesisSignPub: g.signPub,
    keyVersion: 1,
    signPub: g.signPub,
    signKey: await signPublicKey(g.signPub),
    signPubs: new Map([[1, g.signPub]]),
    inboxVersion: 1,
    inboxPub: g.inboxPub,
    lastOldRun: 0,
    slots: new Map(g.slots.map((s) => [s.slotId, s])),
    inboxes: new Map([[1, g.wrappedInbox]]),
    retiredAt: new Map(),
    prevKeys: new Map(),
    intents: new Map(),
    lastPublic: { number: 1, hash: e.hash },
    time: h.time,
    filedThrough: 0,
  };
}

function sameRef(a: PublicRef, b: PublicRef): boolean {
  return a.number === b.number && equal(a.hash, b.hash);
}

async function applyKeyChange(p: PublicState, e: Entry, k: KeyChange): Promise<PublicState> {
  const filed = e.header.filedThrough;
  if (k.version !== p.keyVersion + 1) fail('key version must step by 1');
  if (k.inboxVersion !== p.inboxVersion + 1) fail('inbox version must step by 1');
  if (k.lastOldRun < filed || k.lastOldRun < p.lastOldRun) fail('last old run');
  // The slots that stay: each one in force today, with its anchor unchanged. A key change adds no way in: a new one
  // (a new recovery key too) is added by a slot change first.
  for (const s of k.slots) {
    const old = p.slots.get(s.slotId);
    if (!old) fail('a key change adds no slot');
    else if (!equal(old.anchor, s.anchor)) fail('anchor changed');
  }
  // The inbox keys it carries: the new one; none twice; none the log doesn't hold; and every one that still has
  // unfiled runs, or those runs could never be opened.
  const versions = k.inboxes.map((i) => i.version);
  if (new Set(versions).size !== versions.length) fail('inbox twice');
  if (!versions.includes(k.inboxVersion)) fail('the new inbox key is missing');
  for (const v of versions) if (v !== k.inboxVersion && !p.inboxes.has(v)) fail('unknown inbox');
  const retiredAt = new Map(p.retiredAt).set(p.inboxVersion, k.lastOldRun);
  for (const [v, last] of retiredAt) {
    if (filed >= last) retiredAt.delete(v);
    else if (!versions.includes(v)) fail('an inbox key with unfiled runs is missing');
  }
  // The intent it carries out, if it names one.
  const removed = [...p.slots.keys()].filter((id) => !k.slots.some((s) => s.slotId === id));
  const intents = new Map(p.intents);
  if (k.intent) {
    const it = intents.get(k.intent.number);
    if (!it || !equal(it.hash, k.intent.hash)) return fail('unknown, cancelled or used intent');
    if (it.notBefore < it.time + INTENT_WAIT_MS) fail('intent wait too short');
    if (e.header.time < it.notBefore) fail('intent not yet due');
    if (it.slotIds.length !== removed.length || !removed.every((id) => it.slotIds.includes(id)))
      fail('intent names other slots');
    intents.delete(k.intent.number);
  }
  return {
    ...p,
    keyVersion: k.version,
    signPub: k.signPub,
    signKey: await signPublicKey(k.signPub),
    signPubs: new Map(p.signPubs).set(k.version, k.signPub),
    inboxVersion: k.inboxVersion,
    inboxPub: k.inboxPub,
    lastOldRun: k.lastOldRun,
    slots: new Map(k.slots.map((s) => [s.slotId, s])),
    inboxes: new Map(k.inboxes.map((i) => [i.version, i.wrapped])),
    retiredAt,
    prevKeys: new Map(p.prevKeys).set(p.keyVersion, k.wrappedPrevKey),
    intents,
  };
}

/** Applies one public entry (kinds 4, 5, 9, 10) whose header and signature are already checked. */
async function applyPublic(p: PublicState, e: Entry): Promise<PublicState> {
  const h = e.header;
  if (h.time < p.time || h.filedThrough < p.filedThrough) fail('public entries out of order');
  let next: PublicState;
  if (h.kind === KIND.slotChange) {
    const body = parse(readSlotChange, e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    const slots = new Map(p.slots);
    for (const s of body.slots) {
      if (slots.has(s.slotId)) fail('slot already there');
      slots.set(s.slotId, s);
    }
    if (slots.size > MAX_SLOTS) fail('too many slots');
    next = { ...p, slots };
  } else if (h.kind === KIND.keyChange) {
    const body = parse(readKeyChange, e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    next = await applyKeyChange(p, e, body);
  } else if (h.kind === KIND.intent) {
    // An intent is only recorded here. Whether it waited long enough and names the right slots is judged at the key
    // change that uses it, so an intent written by an honest device with an odd clock can never stop the log.
    const body = parse(readIntent, e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    if (p.intents.size >= MAX_OPEN_INTENTS) fail('too many open intents');
    const intents = new Map(p.intents);
    intents.set(h.number, { hash: e.hash, time: h.time, notBefore: body.notBefore, slotIds: body.slotIds });
    next = { ...p, intents };
  } else if (h.kind === KIND.cancel) {
    const body = parse(readCancel, e.body);
    if (!sameRef(body.prevPublic, p.lastPublic)) fail('previous public entry');
    const it = p.intents.get(body.intent.number);
    if (!it || !equal(it.hash, body.intent.hash)) return fail('unknown, cancelled or used intent');
    const intents = new Map(p.intents);
    intents.delete(body.intent.number);
    next = { ...p, intents };
  } else {
    return fail('not a public entry');
  }
  return {
    ...next,
    lastPublic: { number: h.number, hash: e.hash },
    time: h.time,
    filedThrough: h.filedThrough,
  };
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

/** Where a budget's log stands. */
export interface ChainState {
  public: PublicState;
  /** The last entry taken. */
  number: number;
  hash: Bytes;
  time: number;
  entryId: Bytes;
  filedThrough: number;
  scanThrough: number;
  /** Each device's last counter. */
  counters: Map<string, number>;
  pending: Pending | null;
}

/** What the checker knows that the log can't tell it. */
export interface Checker {
  /** The checker's clock, Unix milliseconds: an entry can't be dated more than 10 minutes after it. */
  now: number;
  /** The newest schema version this app understands; an entry with a newer one throws UpdateNeededError. */
  schemaVersion?: number;
}

/** Starts a chain at the genesis entry. */
export async function startChain(genesis: Entry, c: Checker, budgetId?: string): Promise<ChainState> {
  const h = genesis.header;
  if (c.schemaVersion !== undefined && h.schemaVersion > c.schemaVersion) throw new UpdateNeededError();
  const p = await startPublic(genesis, budgetId);
  if (h.time > c.now + CLOCK_SLACK_MS) fail('dated in the future');
  if (h.deviceCounter !== 1) fail('device counter');
  return {
    public: p,
    number: 1,
    hash: genesis.hash,
    time: h.time,
    entryId: h.entryId,
    filedThrough: 0,
    scanThrough: 0,
    counters: new Map([[h.deviceId, 1]]),
    pending: null,
  };
}

/** True when the log does not end inside a part set: a log that does is a cut-off download, not a shorter log. */
export const isWhole = (s: ChainState): boolean => s.pending === null;

/**
 * Takes the next entry, or throws ChainError (7.2). It checks: that the entry's hashes are its own; the budget;
 * `number` and `prevHash` against the entry before; the signature against the signing key in force, and that
 * `keyVersion` is the version in force; that time moves forward and is not in the checker's future; the writer's
 * counter; that an entry id isn't repeated; the part rules (6.4); `filedThrough`, `receipts` and `scanThrough`; and,
 * for a public entry, its own rules (6.3).
 */
export async function advance(s: ChainState, e: Entry, c: Checker): Promise<ChainState> {
  const h = e.header;
  const p = s.public;
  await checkBound(e);
  if (h.budgetId !== p.budgetId) fail('another budget');
  if (h.number !== s.number + 1 || !equal(h.prevHash, s.hash)) fail('not the next entry');
  if (h.keyVersion !== p.keyVersion) fail('key version not in force');
  if (!(await verifyEntry(e, p.signKey))) fail('signature');
  if (c.schemaVersion !== undefined && h.schemaVersion > c.schemaVersion) throw new UpdateNeededError();
  if (h.time > c.now + CLOCK_SLACK_MS) fail('dated in the future');
  const last = s.counters.get(h.deviceId) ?? 0;
  if (h.deviceCounter !== last + 1) fail('device counter');

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
    if (h.time <= s.time) fail('time must move forward');
    if (equal(h.entryId, s.entryId)) fail('entry id repeated');
    // What this entry files: a bank entry files the next runs, one receipt each; no other kind files any.
    const filed = h.filedThrough - s.filedThrough;
    if (
      h.kind === KIND.bank ? filed < 1 || h.receipts.length !== filed : filed !== 0 || h.receipts.length !== 0
    )
      fail('filed runs');
    // Only a scan moves the scan date, forward, and not past tomorrow by the checker's clock: a date far ahead could
    // never come down again, and would end scanning for good.
    if (h.kind === KIND.scan ? h.scanThrough < s.scanThrough : h.scanThrough !== s.scanThrough)
      fail('scan date');
    if (h.scanThrough > Math.floor((c.now + DAY_MS + CLOCK_SLACK_MS) / DAY_MS))
      fail('scan date in the future');
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
    public: isPublicKind(h.kind) ? await applyPublic(p, e) : p,
    number: h.number,
    hash: e.hash,
    time: h.time,
    entryId: h.entryId,
    filedThrough: h.filedThrough,
    scanThrough: h.scanThrough,
    counters: new Map(s.counters).set(h.deviceId, h.deviceCounter),
    pending,
  };
}

// ---------------------------------------------------------------- a device that holds nothing yet (4.4)

/** What a device already knows about where the public chain must lead. */
export interface WalkBounds {
  /** The last public entry, as the newest snapshot's signed header names it (section 8). The walk must end there. */
  mustEndAt?: PublicRef;
  /** A public entry this device remembers having seen. The walk must pass through it, or the server is hiding a change. */
  mustPass?: PublicRef;
}

/**
 * Walks the public entries alone (kinds 0, 4, 5, 9, 10), in order, as a device with no key does: the genesis entry
 * signs itself; every later one is signed by the signing key of its key version, names the public entry before it,
 * and obeys the same rules as in the whole log. The sealed entries between them are not needed.
 *
 * By itself the walk can't tell that the server cut entries off its end: `mustEndAt` and `mustPass` are how the
 * caller ties it to what it knows.
 */
export async function walkPublic(
  entries: Entry[],
  budgetId: string,
  bounds: WalkBounds = {},
): Promise<PublicState> {
  const [genesis, ...rest] = entries;
  if (!genesis) return fail('no genesis entry');
  let p = await startPublic(genesis, budgetId);
  let passed = bounds.mustPass ? sameRef(bounds.mustPass, p.lastPublic) : true;
  for (const e of rest) {
    await checkBound(e);
    const h = e.header;
    if (!isPublicKind(h.kind) || h.kind === KIND.genesis) fail('not a public entry');
    if (h.budgetId !== p.budgetId) fail('another budget');
    if (h.number <= p.lastPublic.number) fail('public entries out of order');
    if (h.keyVersion !== p.keyVersion) fail('key version not in force');
    if (!(await verifyEntry(e, p.signKey))) fail('signature');
    p = await applyPublic(p, e);
    if (bounds.mustPass && sameRef(bounds.mustPass, p.lastPublic)) passed = true;
  }
  if (!passed) fail('the walk does not pass the public entry this device remembers');
  if (bounds.mustEndAt && !sameRef(bounds.mustEndAt, p.lastPublic))
    fail('the walk does not end where the snapshot says');
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
 * carried (4.4, step 7). Used to read a snapshot or entries sealed before the last key change. Each key that comes
 * out must derive the signing key the chain named for its version.
 */
export async function olderKeys(
  p: PublicState,
  current: { bk: Uint8Array; keys: BudgetKeys },
  version: number,
): Promise<{ bk: Bytes; keys: BudgetKeys }> {
  if (!Number.isInteger(version) || version < 1 || version > p.keyVersion) throw new RangeError('version');
  if (current.keys.version !== p.keyVersion || !equal(current.keys.sign.pub, p.signPub))
    throw new RangeError('not the key in force');
  let bk = new Uint8Array(current.bk) as Bytes;
  let keys = current.keys;
  try {
    while (keys.version > version) {
      const wrapped = p.prevKeys.get(keys.version - 1);
      if (!wrapped) return fail('the log does not carry that key');
      const prev = await unwrapPrevKey(keys, p.budgetId, wrapped);
      bk.fill(0);
      bk = prev;
      keys = await deriveBudgetKeys(bk, p.budgetId, keys.version - 1);
      const named = p.signPubs.get(keys.version);
      if (!named || !equal(named, keys.sign.pub)) fail("the wrapped key is not that version's key");
    }
    return { bk, keys };
  } catch (e) {
    bk.fill(0);
    if (e instanceof OpenError || e instanceof FormatError) return fail('the log does not carry that key');
    throw e;
  }
}
