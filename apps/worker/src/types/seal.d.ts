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

// ---- the log (apps/worker/src/seal/log-store.ts). The entry and the chain state are the package's own shapes;
// the Worker reads a few header fields and otherwise only passes them between the package's functions.
export type Bytes = Uint8Array<ArrayBuffer>;
export interface EntryHeader {
  kind: number;
  budgetId: string;
  number: number;
  entryId: Bytes;
  time: number;
  part: number;
  parts: number;
}
export interface Entry {
  header: EntryHeader;
  body: Bytes;
  signature: Bytes;
  hash: Bytes;
}
export interface ChainState {
  number: number;
  hash: Bytes;
  pending: unknown;
}
export type StoredChain = Record<string, unknown> & { number: number };
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
export type EntryFields = Record<string, unknown>;
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
