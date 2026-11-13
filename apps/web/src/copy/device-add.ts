// Adding a device with its own passkey to a locked budget (docs/privacy.md 5.2; docs/privacy-keys.md section 10),
// both sides, as the app runs them. The arithmetic and the order of the steps are the objects of
// `@ledgerline/seal` (device-add.ts); this moves their messages through the server's relay
// (apps/worker/src/routes/device-add.ts) and waits for the person where section 10 says to.
//
// No screen. The relay, the network and the person's answers are passed in.
import {
  AddError,
  type BudgetKeys,
  type Bytes,
  fromHex,
  NewDevice,
  type PublicRef,
  readEntry,
  SignedInDevice,
  toHex,
  walkPublic,
} from '@ledgerline/seal';
import { fetchPublicEntries, type Fetch } from './sealed';

/** Where the add stands on the server, for this sign-in (GET /api/settings/security/device-add). */
export interface RelayState {
  role: 'from' | 'to' | 'waiting' | null;
  expiresAt?: string;
  offers?: number;
  commit?: string | null;
  reveal?: string | null;
  confirm?: string | null;
  offer?: string | null;
  sealed?: string | null;
}

export type RelayStep = 'commit' | 'offer' | 'reveal' | 'sealed' | 'confirm';

/** The relay's routes (api/endpoints.ts deviceAdd*). */
export interface Relay {
  state(): Promise<RelayState>;
  start(): Promise<unknown>;
  send(step: RelayStep, body: Record<string, string>): Promise<unknown>;
  end(): Promise<unknown>;
}

/**
 * How a side waits for the other: how often it asks, and when it stops (the person left the screen). It asks
 * after `everyMs` first, then half as long again each time nothing changed, up to `maxMs`: a wait of a minute
 * costs about 14 requests, and a longer one 10 a minute (the relay is the Directory, one object for all).
 */
export interface Waiting {
  everyMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
}

const FIRST_MS = 1000;
const MAX_MS = 6000;

/** Shown when the add ended on the server: it expired, the other device cancelled it, or a new one started. */
export const ADD_ENDED = 'This ended. Start again on the device that opens your budget.';
/** Shown on the new device when the budget opened but its passkey could not be added as a way in. */
export const NOT_ADDED =
  'Your budget is open, but this passkey could not be added. Start again on the device that opens your budget.';
/** Shown when the person said the codes are not the same. */
export const NOT_SAME =
  'The codes were not the same, so nothing was added. Start again on the device that opens your budget.';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AddError('cancelled'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AddError('cancelled'));
      },
      { once: true },
    );
  });

/** Asks the relay until `pick` finds what it waits for, less often the longer it waits. The add ending stops it. */
async function until<T>(relay: Relay, pick: (s: RelayState) => T | null, w: Waiting): Promise<T> {
  let every = w.everyMs ?? FIRST_MS;
  for (;;) {
    if (w.signal?.aborted) throw new AddError('cancelled');
    const s = await relay.state();
    if (s.role === null) throw new Error(ADD_ENDED);
    const got = pick(s);
    if (got !== null) return got;
    await sleep(every, w.signal);
    every = Math.min(Math.ceil(every * 1.5), Math.max(w.maxMs ?? MAX_MS, w.everyMs ?? 0));
  }
}

// ---- the signed-in device

export type FromStage = 'waiting' | 'code' | 'sealing' | 'confirming';

/**
 * The signed-in device's side. `ready` runs once the add is started on the server, so the link shown after it
 * signs in a device that may join it. `match` shows the code and resolves when the person answers: true for
 * "They match". `slotIds` reads the ways in the log lists now: the add is done when the new device's confirmation
 * verifies, naming the way in it added, **and** that way in is new in the log (section 10). Another passkey's way
 * in, added meanwhile by any other device, is not this add's. The budget key stays with the caller.
 */
export async function addFromHere(o: {
  relay: Relay;
  budgetId: string;
  keys: BudgetKeys;
  bk: Bytes;
  /** The newest entry this device holds. */
  head: PublicRef;
  slotIds: () => Promise<Set<string>>;
  ready?: () => Promise<void>;
  match: (code: string) => Promise<boolean>;
  onStage?: (s: FromStage) => void;
  wait?: Waiting;
}): Promise<void> {
  const w = o.wait ?? {};
  const before = await o.slotIds();
  const me = new SignedInDevice(o.budgetId, o.keys, o.head);
  await o.relay.start();
  try {
    await o.ready?.();
    o.onStage?.('waiting');
    // An offer for each commitment the new device sends (a new one is a new try there), at most 3.
    let code: string | null = null;
    let answered: string | null = null;
    while (code === null) {
      const commit = await until(o.relay, (s) => (s.commit && s.commit !== answered ? s.commit : null), w);
      answered = commit;
      const offer = me.offer(fromHex(commit), Date.now());
      await o.relay.send('offer', { commit, offer: toHex(offer) });
      const s = await until(o.relay, (x) => (x.reveal || x.commit !== commit ? x : null), w);
      if (s.commit !== commit || !s.reveal) continue;
      code = await me.code(fromHex(s.reveal), Date.now());
    }
    o.onStage?.('code');
    if (!(await o.match(code))) throw new Error(NOT_SAME);
    o.onStage?.('sealing');
    await o.relay.send('sealed', { sealed: toHex(await me.seal(o.bk, Date.now())) });
    o.onStage?.('confirming');
    const confirm = await until(o.relay, (s) => s.confirm ?? null, w);
    const slot = await me.confirmed(o.bk, fromHex(confirm));
    if (!slot || before.has(slot)) throw new Error('The new device could not open your budget. Start again.');
    // The new device's way in, which it adds before it confirms: this one, and no other.
    let every = w.everyMs ?? FIRST_MS;
    for (let i = 0; ; i++) {
      if ((await o.slotIds()).has(slot)) break;
      if (i >= 6) throw new Error('The new device opened your budget, but its passkey is not added yet.');
      await sleep(every, w.signal);
      every = Math.min(every * 2, Math.max(w.maxMs ?? MAX_MS, w.everyMs ?? 0));
    }
  } finally {
    await o.relay.end().catch(() => undefined);
  }
}

// ---- the new device

/** The hash of the log's entry `number`, as the server gives it (GET /api/log). */
async function entryHashAt(fetch: Fetch, number: number): Promise<Uint8Array> {
  const r = await fetch(`/api/log?after=${number - 1}`);
  if (!r.ok) throw new Error('Something went wrong. Try again.');
  const page = (await r.json()) as { entries: string[] };
  const first = page.entries[0];
  if (!first) throw new Error(ADD_ENDED);
  const e = await readEntry(Uint8Array.from(atob(first), (c) => c.charCodeAt(0)));
  if (e.header.number !== number) throw new Error(ADD_ENDED);
  return e.hash;
}

/** One try on the new device, from its commitment to the code it shows. */
export interface JoinTry {
  /** The six digits to compare. */
  code: string;
  /**
   * **Only after the person tapped "They match" on this device**: waits for the sealed budget key, checks the
   * offer against the log, and opens it. Gives the budget key, and the confirmation to send once the budget is
   * open here and this device's passkey is a way in (`confirm`, with its slot id).
   */
  open(): Promise<{ bk: Bytes; confirm: (slotId: string) => Promise<void> }>;
}

/**
 * The new device's side, up to the code. One call is one try: it shows its key for one offer only. A new try is
 * only ever the person's choice ("Try again").
 */
export async function joinFromOther(o: {
  relay: Relay;
  budgetId: string;
  fetch: Fetch;
  wait?: Waiting;
}): Promise<JoinTry> {
  const w = o.wait ?? {};
  const me = await NewDevice.start(o.budgetId);
  await o.relay.send('commit', { commit: toHex(me.commit) });
  const offer = await until(o.relay, (s) => (s.role === 'to' && s.offer ? s.offer : null), w);
  const r = await me.reveal(fromHex(offer));
  await o.relay.send('reveal', { reveal: toHex(r.reveal) });
  return {
    code: r.code,
    open: async () => {
      const sealed = await until(o.relay, (s) => s.sealed ?? null, w);
      // This device's only tie to the real budget: the signing key in force at the end of the public chain, and
      // the entry the offer named, in the log the server gives.
      const state = await walkPublic(await fetchPublicEntries(o.fetch), o.budgetId);
      const headHash = await entryHashAt(o.fetch, r.head.number);
      const opened = await me.open(fromHex(sealed), {
        signPub: state.signPub,
        keyVersion: state.keyVersion,
        headHash,
      });
      return {
        bk: opened.bk,
        confirm: async (slotId: string) => {
          // Only for a way in that is in the log now: the signed-in device looks for exactly this one.
          const now = await walkPublic(await fetchPublicEntries(o.fetch), o.budgetId);
          if (!now.slots.has(slotId)) throw new Error(NOT_ADDED);
          await o.relay.send('confirm', { confirm: toHex(await me.confirm(slotId)) });
        },
      };
    },
  };
}
