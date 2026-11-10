// Log entries (docs/privacy-keys.md section 6): a header, a body and a signature. The header is all the server reads;
// the body is sealed for the kinds that carry budget data, and a public structure for the kinds a device with no key
// must read (genesis, slot change, key change, and the intent to remove a way in and its cancel).
import {
  type Bytes,
  concat,
  equal,
  FormatError,
  isUlid,
  label,
  Reader,
  str,
  u16,
  u32,
  u64,
  u8,
  utf8,
} from './bytes.js';
import { aeadOpen, aeadSeal } from './aead.js';
import type { BudgetKeys } from './budget-key.js';
import { sign, verify } from './curve.js';
import { sha256 } from './hash.js';
import { NONCE_LEN, TAG_LEN } from './aead.js';
import { MAX_PLAIN, pad, PAD_STEPS, unpad } from './pad.js';
import {
  encodeSlotRecords,
  isSlotId,
  MAX_SLOT_ID,
  MAX_SLOTS,
  readSlotRecords,
  type SlotRecord,
} from './slots.js';

export const KIND = {
  genesis: 0,
  edit: 1,
  bank: 2,
  scan: 3,
  slotChange: 4,
  keyChange: 5,
  signOut: 6,
  dataMigration: 8,
  intent: 9,
  cancel: 10,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

const KINDS: readonly number[] = Object.values(KIND);
/** Kinds whose body is a public structure, read by devices that hold no key yet. Never split into parts. */
const PUBLIC_KINDS: readonly number[] = [
  KIND.genesis,
  KIND.slotChange,
  KIND.keyChange,
  KIND.intent,
  KIND.cancel,
];
/** Kinds that may be written as parts. */
const PART_KINDS: readonly number[] = [KIND.edit, KIND.bank, KIND.scan, KIND.dataMigration];

export const isPublicKind = (kind: number): boolean => PUBLIC_KINDS.includes(kind);

export const MAX_RECEIPTS = 256;
export const MAX_INBOXES = 16;
export const WRAPPED_LEN = 60;
export const SIGNATURE_LEN = 64;
/** The largest public body: a key change with 64 slots and 16 inbox keys is about 100 KB. */
const MAX_BODY = 131072;
const MAX_HEADER = 16384;
const ZERO32 = new Uint8Array(32);

export interface EntryHeader {
  kind: Kind;
  budgetId: string;
  /** 1 for the genesis entry, then up by 1. */
  number: number;
  /** The hash of entry `number - 1`; zeros for the genesis entry. */
  prevHash: Bytes;
  /** Random, 16 bytes. The same in every part of a set. */
  entryId: Bytes;
  /** Unix milliseconds. For ordering only. */
  time: number;
  deviceId: string;
  deviceCounter: number;
  /** The version whose signing key signs this entry. */
  keyVersion: number;
  schemaVersion: number;
  processingVersion: number;
  part: number;
  parts: number;
  /** The last bank run this budget has filed, after this entry. */
  filedThrough: number;
  /** For a bank entry, the receipt of each run it files, in order. */
  receipts: Bytes[];
  /** Days since 1970-01-01 of the last day scanned. */
  scanThrough: number;
  /** H(body), the bytes as stored. */
  bodyHash: Bytes;
}

export interface Entry {
  header: EntryHeader;
  /** The body as stored: sealed, or a public structure. */
  body: Bytes;
  signature: Bytes;
  /** entryHash = H(header). */
  hash: Bytes;
}

function checkHeader(h: EntryHeader): void {
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!KINDS.includes(h.kind)) throw new FormatError('kind');
  if (!isUlid(h.budgetId) || !isUlid(h.deviceId)) throw new FormatError('id');
  if (!whole(h.number, Number.MAX_SAFE_INTEGER) || h.number < 1) throw new FormatError('number');
  if (h.prevHash.length !== 32 || h.entryId.length !== 16 || h.bodyHash.length !== 32)
    throw new FormatError('length');
  if (!whole(h.time, Number.MAX_SAFE_INTEGER)) throw new FormatError('time');
  if (!whole(h.deviceCounter, Number.MAX_SAFE_INTEGER) || h.deviceCounter < 1)
    throw new FormatError('counter');
  if (!whole(h.keyVersion, 0xffffffff) || h.keyVersion < 1) throw new FormatError('key version');
  if (!whole(h.schemaVersion, 0xffffffff) || !whole(h.processingVersion, 0xffffffff))
    throw new FormatError('version');
  if (!whole(h.part, 0xffff) || !whole(h.parts, 0xffff) || h.part < 1 || h.part > h.parts)
    throw new FormatError('part');
  if (h.parts > 1 && !PART_KINDS.includes(h.kind)) throw new FormatError('this kind is never split');
  if (!whole(h.filedThrough, Number.MAX_SAFE_INTEGER)) throw new FormatError('filed through');
  if (h.receipts.length > MAX_RECEIPTS || h.receipts.some((r) => r.length !== 32))
    throw new FormatError('receipts');
  if (h.receipts.length > 0 && (h.kind !== KIND.bank || h.part !== 1)) throw new FormatError('receipts');
  if (!whole(h.scanThrough, 0xffffffff)) throw new FormatError('scan through');
  if ((h.number === 1) !== (h.kind === KIND.genesis)) throw new FormatError('genesis');
  if ((h.number === 1) !== equal(h.prevHash, ZERO32)) throw new FormatError('previous hash');
}

/** Header fields 1 to 16: everything but the body's hash. The body's associated data is made from these. */
function encodeCore(h: EntryHeader): Bytes {
  checkHeader(h);
  return concat(
    utf8('LLE1'),
    u8(h.kind),
    str(h.budgetId),
    u64(h.number),
    h.prevHash,
    h.entryId,
    u64(h.time),
    str(h.deviceId),
    u64(h.deviceCounter),
    u32(h.keyVersion),
    u32(h.schemaVersion),
    u32(h.processingVersion),
    u16(h.part),
    u16(h.parts),
    u64(h.filedThrough),
    u16(h.receipts.length),
    ...h.receipts,
    u32(h.scanThrough),
  );
}

export function encodeHeader(h: EntryHeader): Bytes {
  return concat(encodeCore(h), h.bodyHash);
}

export function readHeader(bytes: Uint8Array): EntryHeader {
  const r = new Reader(bytes);
  r.magic('LLE1');
  const kind = r.u8() as Kind;
  const budgetId = r.text(26);
  const number = r.u64();
  const prevHash = r.take(32);
  const entryId = r.take(16);
  const time = r.u64();
  const deviceId = r.text(26);
  const deviceCounter = r.u64();
  const keyVersion = r.u32();
  const schemaVersion = r.u32();
  const processingVersion = r.u32();
  const part = r.u16();
  const parts = r.u16();
  const filedThrough = r.u64();
  const count = r.u16();
  if (count > MAX_RECEIPTS) throw new FormatError('receipts');
  const receipts: Bytes[] = [];
  for (let i = 0; i < count; i++) receipts.push(r.take(32));
  const scanThrough = r.u32();
  const bodyHash = r.take(32);
  r.end();
  const h: EntryHeader = {
    kind,
    budgetId,
    number,
    prevHash,
    entryId,
    time,
    deviceId,
    deviceCounter,
    keyVersion,
    schemaVersion,
    processingVersion,
    part,
    parts,
    filedThrough,
    receipts,
    scanThrough,
    bodyHash,
  };
  checkHeader(h);
  return h;
}

const signedMessage = (hash: Uint8Array): Bytes => concat(label('ledgerline/v1/entry'), hash);

async function bodyAad(h: EntryHeader): Promise<Bytes> {
  return concat(label('ledgerline/v1/body'), await sha256(encodeCore(h)));
}

export type EntryFields = Omit<EntryHeader, 'bodyHash'>;

async function finish(fields: EntryFields, body: Bytes, keys: BudgetKeys): Promise<Entry> {
  if (fields.keyVersion !== keys.version) throw new RangeError('key version');
  if (body.length > MAX_BODY) throw new RangeError('body too large');
  const header: EntryHeader = { ...fields, bodyHash: await sha256(body) };
  const hash = await sha256(encodeHeader(header));
  return { header, body, hash, signature: await sign(keys.sign.privateKey, signedMessage(hash)) };
}

/** An entry whose body is sealed (kinds edit, bank, scan, sign-out, data migration). `plain` is at most 65,535 bytes. */
export async function sealedEntry(fields: EntryFields, plain: Uint8Array, keys: BudgetKeys): Promise<Entry> {
  if (isPublicKind(fields.kind)) throw new RangeError('this kind has a public body');
  if (plain.length > MAX_PLAIN) throw new RangeError('body too large for one entry');
  const core: EntryHeader = { ...fields, bodyHash: new Uint8Array(32) };
  return finish(fields, await aeadSeal(keys.log, await bodyAad(core), pad(plain)), keys);
}

/** An entry whose body is a public structure (kinds genesis, slot change, key change, intent, cancel). */
export async function publicEntry(fields: EntryFields, body: Bytes, keys: BudgetKeys): Promise<Entry> {
  if (!isPublicKind(fields.kind)) throw new RangeError('this kind has a sealed body');
  return finish(fields, body, keys);
}

/** The plain body of a sealed entry. Throws when the key is wrong or anything was changed. */
export async function openEntryBody(e: Entry, keys: BudgetKeys): Promise<Bytes> {
  if (isPublicKind(e.header.kind)) throw new RangeError('this kind has a public body');
  if (e.header.keyVersion !== keys.version) throw new RangeError('key version');
  return unpad(await aeadOpen(keys.log, await bodyAad(e.header), e.body));
}

/** Whether the entry's signature is good for a signing public key. */
export function verifyEntry(e: Entry, signPub: Uint8Array | CryptoKey): Promise<boolean> {
  return verify(signPub, signedMessage(e.hash), e.signature);
}

/** An entry as sent and stored: str(header) || str(body) || signature(64). */
export function encodeEntry(e: Entry): Bytes {
  if (e.signature.length !== SIGNATURE_LEN) throw new RangeError('signature');
  return concat(str(encodeHeader(e.header)), str(e.body), e.signature);
}

/** Reads an entry and checks that the header names this body. The signature is checked against the chain (chain.ts). */
export async function readEntry(bytes: Uint8Array): Promise<Entry> {
  const r = new Reader(bytes);
  const headerBytes = r.str(MAX_HEADER);
  const body = r.str(MAX_BODY);
  const signature = r.take(SIGNATURE_LEN);
  r.end();
  const header = readHeader(headerBytes);
  // A sealed body is exactly a padding step, its nonce and its tag.
  if (
    !isPublicKind(header.kind) &&
    !(PAD_STEPS as readonly number[]).includes(body.length - NONCE_LEN - TAG_LEN)
  )
    throw new FormatError('sealed body length');
  if (!equal(await sha256(body), header.bodyHash)) throw new FormatError('body hash');
  return { header, body, signature, hash: await sha256(headerBytes) };
}

// ---------------------------------------------------------------- public bodies (6.3)

/** The public entry before this one: its number and hash. */
export interface PublicRef {
  number: number;
  hash: Bytes;
}

const encodeRef = (p: PublicRef): Bytes => {
  if (p.hash.length !== 32) throw new RangeError('hash');
  return concat(u64(p.number), p.hash);
};
const readRef = (r: Reader): PublicRef => ({ number: r.u64(), hash: r.take(32) });

function wrapped(b: Uint8Array): Bytes {
  if (b.length !== WRAPPED_LEN) throw new RangeError('wrapped value');
  return str(b);
}
function readWrapped(r: Reader): Bytes {
  const b = r.str(WRAPPED_LEN);
  if (b.length !== WRAPPED_LEN) throw new FormatError('wrapped value');
  return b;
}
function pub32(b: Uint8Array): Uint8Array {
  if (b.length !== 32) throw new RangeError('public key');
  return b;
}

export interface Genesis {
  signPub: Bytes;
  inboxPub: Bytes;
  wrappedInbox: Bytes;
  slots: SlotRecord[];
}

export function encodeGenesis(g: Genesis): Bytes {
  return concat(
    utf8('LLG1'),
    pub32(g.signPub),
    u32(1),
    pub32(g.inboxPub),
    wrapped(g.wrappedInbox),
    encodeSlotRecords(g.slots),
  );
}

export function readGenesis(body: Uint8Array): Genesis {
  const r = new Reader(body);
  r.magic('LLG1');
  const signPub = r.take(32);
  if (r.u32() !== 1) throw new FormatError('inbox version');
  const g = { signPub, inboxPub: r.take(32), wrappedInbox: readWrapped(r), slots: readSlotRecords(r) };
  r.end();
  return g;
}

export interface SlotChange {
  prevPublic: PublicRef;
  slots: SlotRecord[];
}

export function encodeSlotChange(s: SlotChange): Bytes {
  return concat(utf8('LLS1'), encodeRef(s.prevPublic), encodeSlotRecords(s.slots));
}

export function readSlotChange(body: Uint8Array): SlotChange {
  const r = new Reader(body);
  r.magic('LLS1');
  const s = { prevPublic: readRef(r), slots: readSlotRecords(r) };
  r.end();
  return s;
}

/** The intent to remove ways in, written before the key change that does it (docs/privacy.md 5.2). */
export interface Intent {
  prevPublic: PublicRef;
  notBefore: number;
  slotIds: string[];
}

export function encodeIntent(i: Intent): Bytes {
  if (i.slotIds.length < 1 || i.slotIds.length > MAX_SLOTS) throw new RangeError('slot count');
  if (new Set(i.slotIds).size !== i.slotIds.length || !i.slotIds.every(isSlotId))
    throw new RangeError('slot id');
  return concat(
    utf8('LLI1'),
    encodeRef(i.prevPublic),
    u64(i.notBefore),
    u16(i.slotIds.length),
    ...i.slotIds.map((id) => str(id)),
  );
}

export function readIntent(body: Uint8Array): Intent {
  const r = new Reader(body);
  r.magic('LLI1');
  const prevPublic = readRef(r);
  const notBefore = r.u64();
  const n = r.u16();
  if (n < 1 || n > MAX_SLOTS) throw new FormatError('slot count');
  const slotIds: string[] = [];
  for (let k = 0; k < n; k++) {
    const id = r.text(MAX_SLOT_ID);
    if (!isSlotId(id)) throw new FormatError('slot id');
    slotIds.push(id);
  }
  if (new Set(slotIds).size !== n) throw new FormatError('slot twice');
  r.end();
  return { prevPublic, notBefore, slotIds };
}

export interface Cancel {
  prevPublic: PublicRef;
  intent: PublicRef;
}

export function encodeCancel(c: Cancel): Bytes {
  return concat(utf8('LLC1'), encodeRef(c.prevPublic), encodeRef(c.intent));
}

export function readCancel(body: Uint8Array): Cancel {
  const r = new Reader(body);
  r.magic('LLC1');
  const c = { prevPublic: readRef(r), intent: readRef(r) };
  r.end();
  return c;
}

export interface KeyChange {
  prevPublic: PublicRef;
  /** The new key version: the header's `keyVersion` + 1. */
  version: number;
  signPub: Bytes;
  /** The budget key this change replaces, wrapped under the new one. */
  wrappedPrevKey: Bytes;
  inboxVersion: number;
  inboxPub: Bytes;
  /** The highest bank run number that existed when this was written. */
  lastOldRun: number;
  /** The new inbox private key, and each older one that still has unfiled runs. */
  inboxes: { version: number; wrapped: Bytes }[];
  /** Every slot that stays, sealed and wrapped for the new version. */
  slots: SlotRecord[];
  /** The intent this change carries out; null when none was needed. */
  intent: PublicRef | null;
}

export function encodeKeyChange(k: KeyChange): Bytes {
  if (k.inboxes.length < 1 || k.inboxes.length > MAX_INBOXES) throw new RangeError('inbox count');
  return concat(
    utf8('LLK1'),
    encodeRef(k.prevPublic),
    u32(k.version),
    pub32(k.signPub),
    wrapped(k.wrappedPrevKey),
    u32(k.inboxVersion),
    pub32(k.inboxPub),
    u64(k.lastOldRun),
    u16(k.inboxes.length),
    ...k.inboxes.map((i) => concat(u32(i.version), wrapped(i.wrapped))),
    encodeSlotRecords(k.slots),
    encodeRef(k.intent ?? { number: 0, hash: new Uint8Array(32) }),
  );
}

export function readKeyChange(body: Uint8Array): KeyChange {
  const r = new Reader(body);
  r.magic('LLK1');
  const prevPublic = readRef(r);
  const version = r.u32();
  const signPub = r.take(32);
  const wrappedPrevKey = readWrapped(r);
  const inboxVersion = r.u32();
  const inboxPub = r.take(32);
  const lastOldRun = r.u64();
  const n = r.u16();
  if (n < 1 || n > MAX_INBOXES) throw new FormatError('inbox count');
  const inboxes: KeyChange['inboxes'] = [];
  for (let i = 0; i < n; i++) inboxes.push({ version: r.u32(), wrapped: readWrapped(r) });
  const slots = readSlotRecords(r);
  const ref = readRef(r);
  r.end();
  const none = ref.number === 0;
  if (none !== equal(ref.hash, ZERO32)) throw new FormatError('intent');
  return {
    prevPublic,
    version,
    signPub,
    wrappedPrevKey,
    inboxVersion,
    inboxPub,
    lastOldRun,
    inboxes,
    slots,
    intent: none ? null : ref,
  };
}
