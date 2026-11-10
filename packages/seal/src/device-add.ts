// Adding a device with its own passkey (docs/privacy-keys.md section 10). The new device N holds nothing; the
// signed-in device O holds the budget key. The server relays every message, so the two devices agree on a six-digit
// code that the person compares, and the budget key crosses only after the person has confirmed it on O.
//
// The order of the steps is what keeps the server to one guess in a million, so each side is an object that allows
// each step once, in order: N shows its key for one offer only; O makes an offer only for a commitment it holds, and
// at most three per start.
import {
  type Bytes,
  concat,
  equal,
  FormatError,
  isUlid,
  label,
  randomBytes,
  Reader,
  str,
  u32,
  u64,
  zeroize,
} from './bytes.js';
import { OpenError } from './aead.js';
import { BUDGET_KEY_LEN, type BudgetKeys, deriveBudgetKeys } from './budget-key.js';
import { dh, type DhPair, dhPairFromSeed, WeakKeyError } from './curve.js';
import type { PublicRef } from './entry.js';
import { hkdf, hmac, hmacVerify, sha256 } from './hash.js';
import * as hpke from './hpke.js';
import { assertBudgetKey } from './slots.js';

/** O makes at most this many offers per start; then the person starts again. */
export const ADD_ATTEMPTS = 3;
/** One offer lasts this long. */
export const ADD_WINDOW_MS = 10 * 60 * 1000;
export const ADD_COMMIT_LEN = 32;
export const ADD_OFFER_LEN = 32 + 32 + 4 + 8 + 32;
export const ADD_REVEAL_LEN = 64;
export const ADD_SEALED_LEN = hpke.sealedLength(BUDGET_KEY_LEN);
export const ADD_CONFIRM_LEN = 32;

const ZERO32 = new Uint8Array(32);

/** An add that must stop. Nothing is kept; the person starts again. */
export class AddError extends Error {
  constructor(readonly why: string) {
    super(`add a device: ${why}`);
  }
}

/** What O tells N about the budget, before N shows its key. */
export interface AddOffer {
  nonce: Bytes;
  signPub: Bytes;
  version: number;
  /** The newest entry O holds. */
  head: PublicRef;
}

export function encodeOffer(o: AddOffer): Bytes {
  if (o.nonce.length !== 32 || o.signPub.length !== 32 || o.head.hash.length !== 32)
    throw new RangeError('offer');
  if (!Number.isInteger(o.version) || o.version < 1 || o.version > 0xffffffff)
    throw new RangeError('key version');
  if (!Number.isSafeInteger(o.head.number) || o.head.number < 1) throw new RangeError('head');
  return concat(o.nonce, o.signPub, u32(o.version), u64(o.head.number), o.head.hash);
}

export function readOffer(bytes: Uint8Array): AddOffer {
  const r = new Reader(bytes);
  const nonce = r.take(32);
  const signPub = r.take(32);
  const version = r.u32();
  const number = r.u64();
  const hash = r.take(32);
  r.end();
  if (version < 1) throw new FormatError('key version');
  if (number < 1) throw new FormatError('head');
  return { nonce, signPub, version, head: { number, hash } };
}

const commitOf = (reveal: Uint8Array): Promise<Bytes> =>
  sha256(concat(label('ledgerline/v1/add/commit'), reveal));

interface Transcript {
  transcript: Bytes;
  code: string;
  addPub: Bytes;
  offer: AddOffer;
}

/** The transcript and its six-digit code, from the three messages. */
async function transcriptOf(
  budgetId: string,
  commit: Uint8Array,
  offer: AddOffer,
  reveal: Uint8Array,
): Promise<Transcript> {
  const addPub = reveal.slice(0, 32) as Bytes;
  const nonceN = reveal.slice(32) as Bytes;
  const transcript = await sha256(
    concat(
      label('ledgerline/v1/add/transcript'),
      commit,
      offer.nonce,
      addPub,
      nonceN,
      str(budgetId),
      offer.signPub,
      u32(offer.version),
      u64(offer.head.number),
      offer.head.hash,
    ),
  );
  const four = await hkdf(transcript, ZERO32, label('ledgerline/v1/add/code'), 4);
  const n = new DataView(four.buffer).getUint32(0) % 1_000_000;
  return { transcript, code: String(n).padStart(6, '0'), addPub, offer };
}

const addInfo = (transcript: Uint8Array): Bytes => concat(label('ledgerline/v1/hpke/device-add'), transcript);

const confirmKey = (bk: Uint8Array, transcript: Uint8Array): Promise<Bytes> =>
  hkdf(bk, transcript, label('ledgerline/v1/add/confirm'), 32);

/** What N has checked on the public chain it walked (4.4) and in the log it was given. */
export interface WalkedLog {
  /** The signing key and key version in force at the end of the public chain. */
  signPub: Uint8Array;
  keyVersion: number;
  /** The hash of the entry at the offer's head number, in the log N was given and checked. */
  headHash: Uint8Array;
}

/**
 * The new device's side. One object is one try: it shows its key for one offer, and opens one sealed key. A new try
 * starts only when the person asks for one; the app never starts one by itself.
 */
export class NewDevice {
  readonly #budgetId: string;
  readonly #pair: DhPair;
  readonly #reveal: Bytes;
  /** The commitment that goes to O first. */
  readonly commit: Bytes;
  #t: Transcript | null = null;
  #step: 'start' | 'revealed' | 'over' = 'start';

  private constructor(budgetId: string, pair: DhPair, reveal: Bytes, commit: Bytes) {
    this.#budgetId = budgetId;
    this.#pair = pair;
    this.#reveal = reveal;
    this.commit = commit;
  }

  /** Step 1: a one-time key pair and a nonce, and the commitment to both. */
  static async start(budgetId: string): Promise<NewDevice> {
    if (!isUlid(budgetId)) throw new RangeError('budget id');
    const seed = randomBytes(32);
    try {
      const pair = await dhPairFromSeed(seed);
      const reveal = concat(pair.pub, randomBytes(32));
      return new NewDevice(budgetId, pair, reveal, await commitOf(reveal));
    } finally {
      zeroize(seed);
    }
  }

  /**
   * Step 3: takes O's offer and shows what was committed to. Once only: a second offer would let the server choose
   * its nonce after it has seen this device's, and so choose the code.
   */
  async reveal(offer: Uint8Array): Promise<{ reveal: Bytes; code: string; head: PublicRef }> {
    if (this.#step !== 'start') throw new AddError('this try has already answered an offer');
    this.#step = 'revealed';
    let o: AddOffer;
    try {
      o = readOffer(offer);
    } catch (e) {
      this.#step = 'over';
      if (e instanceof FormatError) throw new AddError('offer');
      throw e;
    }
    this.#t = await transcriptOf(this.#budgetId, this.commit, o, this.#reveal);
    return { reveal: this.#reveal.slice() as Bytes, code: this.#t.code, head: o.head };
  }

  /**
   * Step 5, **only after the person tapped "the codes match" on this device too**: opens the budget key. It is
   * refused unless it is the key of the signing key the offer named, and the offer agrees with the log this device
   * was given: the signing key and version in force at the end of the public chain it walked, and the entry at the
   * offer's head. Without that, a removed device or a server could hand over an old key or an older log. Once only.
   */
  async open(sealed: Uint8Array, log: WalkedLog): Promise<{ bk: Bytes; keys: BudgetKeys; confirm: Bytes }> {
    const t = this.#t;
    if (this.#step !== 'revealed' || !t) throw new AddError('this try is over');
    this.#step = 'over';
    if (sealed.length !== ADD_SEALED_LEN) throw new AddError('sealed key');
    if (
      t.offer.version !== log.keyVersion ||
      !equal(t.offer.signPub, log.signPub) ||
      !equal(t.offer.head.hash, log.headHash)
    )
      throw new AddError('the offer does not agree with the log');
    let bk: Bytes;
    try {
      bk = await hpke.open(this.#pair, addInfo(t.transcript), t.offer.signPub, sealed);
    } catch (e) {
      if (e instanceof OpenError) throw new AddError('the sealed key does not open');
      throw e;
    }
    let ok = false;
    try {
      if (bk.length !== BUDGET_KEY_LEN) throw new AddError('budget key');
      const keys = await deriveBudgetKeys(bk, this.#budgetId, t.offer.version);
      if (!equal(keys.sign.pub, t.offer.signPub))
        throw new AddError('not the key of the signing key it named');
      const k = await confirmKey(bk, t.transcript);
      try {
        const confirm = await hmac(k, t.transcript);
        ok = true;
        return { bk, keys, confirm };
      } finally {
        zeroize(k);
      }
    } finally {
      if (!ok) zeroize(bk);
    }
  }
}

/**
 * The signed-in device's side, for one start by the person. It makes at most three offers, each for a commitment it
 * already holds; an offer takes one reveal, within 10 minutes; a reveal gives the code; and the key is sealed once.
 */
export class SignedInDevice {
  readonly #budgetId: string;
  readonly #keys: BudgetKeys;
  readonly #head: PublicRef;
  #offers = 0;
  #live: { commit: Bytes; offer: AddOffer; at: number } | null = null;
  #t: Transcript | null = null;
  #sealed = false;
  #until = 0;

  constructor(budgetId: string, keys: BudgetKeys, head: PublicRef) {
    if (!isUlid(budgetId)) throw new RangeError('budget id');
    this.#budgetId = budgetId;
    this.#keys = keys;
    this.#head = { number: head.number, hash: head.hash.slice() as Bytes };
  }

  /**
   * Step 2: answers a commitment with a fresh nonce and the budget's signing key and head. Every offer counts, shown
   * to the person or not: a server that drops offers until one suits it gets three, not as many as it likes. A new
   * offer ends the one before.
   */
  offer(commit: Uint8Array, now: number): Bytes {
    if (commit.length !== ADD_COMMIT_LEN) throw new AddError('commitment');
    if (this.#sealed) throw new AddError('this start is over');
    if (this.#offers >= ADD_ATTEMPTS) throw new AddError('too many tries');
    this.#offers++;
    const offer: AddOffer = {
      nonce: randomBytes(32),
      signPub: this.#keys.sign.pub,
      version: this.#keys.version,
      head: this.#head,
    };
    this.#live = { commit: commit.slice() as Bytes, offer, at: now };
    this.#t = null;
    return encodeOffer(offer);
  }

  /**
   * Step 4: takes N's reveal for the offer in force and gives the code to show. One reveal per offer. A reveal that
   * doesn't match the commitment stops the try: the server tried to change the key after it saw this device's nonce.
   */
  async code(reveal: Uint8Array, now: number): Promise<string> {
    const live = this.#live;
    this.#live = null;
    if (!live) throw new AddError('no offer waits for a reveal');
    if (now < live.at || now - live.at > ADD_WINDOW_MS) throw new AddError('too late');
    if (reveal.length !== ADD_REVEAL_LEN) throw new AddError('reveal');
    if (!equal(await commitOf(reveal), live.commit))
      throw new AddError('the reveal does not match the commitment');
    // A small-order key would make a shared secret anyone can work out. Refused before a code is shown.
    const seed = randomBytes(32);
    try {
      zeroize(await dh((await dhPairFromSeed(seed)).privateKey, reveal.slice(0, 32)));
    } catch (e) {
      if (e instanceof WeakKeyError) throw new AddError('weak key');
      throw e;
    } finally {
      zeroize(seed);
    }
    const t = await transcriptOf(this.#budgetId, live.commit, live.offer, reveal);
    this.#t = t;
    this.#until = live.at + ADD_WINDOW_MS;
    return t.code;
  }

  /**
   * Step 4b, **only after the person tapped "the codes match" on this device**: the budget key, sealed to N's
   * one-time key and bound to the transcript. Once only. `keys` are checked to be the keys of `bk` and of the offer;
   * after a key change in between, the person starts again.
   */
  async seal(bk: Uint8Array, now: number): Promise<Bytes> {
    const t = this.#t;
    if (!t || this.#sealed) throw new AddError('no code has been shown, or the key is already sealed');
    if (now > this.#until) throw new AddError('too late');
    this.#sealed = true;
    try {
      await assertBudgetKey(bk, this.#keys, this.#budgetId);
    } catch (e) {
      if (e instanceof RangeError) throw new AddError('not the key the offer named');
      throw e;
    }
    try {
      return await hpke.seal(t.addPub, addInfo(t.transcript), t.offer.signPub, bk);
    } catch (e) {
      if (e instanceof WeakKeyError) throw new AddError('weak key');
      throw e;
    }
  }

  /**
   * Last step: whether N opened the key. It proves that the other end holds the budget key and this transcript. The
   * app shows "added" when this is true and the new device's slot change is in the log.
   */
  async confirmed(bk: Uint8Array, confirm: Uint8Array): Promise<boolean> {
    const t = this.#t;
    if (!t || !this.#sealed) return false;
    if (bk.length !== BUDGET_KEY_LEN) throw new RangeError('budget key');
    if (!(confirm instanceof Uint8Array) || confirm.length !== ADD_CONFIRM_LEN) return false;
    const k = await confirmKey(bk, t.transcript);
    try {
      return await hmacVerify(k, t.transcript, confirm);
    } finally {
      zeroize(k);
    }
  }
}

/** For tests and other implementations: the transcript and code of three messages, with no state. */
export async function addTranscriptOf(
  budgetId: string,
  commit: Uint8Array,
  offer: Uint8Array,
  reveal: Uint8Array,
): Promise<{ transcript: Bytes; code: string }> {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (commit.length !== ADD_COMMIT_LEN || reveal.length !== ADD_REVEAL_LEN) throw new RangeError('length');
  const t = await transcriptOf(budgetId, commit, readOffer(offer), reveal);
  return { transcript: t.transcript, code: t.code };
}
