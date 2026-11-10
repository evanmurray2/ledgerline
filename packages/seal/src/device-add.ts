// Adding a device with its own passkey (docs/privacy-keys.md section 10). The new device N holds nothing; the
// signed-in device O holds the budget key. The server relays every message, so the two devices agree on a six-digit
// code that the person compares, and the budget key crosses only after the person has confirmed it on O.
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
import { type DhPair, dhPairFromSeed, WeakKeyError } from './curve.js';
import type { PublicRef } from './entry.js';
import { hkdf, hmac, hmacVerify, sha256 } from './hash.js';
import * as hpke from './hpke.js';
import { assertBudgetKey } from './slots.js';

/** O allows this many tries per start; then the person starts again. */
export const ADD_ATTEMPTS = 3;
/** One try lasts this long. */
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

/** What N keeps from its first step until the end. Used for one try only. */
export interface AddSecret {
  pair: DhPair;
  nonce: Bytes;
  commit: Bytes;
  /** Set once the sealed key has been opened, or the try has failed: the pair opens nothing twice. */
  used: boolean;
}

/** N, step 1: a one-time key pair and a nonce, and the commitment to both that goes to O. */
export async function startAdd(): Promise<AddSecret> {
  const seed = randomBytes(32);
  try {
    const pair = await dhPairFromSeed(seed);
    const nonce = randomBytes(32);
    const commit = await sha256(concat(label('ledgerline/v1/add/commit'), pair.pub, nonce));
    return { pair, nonce, commit, used: false };
  } finally {
    zeroize(seed);
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

/** O, step 2: answers a commitment with a fresh nonce and the budget's signing key and head. */
export function offerAdd(keys: BudgetKeys, head: PublicRef): Bytes {
  return encodeOffer({ nonce: randomBytes(32), signPub: keys.sign.pub, version: keys.version, head });
}

/** N, step 3: shows what it committed to. Only after it holds O's offer. */
export function revealAdd(s: AddSecret): Bytes {
  return concat(s.pair.pub, s.nonce);
}

/** What both devices hold once the three messages have crossed. */
export interface AddTranscript {
  budgetId: string;
  transcript: Bytes;
  /** Six digits. Both devices show it, and the person confirms it on both. */
  code: string;
  addPub: Bytes;
  offer: AddOffer;
}

/**
 * The transcript and its code, from the three messages. Both devices run this: O with the commitment and the reveal it
 * received and the offer it sent, N with its own commitment and reveal and the offer it received. A reveal that
 * doesn't match the commitment stops the add: the server tried to swap the key after it saw O's nonce.
 */
export async function addTranscript(
  budgetId: string,
  commit: Uint8Array,
  offer: Uint8Array,
  reveal: Uint8Array,
): Promise<AddTranscript> {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (commit.length !== ADD_COMMIT_LEN) throw new AddError('commitment');
  if (reveal.length !== ADD_REVEAL_LEN) throw new AddError('reveal');
  let o: AddOffer;
  try {
    o = readOffer(offer);
  } catch (e) {
    if (e instanceof FormatError) throw new AddError('offer');
    throw e;
  }
  const addPub = reveal.slice(0, 32) as Bytes;
  const nonceN = reveal.slice(32) as Bytes;
  if (!equal(await sha256(concat(label('ledgerline/v1/add/commit'), addPub, nonceN)), commit))
    throw new AddError('the reveal does not match the commitment');
  const transcript = await sha256(
    concat(
      label('ledgerline/v1/add/transcript'),
      commit,
      o.nonce,
      addPub,
      nonceN,
      str(budgetId),
      o.signPub,
      u32(o.version),
      u64(o.head.number),
      o.head.hash,
    ),
  );
  const four = await hkdf(transcript, ZERO32, label('ledgerline/v1/add/code'), 4);
  const n = new DataView(four.buffer).getUint32(0) % 1_000_000;
  return { budgetId, transcript, code: String(n).padStart(6, '0'), addPub, offer: o };
}

const addInfo = (transcript: Uint8Array): Bytes => concat(label('ledgerline/v1/hpke/device-add'), transcript);

async function confirmKey(bk: Uint8Array, transcript: Uint8Array): Promise<Bytes> {
  return hkdf(bk, transcript, label('ledgerline/v1/add/confirm'), 32);
}

/**
 * O, step 4, **only after the person tapped "the codes match" on O**: the budget key, sealed to N's one-time key and
 * bound to the transcript. The key must be the one the offer named.
 */
export async function sealBudgetKey(t: AddTranscript, bk: Uint8Array, keys: BudgetKeys): Promise<Bytes> {
  if (keys.version !== t.offer.version || !equal(keys.sign.pub, t.offer.signPub))
    throw new RangeError('not the key the offer named');
  await assertBudgetKey(bk, keys, t.budgetId);
  try {
    return await hpke.seal(t.addPub, addInfo(t.transcript), t.offer.signPub, bk);
  } catch (e) {
    // A small-order key from N (or from a server in N's place) would make a shared secret anyone can work out.
    if (e instanceof WeakKeyError) throw new AddError('weak key');
    throw e;
  }
}

/**
 * N, step 5, **only after the person tapped "the codes match" on N too**: opens the budget key and checks that it is
 * the key of the signing key the offer named. The caller then checks that signing key, its version and the head
 * against the public chain it walked (4.4), and only then sends `confirm` and writes its slot.
 */
export async function openBudgetKey(
  s: AddSecret,
  t: AddTranscript,
  sealed: Uint8Array,
): Promise<{ bk: Bytes; keys: BudgetKeys; confirm: Bytes }> {
  if (s.used) throw new AddError('this try is over');
  s.used = true;
  if (!equal(s.pair.pub, t.addPub) || sealed.length !== ADD_SEALED_LEN) throw new AddError('sealed key');
  let bk: Bytes;
  try {
    bk = await hpke.open(s.pair, addInfo(t.transcript), t.offer.signPub, sealed);
  } catch (e) {
    if (e instanceof OpenError) throw new AddError('the sealed key does not open');
    throw e;
  }
  let ok = false;
  try {
    if (bk.length !== BUDGET_KEY_LEN) throw new AddError('budget key');
    const keys = await deriveBudgetKeys(bk, t.budgetId, t.offer.version);
    if (!equal(keys.sign.pub, t.offer.signPub)) throw new AddError('not the key of the signing key it named');
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

/** O, last step: whether N opened the key. O shows "added" only when this is true. */
export async function checkConfirm(t: AddTranscript, bk: Uint8Array, confirm: Uint8Array): Promise<boolean> {
  if (bk.length !== BUDGET_KEY_LEN) throw new RangeError('budget key');
  if (confirm.length !== ADD_CONFIRM_LEN) return false;
  const k = await confirmKey(bk, t.transcript);
  try {
    return await hmacVerify(k, t.transcript, confirm);
  } finally {
    zeroize(k);
  }
}
