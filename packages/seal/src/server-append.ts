// The server's own rules for a write to a budget's log (docs/privacy-keys.md 7.2), on top of the rules both sides run
// (chain.ts). They need what only the server has: its clock, its session, the whole log's entry ids, the Worker's
// stored run receipts, and its limits. Nothing here reads a sealed body.
import { type Bytes, FormatError, toHex } from './bytes.js';
import { advance, ChainError, type ChainState, INTENT_WAIT_MS, isWhole, startChain } from './chain.js';
import { type Entry, KIND, readKeyChange } from './entry.js';
import { checkReceipts } from './run.js';

/** An entry's time is within this of the server's clock, either way. It is what makes the 7-day wait real. */
export const SERVER_CLOCK_SLACK_MS = 5 * 60 * 1000;
/** A passkey added less than this long ago is a "fresh" way in: it can't remove another way in without an intent. */
export const FRESH_WAY_MS = INTENT_WAIT_MS;
/** The most entries in one write. */
export const MAX_WRITE_ENTRIES = 1024;

/** Why the server refuses a write. `retry` is true when the same write may pass later, unchanged. */
export type RefusedWhy =
  | 'empty'
  | 'too many entries'
  | 'cut off'
  | 'partly stored'
  | 'clock'
  | 'entry id'
  | 'rules'
  | 'receipts'
  | 'intent needed'
  | 'intent not due'
  | 'bank runs first'
  | 'limit';

export class AppendRefused extends Error {
  constructor(
    readonly why: RefusedWhy,
    /** For 'rules': which rule of the log. */
    readonly detail = '',
  ) {
    super(detail ? `append refused: ${why}: ${detail}` : `append refused: ${why}`);
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
   * (`FRESH_WAY_MS`). Such a session removes a way in only through an intent that has waited.
   */
  freshWay: boolean;
  /** Whether the log already holds an entry with this id. */
  holds(entryId: Uint8Array): Promise<boolean>;
  /** The highest bank run that is complete (signed), filed or not; 0 when none. */
  lastCompleteRun: number;
  /** The `H(receipt)` the Worker stored for runs `from` to `to`, in order; null when one of them is not there. */
  receiptHashes(from: number, to: number): Promise<Uint8Array[] | null>;
  /** True when the breaker rests writes (90% of a daily limit). */
  resting: boolean;
}

/** Kinds the breaker and "bank runs first" never hold back: a lost phone can always be signed out, a passkey removed. */
const NEVER_HELD: readonly number[] = [
  KIND.slotChange,
  KIND.keyChange,
  KIND.signOut,
  KIND.intent,
  KIND.cancel,
];

function checkClock(e: Entry, ctx: AppendContext): void {
  if (Math.abs(e.header.time - ctx.now) > SERVER_CLOCK_SLACK_MS) refuse('clock');
}

/** The first write of a budget: its genesis entry. */
export async function checkGenesisWrite(e: Entry, budgetId: string, ctx: AppendContext): Promise<ChainState> {
  checkClock(e, ctx);
  try {
    return await startChain(e, { now: ctx.now }, budgetId);
  } catch (x) {
    if (x instanceof ChainError) return refuse('rules', x.message);
    throw x;
  }
}

/**
 * Checks one write: all of its entries are stored, or none. Returns the log's new state, or `'already stored'` when
 * the log holds every entry id of the write (a write sent again). Throws AppendRefused.
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

  // A write sent again. The device made its entry ids at random, so one the log holds is the same change.
  const ids = new Map<string, Bytes>();
  for (const e of entries) ids.set(toHex(e.header.entryId), e.header.entryId);
  let held = 0;
  for (const id of ids.values()) if (await ctx.holds(id)) held++;
  if (held === ids.size) return 'already stored';
  if (held > 0) refuse('partly stored');

  let state = s;
  const started = new Set<string>();
  for (const e of entries) {
    const h = e.header;
    const before = state;
    checkClock(e, ctx);
    if (h.part === 1) {
      const id = toHex(h.entryId);
      if (started.has(id)) refuse('entry id');
      started.add(id);
    }
    try {
      state = await advance(before, e, { now: ctx.now });
    } catch (x) {
      if (x instanceof ChainError) return refuse('rules', x.message);
      throw x;
    }

    if (!NEVER_HELD.includes(h.kind) && ctx.resting) refuse('limit');

    // Bank runs first: an edit lands only after every complete run is filed, by this write or an earlier one.
    if (h.kind === KIND.edit && h.filedThrough < ctx.lastCompleteRun) refuse('bank runs first');

    // A bank entry files exactly the next complete runs, and shows the receipt of each: it opened every page.
    if (h.kind === KIND.bank && h.part === 1) {
      if (h.filedThrough > ctx.lastCompleteRun) refuse('receipts');
      const stored = await ctx.receiptHashes(before.filedThrough + 1, h.filedThrough);
      if (!stored || !(await checkReceipts(h.receipts, stored))) refuse('receipts');
    }

    // A key change that removes a way in, from a session that came in a fresh way, needs an intent that has waited.
    // The rules of the log have already judged the intent it names; the server adds its own clock.
    if (h.kind === KIND.keyChange && ctx.freshWay) {
      let k;
      try {
        k = readKeyChange(e.body);
      } catch (x) {
        if (x instanceof FormatError) return refuse('rules', x.message);
        throw x;
      }
      const stays = new Set(k.slots.map((r) => r.slotId));
      const removes = [...before.public.slots.keys()].some((id) => !stays.has(id));
      if (removes) {
        if (!k.intent) return refuse('intent needed');
        const intent = before.public.intents.get(k.intent.number);
        if (!intent || intent.notBefore > ctx.now) refuse('intent not due');
      }
    }
  }
  if (!isWhole(state)) refuse('cut off');
  return state;
}
