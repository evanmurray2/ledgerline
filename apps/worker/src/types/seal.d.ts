// The part of @ledgerline/seal the Worker uses, as types only. The package's sources are written against the
// browser's WebCrypto types and don't type-check under Cloudflare's (the two disagree on a few algorithm shapes),
// and packages/seal is an owner path, so the Worker's type check reads this instead (tsconfig `paths`). The
// bundler and the tests load the real package: test/stamp-links.test.ts runs these functions for real, and
// packages/seal's own tests pin what they compute.
export interface ServerKeys {
  n: number;
  mac: CryptoKey;
  runSign: unknown;
}
export function isUlid(s: string): boolean;
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer>;
export function label(name: string): Uint8Array<ArrayBuffer>;
export function str(x: Uint8Array | string): Uint8Array<ArrayBuffer>;
export function u8(n: number): Uint8Array<ArrayBuffer>;
export function u16(n: number): Uint8Array<ArrayBuffer>;
export function u32(n: number): Uint8Array<ArrayBuffer>;
export function u64(n: number): Uint8Array<ArrayBuffer>;
export function hmac(key: Uint8Array | CryptoKey, x: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
export function hmacVerify(key: Uint8Array | CryptoKey, x: Uint8Array, mac: Uint8Array): Promise<boolean>;
export function serverKeys(secret: Uint8Array, n: number): Promise<ServerKeys>;
export function linkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
): Promise<Uint8Array>;
export function checkLinkMac(
  k: ServerKeys,
  budgetId: string,
  linkId: string,
  itemId: string,
  tokenCiphertext: Uint8Array,
  mac: Uint8Array,
): Promise<boolean>;
export const KEY_KIND: { readonly sign: 1; readonly inbox: 2 };
export function keyMac(
  k: ServerKeys,
  budgetId: string,
  v: number,
  kind: 1 | 2,
  pub: Uint8Array,
): Promise<Uint8Array>;
export function checkKeyMac(
  k: ServerKeys,
  budgetId: string,
  v: number,
  kind: 1 | 2,
  pub: Uint8Array,
  mac: Uint8Array,
): Promise<boolean>;
export interface RunState {
  run: number;
  lastManifestHash: Uint8Array;
  lastRunTime: number;
  links: { linkId: string; cursorHash: Uint8Array }[];
}
export function runsMac(k: ServerKeys, budgetId: string, s: RunState): Promise<Uint8Array>;
export function checkRunsMac(k: ServerKeys, budgetId: string, s: RunState, mac: Uint8Array): Promise<boolean>;

// ---- bank runs (apps/worker/src/seal/runs.ts; packages/seal run.ts)
export const WHAT: {
  readonly transactions: 0;
  readonly balances: 1;
  readonly liabilities: 2;
  readonly link: 3;
};
export type What = 0 | 1 | 2 | 3;
export interface RunPage {
  what: What;
  hash: Uint8Array<ArrayBuffer>;
}
export interface RunManifest {
  budgetId: string;
  linkId: string;
  run: number;
  restart: number;
  inboxVersion: number;
  inboxPubHash: Uint8Array<ArrayBuffer>;
  runTime: number;
  prevRunTime: number;
  cursorBefore: Uint8Array<ArrayBuffer>;
  cursorAfter: Uint8Array<ArrayBuffer>;
  flags: number;
  added: number;
  modified: number;
  removed: number;
  pages: RunPage[];
  receiptHash: Uint8Array<ArrayBuffer>;
  prevManifestHash: Uint8Array<ArrayBuffer>;
  n: number;
}
export function readRunManifest(bytes: Uint8Array): RunManifest;
export function cursorHash(cursor: string): Promise<Uint8Array<ArrayBuffer>>;
export function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
export interface PagePlace {
  budgetId: string;
  linkId: string;
  inboxVersion: number;
  run: number;
  restart: number;
  page: number;
}
export function sealPage(
  k: ServerKeys,
  inboxPub: Uint8Array,
  at: PagePlace,
  what: What,
  payload: Uint8Array,
): Promise<{ sealed: Uint8Array<ArrayBuffer>; page: RunPage }>;
export class RestartRun extends Error {}
export function signRun(
  k: ServerKeys,
  inboxPub: Uint8Array,
  run: Omit<RunManifest, 'inboxPubHash' | 'receiptHash' | 'n' | 'flags'>,
  inForce: { inboxVersion: number; lastRunForOld: number },
): Promise<{ manifest: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> }>;
export interface SealedRun {
  manifest: Uint8Array;
  signature: Uint8Array;
  pages: Uint8Array[];
}
export class RunError extends Error {
  readonly why: string;
  readonly retry: boolean;
}
export interface FilingState {
  budgetId: string;
  workerKeys: Map<number, Uint8Array>;
  filedThrough: number;
  lastManifestHash: Uint8Array;
  lastRunTime: number;
  lastInboxVersion: number;
  cursors: Map<string, Uint8Array>;
  inboxVersion: number;
  retiredAt: Map<number, number>;
  inbox(version: number): Promise<unknown>;
  now: number;
}
export interface FiledRun {
  manifest: RunManifest;
  manifestHash: Uint8Array<ArrayBuffer>;
  pages: { what: What; payload: Uint8Array<ArrayBuffer> }[];
  receipt: Uint8Array<ArrayBuffer>;
}
export function openRun(s: FilingState, run: SealedRun): Promise<FiledRun>;
/** An inbox pair, private half too (curve.ts DhPair). */
export type DhPair = { pub: Uint8Array<ArrayBuffer> } & Record<string, unknown>;
export function openInbox(
  keys: BudgetKeys,
  budgetId: string,
  i: number,
  wrapped: Uint8Array,
): Promise<DhPair>;
export function afterRun(s: FilingState, filed: FiledRun): FilingState;

// ---- the log (apps/worker/src/seal/log-store.ts). The entry and the chain state, as packages/seal entry.ts and
// chain.ts declare them (a slot record stays opaque: the Worker never reads one).
export type Bytes = Uint8Array<ArrayBuffer>;
export interface EntryHeader {
  kind: number;
  budgetId: string;
  number: number;
  prevHash: Bytes;
  entryId: Bytes;
  time: number;
  deviceId: string;
  deviceCounter: number;
  keyVersion: number;
  schemaVersion: number;
  processingVersion: number;
  part: number;
  parts: number;
  filedThrough: number;
  receipts: Bytes[];
  scanThrough: number;
  bodyHash: Bytes;
}
export interface Entry {
  header: EntryHeader;
  body: Bytes;
  signature: Bytes;
  hash: Bytes;
}
export interface PublicRef {
  number: number;
  hash: Bytes;
}
/** What the public entries say (chain.ts PublicState). */
export interface PublicState {
  budgetId: string;
  genesisSignPub: Bytes;
  keyVersion: number;
  signPub: Bytes;
  signKey: CryptoKey;
  signPubs: Map<number, Bytes>;
  inboxVersion: number;
  inboxPub: Bytes;
  lastOldRun: number;
  slots: Map<string, unknown>;
  inboxes: Map<number, Bytes>;
  retiredAt: Map<number, number>;
  prevKeys: Map<number, Bytes>;
  intents: Map<number, { hash: Bytes; time: number; notBefore: number; slotIds: string[] }>;
  lastPublic: PublicRef;
  publics: { number: number; hash: Bytes; keyVersion: number }[];
  time: number;
  filedThrough: number;
}
/** A part set that has started and not finished (chain.ts Pending). */
export interface PendingParts {
  entryId: Bytes;
  kind: number;
  deviceId: string;
  keyVersion: number;
  time: number;
  filedThrough: number;
  scanThrough: number;
  parts: number;
  next: number;
}
export interface ChainState {
  public: PublicState;
  number: number;
  hash: Bytes;
  time: number;
  entryId: Bytes;
  filedThrough: number;
  scanThrough: number;
  counters: Map<string, number>;
  pending: PendingParts | null;
}
export type StoredChain = Omit<ChainState, 'public'> & { public: Omit<PublicState, 'signKey'> };
export const MAX_DEVICES: number;
export const KIND: {
  readonly genesis: 0;
  readonly edit: 1;
  readonly bank: 2;
  readonly scan: 3;
  readonly slotChange: 4;
  readonly keyChange: 5;
  readonly signOut: 6;
  readonly dataMigration: 8;
  readonly intent: 9;
  readonly cancel: 10;
};
export const MAX_WRITE_ENTRIES: number;
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
export class AppendRefused extends Error {
  constructor(why: RefusedWhy, detail?: string);
  readonly retry: boolean;
  readonly why: RefusedWhy;
  readonly detail: string;
}
export interface AppendContext {
  now: number;
  freshWay: boolean;
  schemaVersion: number;
  processingVersion: number;
  stored(entryId: Uint8Array): Promise<Uint8Array[] | null>;
  lastCompleteRun: number;
  receiptHashes(from: number, to: number): Promise<Uint8Array[] | null>;
  resting: boolean;
  keyEntriesLeft: number;
}
export function readEntry(bytes: Uint8Array): Promise<Entry>;
export function encodeEntry(e: Entry): Bytes;
export function checkGenesisWrite(e: Entry, budgetId: string, ctx: AppendContext): Promise<ChainState>;
export function checkWrite(
  s: ChainState,
  entries: Entry[],
  ctx: AppendContext,
): Promise<ChainState | 'already stored'>;
export function toStored(s: ChainState): StoredChain;
export function fromStored(s: StoredChain): Promise<ChainState>;
export function toHex(b: Uint8Array): string;
export function fromHex(s: string): Bytes;

// ---- what a device does to write a log, for the Worker's tests of the log store (test/log-store.test.ts). The
// shapes are loose on purpose: the tests pass these values between the package's own functions.
export type BudgetKeys = { version: number; sign: { pub: Bytes } } & Record<string, unknown>;
export type SlotSecrets = Record<string, unknown>;
/** An entry's header before its body is hashed (entry.ts EntryFields). */
export type EntryFields = Omit<EntryHeader, 'bodyHash'>;
export function randomBytes(n: number): Bytes;
export function utf8(s: string): Bytes;
export function deriveBudgetKeys(bk: Uint8Array, budgetId: string, version: number): Promise<BudgetKeys>;
export function passkeySlot(prf: Uint8Array, budgetId: string, salt: Uint8Array): Promise<SlotSecrets>;
export function recoverySlot(key: Uint8Array, n: number): Promise<SlotSecrets>;
export function newInbox(
  keys: BudgetKeys,
  budgetId: string,
  version: number,
): Promise<{ pair: { pub: Bytes }; wrapped: Bytes }>;
export function newSlotRecord(
  slot: SlotSecrets,
  bk: Uint8Array,
  keys: BudgetKeys,
  budgetId: string,
  signPub: Uint8Array,
): Promise<unknown>;
export function encodeGenesis(g: {
  signPub: Bytes;
  inboxPub: Bytes;
  wrappedInbox: Bytes;
  slots: unknown[];
}): Bytes;
export function publicEntry(fields: EntryFields, body: Uint8Array, keys: BudgetKeys): Promise<Entry>;
export function sealedEntry(fields: EntryFields, plain: Uint8Array, keys: BudgetKeys): Promise<Entry>;

// ---- a device's side of the log (apps/worker/src/local/device-log.ts)
export interface Checker {
  now: number;
  schemaVersion?: number;
}
/** The chain state; once a narrower type of it, kept so device-log.ts reads as before. */
export type FullChainState = ChainState;
export const MAX_PLAIN: number;
export function startChain(genesis: Entry, c: Checker, budgetId?: string): Promise<ChainState>;
export function advance(s: ChainState, e: Entry, c: Checker): Promise<ChainState>;
export function openEntryBody(e: Entry, keys: BudgetKeys): Promise<Bytes>;
export class ChainError extends Error {}
/** Bytes that are not what they claim to be (bytes.ts). */
export class FormatError extends Error {}
/** A sealed value that doesn't open: the wrong key, or changed bytes (aead.ts). */
export class OpenError extends Error {}

// ---- snapshots (apps/worker/src/seal/snapshot-store.ts; packages/seal snapshot.ts)
export interface SnapshotHeader {
  budgetId: string;
  snapshotId: string;
  version: number;
  number: number;
  entryHash: Bytes;
  lastPublic: PublicRef;
  manifestHash: Bytes;
}
export function isPublicKind(kind: number): boolean;
export function walkPublic(
  entries: Entry[],
  budgetId: string,
  bounds?: { mustEndAt?: PublicRef; mustPass?: PublicRef },
): Promise<PublicState>;
export function resumeChain(
  p: PublicState,
  at: PublicRef,
  last: Entry,
  counters: Map<string, number>,
): Promise<ChainState>;
export function readSnapshotHeader(bytes: Uint8Array): SnapshotHeader;
export function verifySnapshotHeader(
  header: Uint8Array,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean>;
export function verifySnapshotCheck(
  header: Uint8Array,
  deviceId: string,
  signature: Uint8Array,
  signPub: Uint8Array | CryptoKey,
): Promise<boolean>;
export interface SnapshotManifest {
  snapshotId: string;
  version: number;
  number: number;
  entryHash: Bytes;
  chunkHashes: Bytes[];
  tables: { name: string; hash: Bytes }[];
  checkpoints: PublicRef[];
  counters: { deviceId: string; counter: number }[];
}
export interface SealedSnapshot {
  header: Bytes;
  signature: Bytes;
  manifest: Bytes;
  chunks: Bytes[];
}
export function sealSnapshot(
  keys: BudgetKeys,
  at: {
    budgetId: string;
    snapshotId: string;
    number: number;
    entryHash: Bytes;
    lastPublic: PublicRef;
    tables: SnapshotManifest['tables'];
    checkpoints: PublicRef[];
    counters: SnapshotManifest['counters'];
  },
  plainChunks: Uint8Array[],
): Promise<SealedSnapshot>;
export function signSnapshotCheck(
  keys: BudgetKeys,
  s: Pick<SealedSnapshot, 'header' | 'signature'>,
  budgetId: string,
  deviceId: string,
): Promise<Bytes>;
export class SnapshotError extends Error {
  readonly why: string;
}
export interface SnapshotBounds {
  publics: { number: number; hash: Uint8Array; keyVersion: number }[];
  minNumber?: number;
  checkpoint?: PublicRef;
}
export function openSnapshotManifest(
  keys: BudgetKeys,
  s: Pick<SealedSnapshot, 'header' | 'signature' | 'manifest'>,
  budgetId: string,
  bounds: SnapshotBounds,
): Promise<{ header: SnapshotHeader; manifest: SnapshotManifest }>;
export function openSnapshotChunk(
  keys: BudgetKeys,
  budgetId: string,
  manifest: SnapshotManifest,
  k: number,
  sealed: Uint8Array,
): Promise<Bytes>;

// ---- the recovery key's sign-in (apps/worker/src/routes/recovery-key.ts; packages/seal recovery.ts)
export function verifyRecoveryLogin(
  authPub: Uint8Array,
  budgetId: string,
  challenge: Uint8Array,
  signature: Uint8Array,
): Promise<boolean>;
export function signRecoveryLogin(
  authPriv: CryptoKey,
  budgetId: string,
  challenge: Uint8Array,
): Promise<Bytes>;
export function newRecoveryKey(): Bytes;
/** A passkey added less than this long ago is a fresh way in (D-89). */
export const FRESH_WAY_MS: number;
export const INTENT_WAIT_MS: number;
export function encodeSlotChange(s: { prevPublic: PublicRef; slots: unknown[] }): Bytes;
export function encodeIntent(i: { prevPublic: PublicRef; notBefore: number; slotIds: string[] }): Bytes;

// Adding a device with its own passkey (docs/privacy-keys.md 10): the sizes the relay checks.
export const ADD_ATTEMPTS: number;
export const ADD_WINDOW_MS: number;
export const ADD_COMMIT_LEN: number;
export const ADD_OFFER_LEN: number;
export const ADD_REVEAL_LEN: number;
export const ADD_SEALED_LEN: number;
export const ADD_CONFIRM_LEN: number;
/** The new device's side of an add (test use only in the Worker; the app runs it). */
export class NewDevice {
  static start(budgetId: string): Promise<NewDevice>;
  readonly commit: Bytes;
  reveal(offer: Uint8Array): Promise<{ reveal: Bytes; code: string; head: PublicRef }>;
  open(sealed: Uint8Array, log: unknown): Promise<{ bk: Bytes; keys: unknown; confirm: Bytes }>;
}
/** The signed-in device's side of an add (test use only in the Worker; the app runs it). */
export class SignedInDevice {
  constructor(budgetId: string, keys: unknown, head: PublicRef);
  offer(commit: Uint8Array, now: number): Bytes;
  code(reveal: Uint8Array, now: number): Promise<string>;
  seal(bk: Uint8Array, now: number): Promise<Bytes>;
  confirmed(bk: Uint8Array, confirm: Uint8Array): Promise<boolean>;
}

// ---- requests signed with the budget's key (apps/worker/src/http/signed-request.ts; packages/seal request.ts)
export const ACTION: {
  readonly storeSignKey: 'store-sign-key';
  readonly storeInboxKey: 'store-inbox-key';
  readonly linkToken: 'link-token';
  readonly removeBank: 'remove-bank';
  readonly deleteAccount: 'delete-account';
  readonly linkFinish: 'link-finish';
  readonly purgeOldCopy: 'purge-old-copy';
  readonly setRecoverySignIn: 'set-recovery-sign-in';
};
export type Action = (typeof ACTION)[keyof typeof ACTION];
export const CHALLENGE_LEN: number;
export function newChallenge(): Bytes;
export function signRequest(
  keys: BudgetKeys,
  budgetId: string,
  action: Action,
  challenge: Uint8Array,
  payload: Uint8Array,
): Promise<Bytes>;
export function verifyRequest(
  signPub: Uint8Array,
  version: number,
  budgetId: string,
  action: string,
  challenge: Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): Promise<boolean>;
