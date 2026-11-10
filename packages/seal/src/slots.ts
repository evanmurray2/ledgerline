// Ways in to a budget (docs/privacy-keys.md section 4): a passkey, or the recovery key. Each has an X25519 pair that
// the budget key is sealed to, and a MAC key for its anchor. HPKE proves nothing about who sealed, so a slot's anchor
// (a MAC only the slot's owner can check, over the budget and its first signing key) is what stops a server from
// handing a device a budget its way in was never part of.
import {
  type Bytes,
  concat,
  equal,
  FormatError,
  isUlid,
  label,
  Reader,
  str,
  toB64url,
  u16,
  u32,
  utf8,
  zeroize,
} from './bytes.js';
import { aeadOpen, aeadSeal } from './aead.js';
import { BUDGET_KEY_LEN, type BudgetKeys, deriveBudgetKeys } from './budget-key.js';
import { type DhPair, dhPairFromSeed, type SignPair, signPairFromSeed } from './curve.js';
import { hkdf, hmac, hmacKey, hmacVerify, sha256 } from './hash.js';
import * as hpke from './hpke.js';

export const MAX_CREDENTIAL_ID = 1023;
export const MAX_SLOT_ID = 2048;
export const MAX_SLOTS = 64;
export const ANCHOR_LEN = 32;
export const SEALED_KEY_LEN = 80;
export const WRAPPED_PUB_LEN = 60;

const ZERO = new Uint8Array(32);

/** A way in's secrets, on the device that holds it. */
export interface SlotSecrets {
  slotId: string;
  /** The pair the budget key is sealed to. */
  pair: DhPair;
  /** HMAC key for the slot's anchor. Non-extractable. */
  anchorKey: CryptoKey;
}

/** The first PRF input of every sign-in: one constant for the whole app. */
export function prfInput(): Promise<Bytes> {
  return sha256(label('ledgerline/v1/prf/slot'));
}

async function secretsFrom(
  ikm: Uint8Array,
  salt: Uint8Array,
  seedLabel: string,
  anchorLabel: string,
  slotId: string,
): Promise<SlotSecrets> {
  const [seed, anchorRaw] = await Promise.all([
    hkdf(ikm, salt, label(seedLabel), 32),
    hkdf(ikm, salt, label(anchorLabel), 32),
  ]);
  try {
    return { slotId, pair: await dhPairFromSeed(seed), anchorKey: await hmacKey(anchorRaw) };
  } finally {
    zeroize(seed, anchorRaw);
  }
}

export function passkeySlotId(credentialId: Uint8Array): string {
  if (credentialId.length === 0 || credentialId.length > MAX_CREDENTIAL_ID)
    throw new RangeError('credential id');
  return `p:${toB64url(credentialId)}`;
}

/** A passkey's slot secrets, from its 32-byte PRF output for `prfInput()`. The caller zeroes `prf`. */
export async function passkeySlot(
  prf: Uint8Array,
  budgetId: string,
  credentialId: Uint8Array,
): Promise<SlotSecrets> {
  if (prf.length !== 32) throw new RangeError('prf output');
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  const slotId = passkeySlotId(credentialId);
  return secretsFrom(
    prf,
    concat(str(budgetId), str(credentialId)),
    'ledgerline/v1/slot/x25519',
    'ledgerline/v1/slot/anchor',
    slotId,
  );
}

export function recoverySlotId(generation: number): string {
  if (!Number.isInteger(generation) || generation < 1 || generation > 0xffffffff)
    throw new RangeError('generation');
  return `r:${generation}`;
}

export interface RecoverySecrets extends SlotSecrets {
  /** Proves the recovery key to the server by a signature; the server stores only `auth.pub`. */
  auth: SignPair;
}

/** The recovery key's secrets. `R` is unique to one budget, so it needs no salt. The caller zeroes `r`. */
export async function recoverySlot(r: Uint8Array, generation: number): Promise<RecoverySecrets> {
  if (r.length !== 32) throw new RangeError('recovery key');
  const slotId = recoverySlotId(generation);
  const authSeed = await hkdf(r, ZERO, label('ledgerline/v1/recovery/auth'), 32);
  try {
    const [slot, auth] = await Promise.all([
      secretsFrom(r, ZERO, 'ledgerline/v1/recovery/x25519', 'ledgerline/v1/recovery/anchor', slotId),
      signPairFromSeed(authSeed),
    ]);
    return { ...slot, auth };
  } finally {
    zeroize(authSeed);
  }
}

function anchorInput(budgetId: string, slotId: string, genesisSignPub: Uint8Array): Bytes {
  if (!isUlid(budgetId)) throw new RangeError('budget id');
  if (genesisSignPub.length !== 32) throw new RangeError('genesis signing key');
  return concat(label('ledgerline/v1/anchor'), str(budgetId), str(slotId), genesisSignPub);
}

/** The slot's anchor: made once, by the device that holds the slot's secret, and copied unchanged ever after. */
export async function makeAnchor(
  s: SlotSecrets,
  budgetId: string,
  genesisSignPub: Uint8Array,
): Promise<Bytes> {
  return hmac(s.anchorKey, anchorInput(budgetId, s.slotId, genesisSignPub));
}

export async function checkAnchor(
  s: SlotSecrets,
  budgetId: string,
  genesisSignPub: Uint8Array,
  anchor: Uint8Array,
): Promise<boolean> {
  if (anchor.length !== ANCHOR_LEN) return false;
  return hmacVerify(s.anchorKey, anchorInput(budgetId, s.slotId, genesisSignPub), anchor);
}

/** A slot as the log holds it (4.3). */
export interface SlotRecord {
  slotId: string;
  anchor: Bytes;
  /** The budget key, sealed to the slot's public half. Only the slot's owner opens it. */
  sealedKey: Bytes;
  /** The slot's public half, wrapped for holders of the budget key. */
  wrappedPub: Bytes;
}

const slotInfo = (budgetId: string, slotId: string, version: number): Bytes =>
  concat(label('ledgerline/v1/hpke/slot'), str(budgetId), str(slotId), u32(version));
const slotWrapAad = (budgetId: string, slotId: string): Bytes =>
  concat(label('ledgerline/v1/wrap/slot'), str(budgetId), str(slotId));

/** A slot could not be opened, or what it gave is not the budget the chain names. */
export class SlotError extends Error {
  constructor(readonly why: 'anchor' | 'open' | 'signing_key') {
    super(`slot: ${why}`);
  }
}

async function sealRecord(
  slotId: string,
  slotPub: Uint8Array,
  anchor: Bytes,
  bk: Uint8Array,
  keys: BudgetKeys,
  budgetId: string,
): Promise<SlotRecord> {
  if (bk.length !== BUDGET_KEY_LEN) throw new RangeError('budget key');
  const [sealedKey, wrappedPub] = await Promise.all([
    hpke.seal(slotPub, slotInfo(budgetId, slotId, keys.version), keys.sign.pub, bk),
    aeadSeal(keys.wrap, slotWrapAad(budgetId, slotId), slotPub),
  ]);
  return { slotId, anchor, sealedKey, wrappedPub };
}

/**
 * A new slot's record, made by the device that holds the slot's secret and the budget key. It opens its own sealed
 * key from the final bytes before it hands the record back, so a record that can't be opened is never written.
 */
export async function newSlotRecord(
  s: SlotSecrets,
  bk: Uint8Array,
  keys: BudgetKeys,
  budgetId: string,
  genesisSignPub: Uint8Array,
): Promise<SlotRecord> {
  const anchor = await makeAnchor(s, budgetId, genesisSignPub);
  const record = await sealRecord(s.slotId, s.pair.pub, anchor, bk, keys, budgetId);
  const opened = await openSlotRecord(s, record, budgetId, keys.version, genesisSignPub, keys.sign.pub);
  zeroize(opened.bk);
  return record;
}

/**
 * A slot's record for the next key version, made by a device that holds both budget keys but not the slot's secret
 * (a key change): the public half comes from the old record's wrapped copy, and the anchor is copied unchanged.
 */
export async function resealSlotRecord(
  old: SlotRecord,
  oldKeys: BudgetKeys,
  newBk: Uint8Array,
  newKeys: BudgetKeys,
  budgetId: string,
): Promise<SlotRecord> {
  if (newKeys.version !== oldKeys.version + 1) throw new RangeError('key version');
  const slotPub = await aeadOpen(oldKeys.wrap, slotWrapAad(budgetId, old.slotId), old.wrappedPub);
  if (slotPub.length !== 32) throw new FormatError('slot public key');
  return sealRecord(old.slotId, slotPub, old.anchor, newBk, newKeys, budgetId);
}

/**
 * Opens a slot's record with the slot's own secrets (4.4, steps 5 and 6): the anchor is checked first, then the sealed
 * key is opened with the signing key the chain names as associated data, and the key that comes out must derive that
 * same signing key. The caller zeroes `bk` when it is done with it.
 */
export async function openSlotRecord(
  s: SlotSecrets,
  record: SlotRecord,
  budgetId: string,
  version: number,
  genesisSignPub: Uint8Array,
  chainSignPub: Uint8Array,
): Promise<{ bk: Bytes; keys: BudgetKeys }> {
  if (record.slotId !== s.slotId || !(await checkAnchor(s, budgetId, genesisSignPub, record.anchor)))
    throw new SlotError('anchor');
  let bk: Bytes;
  try {
    bk = await hpke.open(s.pair, slotInfo(budgetId, s.slotId, version), chainSignPub, record.sealedKey);
  } catch {
    throw new SlotError('open');
  }
  if (bk.length !== BUDGET_KEY_LEN) {
    zeroize(bk);
    throw new SlotError('open');
  }
  const keys = await deriveBudgetKeys(bk, budgetId, version);
  if (!equal(keys.sign.pub, chainSignPub)) {
    zeroize(bk);
    throw new SlotError('signing_key');
  }
  return { bk, keys };
}

export function encodeSlotRecord(r: SlotRecord): Bytes {
  if (
    r.anchor.length !== ANCHOR_LEN ||
    r.sealedKey.length !== SEALED_KEY_LEN ||
    r.wrappedPub.length !== WRAPPED_PUB_LEN
  )
    throw new RangeError('slot record');
  const id = utf8(r.slotId);
  if (id.length === 0 || id.length > MAX_SLOT_ID || id.includes(0)) throw new RangeError('slot id');
  return concat(str(id), r.anchor, r.sealedKey, r.wrappedPub);
}

const SLOT_ID = /^(p:[A-Za-z0-9_-]+|r:[1-9][0-9]{0,9})$/;

export function readSlotRecord(r: Reader): SlotRecord {
  const slotId = r.text(MAX_SLOT_ID);
  if (!SLOT_ID.test(slotId)) throw new FormatError('slot id');
  return {
    slotId,
    anchor: r.take(ANCHOR_LEN),
    sealedKey: r.take(SEALED_KEY_LEN),
    wrappedPub: r.take(WRAPPED_PUB_LEN),
  };
}

/** `u16(slots) || slot records`: at least 1, at most 64, and no slot twice. */
export function encodeSlotRecords(records: SlotRecord[]): Bytes {
  if (records.length < 1 || records.length > MAX_SLOTS) throw new RangeError('slot count');
  if (new Set(records.map((r) => r.slotId)).size !== records.length) throw new RangeError('slot twice');
  return concat(u16(records.length), ...records.map(encodeSlotRecord));
}

export function readSlotRecords(r: Reader): SlotRecord[] {
  const n = r.u16();
  if (n < 1 || n > MAX_SLOTS) throw new FormatError('slot count');
  const out: SlotRecord[] = [];
  for (let i = 0; i < n; i++) out.push(readSlotRecord(r));
  if (new Set(out.map((x) => x.slotId)).size !== n) throw new FormatError('slot twice');
  return out;
}
