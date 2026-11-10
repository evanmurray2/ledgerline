// The server's own rules for a write to a budget's log (docs/privacy-keys.md 7.2), on top of the rules both sides run
// (chain.ts). They need what only the server has: its clock, its session, the whole log's entry ids, the Worker's
// stored run receipts, and its limits. Nothing here reads a sealed body.
//
// The caller checks and stores under one lock (a Durable Object's `blockConcurrencyWhile`, or a check of the log's
// last number in the storing transaction): these functions wait on WebCrypto, and two writes checked against the
// same state would both pass and fork the log.
import { type Bytes, equal, FormatError, toHex } from './bytes.js';
import { NONCE_LEN, TAG_LEN } from './aead.js';
import {
  advance,
  ChainError,
  type ChainState,
  INTENT_WAIT_MS,
  isWhole,
  startChain,
  UpdateNeededError,
} from './chain.js';
import { type Entry, KIND, type KeyChange, readKeyChange } from './entry.js';
import { PAD_STEPS } from './pad.js';
import { checkReceipts } from './run.js';
import { readSnapshotHeader } from './snapshot.js';

/** An entry's time is within this of the server's clock, either way. It is what makes the 7-day wait real. */
export const SERVER_CLOCK_SLACK_MS = 5 * 60 * 1000;
/** A passkey added less than this long ago is a "fresh" way in: it changes the key only through an intent that waited. */
export const FRESH_WAY_MS = INTENT_WAIT_MS;
/**
 * The most entries in one write, and so the most parts of one change set. A write is checked in one request, and each
 * entry costs a signature check and two hashes: about 0.2 ms. Measure on Cloudflare before raising it.
 */
export const MAX_WRITE_ENTRIES = 32;
/** The most entries in one write of the kinds no limit holds back (below). */
export const MAX_KEY_ENTRIES_PER_WRITE = 4;
/** A sign-out says nothing but who signs out: its sealed body is the smallest padding step. */
export const SIGN_OUT_BODY_LEN = NONCE_LEN + PAD_STEPS[0]! + TAG_LEN;
const DAY_MS = 86_400_000;

/** Why the server refuses a write. */
export type RefusedWhy =
  | 'empty'
  | 'too many entries'
  | 'cut off'
  | 'partly stored'
  | 'clock'
  | 'entry id'
  | 'rules'
  | 'version'
  | 'too large'
  | 'receipts'
  | 'intent needed'
  | 'intent not due'
  | 'last old run'
  | 'bank runs first'
  | 'limit';

/** Refusals that may pass later for a write made again from the log as it then stands. */
const RETRY: readonly RefusedWhy[] = [
  'partly stored',
  'clock',
  'intent not due',
  'last old run',
  'bank runs first',
  'limit',
];

export class AppendRefused extends Error {
  /** True when the device may try again later: it reads the log, makes the write again and sends it. */
  readonly retry: boolean;
  constructor(
    readonly why: RefusedWhy,
    /** For 'rules': which rule of the log. */
    readonly detail = '',
  ) {
    super(detail ? `append refused: ${why}: ${detail}` : `append refused: ${why}`);
    this.retry = RETRY.includes(why);
  }
}

const refuse = (why: RefusedWhy, detail = ''): never => {
  throw new AppendRefused(why, detail);
};

/** What the server knows when a write arrives. */
export interface AppendContext {
  /** The server's clock, Unix milliseconds. */
  now: number;
  /**
   * True when this session signed in with the recovery key, or with a passkey added less than 7 days ago
   * (`FRESH_WAY_MS`). Such a session changes the key only through an intent that has waited.
   */
  freshWay: boolean;
  /** The newest schema and processing versions the released app writes: an entry with a newer one would stop it. */
  schemaVersion: number;
  processingVersion: number;
  /** The hashes of the entries the log holds under this entry id, in part order; null when it holds none. */
  stored(entryId: Uint8Array): Promise<Uint8Array[] | null>;
  /** The highest bank run that is complete (signed), filed or not; 0 when none. */
  lastCompleteRun: number;
  /** The `H(receipt)` the Worker stored for runs `from` to `to`, in order; null when one of them is not there. */
  receiptHashes(from: number, to: number): Promise<Uint8Array[] | null>;
  /** True when the breaker rests writes (90% of a daily limit). */
  resting: boolean;
  /**
   * How many more entries of the kinds the breaker never holds back this budget may store today. Those kinds have
   * this small count of their own, or they would be a way around every limit.
   */
  keyEntriesLeft: number;
}

/** Kinds the breaker and "bank runs first" never hold back: a lost phone can always be signed out, a passkey removed. */
const NEVER_HELD: readonly number[] = [
  KIND.slotChange,
  KIND.keyChange,
  KIND.signOut,
  KIND.intent,
  KIND.cancel,
];

function checkOwn(e: Entry, ctx: AppendContext): void {
  const h = e.header;
  if (Math.abs(h.time - ctx.now) > SERVER_CLOCK_SLACK_MS) refuse('clock');
  // A version from the future would be stored and then stop every device, for reading too.
  if (h.schemaVersion > ctx.schemaVersion || h.processingVersion > ctx.processingVersion) refuse('version');
  // The scan date is at most tomorrow by the server's clock. A device allows 10 minutes more, for its own clock.
  if (h.scanThrough > Math.floor((ctx.now + DAY_MS) / DAY_MS)) refuse('clock');
}

async function step(s: ChainState, e: Entry, ctx: AppendContext): Promise<ChainState> {
  try {
    return await advance(s, e, { now: ctx.now, schemaVersion: ctx.schemaVersion });
  } catch (x) {
    if (x instanceof ChainError) return refuse('rules', x.message);
    if (x instanceof UpdateNeededError) return refuse('version');
    throw x;
  }
}

/** The first write of a budget: its genesis entry. */
export async function checkGenesisWrite(e: Entry, budgetId: string, ctx: AppendContext): Promise<ChainState> {
  checkOwn(e, ctx);
  try {
    return await startChain(e, { now: ctx.now, schemaVersion: ctx.schemaVersion }, budgetId);
  } catch (x) {
    if (x instanceof ChainError) return refuse('rules', x.message);
    if (x instanceof UpdateNeededError) return refuse('version');
    throw x;
  }
}

/** A write sent again: every entry is in the log already, byte for byte. */
async function alreadyStored(entries: Entry[], ctx: AppendContext): Promise<boolean> {
  const byId = new Map<string, { id: Bytes; hashes: Bytes[] }>();
  for (const e of entries) {
    const key = toHex(e.header.entryId);
    const set = byId.get(key) ?? { id: e.header.entryId, hashes: [] };
    set.hashes.push(e.hash);
    byId.set(key, set);
  }
  let held = 0;
  for (const { id, hashes } of byId.values()) {
    const stored = await ctx.stored(id);
    if (!stored) continue;
    // The id is in the log with other content: this is not the same change, and "stored" would be a false answer.
    if (stored.length !== hashes.length || !stored.every((h, i) => equal(h, hashes[i]!))) refuse('entry id');
    held++;
  }
  if (held === byId.size) return true;
  if (held > 0) refuse('partly stored');
  return false;
}

/**
 * Checks one write: all of its entries are stored, or none. Returns the log's new state, or `'already stored'` when
 * the log holds every entry of the write (a write sent again). Throws AppendRefused.
 *
 * `s` is the state the server stored after the last write; it is never inside a part set.
 */
export async function checkWrite(
  s: ChainState,
  entries: Entry[],
  ctx: AppendContext,
): Promise<ChainState | 'already stored'> {
  if (!isWhole(s)) throw new RangeError('the stored log ends inside a part set');
  if (entries.length < 1) refuse('empty');
  if (entries.length > MAX_WRITE_ENTRIES) refuse('too many entries');
  if (await alreadyStored(entries, ctx)) return 'already stored';

  let state = s;
  let keyEntries = 0;
  const started = new Set<string>();
  for (const e of entries) {
    const h = e.header;
    const before = state;
    checkOwn(e, ctx);
    if (h.part === 1) {
      const id = toHex(h.entryId);
      if (started.has(id)) refuse('entry id');
      started.add(id);
    }
    state = await step(before, e, ctx);

    if (NEVER_HELD.includes(h.kind)) {
      // These pass the breaker, so they have small limits of their own.
      keyEntries++;
      if (keyEntries > MAX_KEY_ENTRIES_PER_WRITE || keyEntries > ctx.keyEntriesLeft) refuse('limit');
      if (h.kind === KIND.signOut && e.body.length !== SIGN_OUT_BODY_LEN) refuse('too large');
    } else if (ctx.resting) refuse('limit');

    // Bank runs first: an edit lands only after every complete run is filed, by this write or an earlier one.
    if (h.kind === KIND.edit && h.filedThrough < ctx.lastCompleteRun) refuse('bank runs first');

    // A bank entry files exactly the next complete runs, and shows the receipt of each: it opened every page.
    if (h.kind === KIND.bank && h.part === 1) {
      if (h.filedThrough > ctx.lastCompleteRun) refuse('receipts');
      const stored = await ctx.receiptHashes(before.filedThrough + 1, h.filedThrough);
      if (!stored || !(await checkReceipts(h.receipts, stored))) refuse('receipts');
    }

    if (h.kind === KIND.keyChange) {
      let k: KeyChange;
      try {
        k = readKeyChange(e.body);
      } catch (x) {
        if (x instanceof FormatError) return refuse('rules', x.message);
        throw x;
      }
      // `lastOldRun` is the last complete run, exactly. Lower, and a waiting run could never be filed, which would
      // hold every edit back for good. Higher, and the replaced inbox key would never retire.
      if (k.lastOldRun !== ctx.lastCompleteRun) refuse('last old run');
      // From a fresh way in, every key change needs an intent that has waited, whatever it seems to remove: the
      // server can't see into a slot's sealed record, so a key change that keeps a slot's id may still lock it out.
      // The rules of the log have already judged the intent it names; the server adds its own clock.
      if (ctx.freshWay) {
        if (!k.intent) return refuse('intent needed');
        const intent = before.public.intents.get(k.intent.number);
        if (!intent || intent.notBefore > ctx.now) refuse('intent not due');
      }
    }
  }
  if (!isWhole(state)) refuse('cut off');
  return state;
}

/**
 * Whether a snapshot may stand where its header says: at this entry of the log, and not inside a part set. The
 * server checks this (with the header's signature) before it stores a snapshot, and keeps that entry for as long as
 * it keeps the snapshot: a device that opens the snapshot starts its chain from it.
 */
export function snapshotStandsAt(header: Uint8Array, e: Entry): boolean {
  let h;
  try {
    h = readSnapshotHeader(header);
  } catch (x) {
    if (x instanceof FormatError) return false;
    throw x;
  }
  return (
    h.budgetId === e.header.budgetId &&
    h.number === e.header.number &&
    equal(h.entryHash, e.hash) &&
    e.header.part === e.header.parts
  );
}
