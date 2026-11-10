// A bank run (docs/privacy-keys.md 9.3): what the Worker fetched from Plaid for one bank link, each page sealed to
// the budget's inbox key the moment it arrives, under a manifest the Worker signs. The seal keeps the server from
// keeping anything readable; the signature and the chain of manifests keep someone who can write to the database,
// but holds no Worker secret, from inventing a run, replaying one, dropping one, or rewinding a link.
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
  u16,
  u32,
  u64,
  u8,
  utf8,
} from './bytes.js';
import { OpenError } from './aead.js';
import { type DhPair, sign, verify } from './curve.js';
import { sha256 } from './hash.js';
import * as hpke from './hpke.js';
import type { ServerKeys } from './server-keys.js';

export const WHAT = { transactions: 0, balances: 1, liabilities: 2, link: 3 } as const;
export type What = (typeof WHAT)[keyof typeof WHAT];

export const FLAG = { balances: 1, liabilities: 2, link: 4 } as const;
export const MAX_PAGES = 4096;
/** How far ahead of the device's clock a run's time may be. */
export const RUN_CLOCK_SLACK_MS = 10 * 60 * 1000;
const ZERO32 = new Uint8Array(32);
const RECEIPT_PART = 32;

export interface RunManifest {
  budgetId: string;
  linkId: string;
  /** The budget's run number: 1, 2, 3 ... across all its links. */
  run: number;
  /** How many times this run started again. */
  restart: number;
  inboxVersion: number;
  /** H(inboxPub) of the inbox key the pages are sealed to. */
  inboxPubHash: Bytes;
  runTime: number;
  /** The time of run - 1; 0 for run 1. */
  prevRunTime: number;
  /** H(cursor) of this link before and after the run. */
  cursorBefore: Bytes;
  cursorAfter: Bytes;
  flags: number;
  added: number;
  modified: number;
  removed: number;
  /** Each page, in order: what it is, and H(sealed page). */
  pages: { what: What; hash: Bytes }[];
  /** H(receipt). */
  receiptHash: Bytes;
  /** H(manifest) of run - 1; zeros for run 1. */
  prevManifestHash: Bytes;
  /** The Worker key number that signs this manifest. */
  n: number;
}

const WHATS: readonly number[] = [0, 1, 2, 3];

/** The flags a list of pages gives: which kinds of page the run holds besides transactions. */
function flagsOf(pages: { what: number }[]): number {
  let flags = 0;
  for (const p of pages)
    if (p.what === WHAT.balances) flags |= FLAG.balances;
    else if (p.what === WHAT.liabilities) flags |= FLAG.liabilities;
    else if (p.what === WHAT.link) flags |= FLAG.link;
  return flags;
}

const whole = (n: number, max: number, min = 0): boolean => Number.isInteger(n) && n >= min && n <= max;

function checkManifest(m: RunManifest): void {
  if (!isUlid(m.budgetId) || !isUlid(m.linkId)) throw new FormatError('id');
  if (!whole(m.run, Number.MAX_SAFE_INTEGER, 1) || !whole(m.restart, 0xffffffff))
    throw new FormatError('run');
  if (!whole(m.inboxVersion, 0xffffffff, 1) || !whole(m.n, 0xffffffff, 1)) throw new FormatError('version');
  if (!whole(m.runTime, Number.MAX_SAFE_INTEGER) || !whole(m.prevRunTime, Number.MAX_SAFE_INTEGER))
    throw new FormatError('time');
  if (!whole(m.flags, 7)) throw new FormatError('flags');
  for (const c of [m.added, m.modified, m.removed]) if (!whole(c, 0xffffffff)) throw new FormatError('count');
  if (m.pages.length < 1 || m.pages.length > MAX_PAGES) throw new FormatError('page count');
  if (m.pages.some((p) => !WHATS.includes(p.what))) throw new FormatError('what');
  if (flagsOf(m.pages) !== m.flags) throw new FormatError('flags');
  for (const h of [
    m.inboxPubHash,
    m.cursorBefore,
    m.cursorAfter,
    m.receiptHash,
    m.prevManifestHash,
    ...m.pages.map((p) => p.hash),
  ])
    if (h.length !== 32) throw new FormatError('hash');
  if ((m.run === 1) !== equal(m.prevManifestHash, ZERO32)) throw new FormatError('previous manifest');
  if (m.run === 1 && m.prevRunTime !== 0) throw new FormatError('previous run time');
}

export function encodeRunManifest(m: RunManifest): Bytes {
  checkManifest(m);
  return concat(
    utf8('LLR1'),
    str(m.budgetId),
    str(m.linkId),
    u64(m.run),
    u32(m.restart),
    u32(m.inboxVersion),
    m.inboxPubHash,
    u64(m.runTime),
    u64(m.prevRunTime),
    m.cursorBefore,
    m.cursorAfter,
    u8(m.flags),
    u32(m.added),
    u32(m.modified),
    u32(m.removed),
    u16(m.pages.length),
    ...m.pages.map((p) => concat(u8(p.what), p.hash)),
    m.receiptHash,
    m.prevManifestHash,
    u32(m.n),
  );
}

export function readRunManifest(bytes: Uint8Array): RunManifest {
  const r = new Reader(bytes);
  r.magic('LLR1');
  const budgetId = r.text(26);
  const linkId = r.text(26);
  const run = r.u64();
  const restart = r.u32();
  const inboxVersion = r.u32();
  const inboxPubHash = r.take(32);
  const runTime = r.u64();
  const prevRunTime = r.u64();
  const cursorBefore = r.take(32);
  const cursorAfter = r.take(32);
  const flags = r.u8();
  const added = r.u32();
  const modified = r.u32();
  const removed = r.u32();
  const pages = r.u16();
  if (pages < 1 || pages > MAX_PAGES) throw new FormatError('page count');
  const list: RunManifest['pages'] = [];
  for (let i = 0; i < pages; i++) list.push({ what: r.u8() as What, hash: r.take(32) });
  const m: RunManifest = {
    budgetId,
    linkId,
    run,
    restart,
    inboxVersion,
    inboxPubHash,
    runTime,
    prevRunTime,
    cursorBefore,
    cursorAfter,
    flags,
    added,
    modified,
    removed,
    pages: list,
    receiptHash: r.take(32),
    prevManifestHash: r.take(32),
    n: r.u32(),
  };
  r.end();
  checkManifest(m);
  return m;
}

/** The hash of a link's cursor as manifests name it. A link that has never run has the empty cursor. */
export function cursorHash(cursor: string): Promise<Bytes> {
  return sha256(utf8(cursor));
}

const pageInfo = (budgetId: string, linkId: string, inboxVersion: number): Bytes =>
  concat(label('ledgerline/v1/hpke/inbox'), str(budgetId), str(linkId), u32(inboxVersion));
const pageAad = (run: number, restart: number, p: number, what: What): Bytes =>
  concat(u64(run), u32(restart), u16(p), u8(what));
const receiptOf = (parts: Uint8Array[]): Promise<Bytes> =>
  sha256(concat(label('ledgerline/v1/receipt'), ...parts));
const runMessage = async (manifest: Uint8Array): Promise<Bytes> =>
  concat(label('ledgerline/v1/run'), await sha256(manifest));

/** What the Worker hands a device for one run, and keeps until a checked snapshot covers it. */
export interface SealedRun {
  manifest: Bytes;
  signature: Bytes;
  pages: Bytes[];
}

/**
 * The Worker's side: seals each page of a run to the inbox key and signs the manifest. Each page starts with 32
 * random bytes; the receipt is the hash of all of them, so only a device that opened every page can show it. The
 * Worker keeps `H(receipt)` (in the manifest) and forgets the rest.
 */
export async function sealRun(
  k: ServerKeys,
  inboxPub: Uint8Array,
  run: Omit<RunManifest, 'inboxPubHash' | 'pages' | 'receiptHash' | 'n' | 'flags'>,
  pages: { what: What; payload: Uint8Array }[],
): Promise<SealedRun> {
  if (pages.length < 1 || pages.length > MAX_PAGES) throw new RangeError('page count');
  if (inboxPub.length !== 32) throw new RangeError('inbox key');
  const info = pageInfo(run.budgetId, run.linkId, run.inboxVersion);
  const parts: Bytes[] = [];
  const sealed: Bytes[] = [];
  for (let p = 0; p < pages.length; p++) {
    const { what, payload } = pages[p]!;
    if (!WHATS.includes(what)) throw new RangeError('what');
    const r = randomBytes(RECEIPT_PART);
    parts.push(r);
    sealed.push(await hpke.seal(inboxPub, info, pageAad(run.run, run.restart, p, what), concat(r, payload)));
  }
  const list: RunManifest['pages'] = [];
  for (let p = 0; p < pages.length; p++) list.push({ what: pages[p]!.what, hash: await sha256(sealed[p]!) });
  const manifest = encodeRunManifest({
    ...run,
    inboxPubHash: await sha256(inboxPub),
    flags: flagsOf(list),
    pages: list,
    receiptHash: await sha256(await receiptOf(parts)),
    n: k.n,
  });
  for (const r of parts) r.fill(0);
  return { manifest, pages: sealed, signature: await sign(k.runSign.privateKey, await runMessage(manifest)) };
}

/** A run a device refuses to file: the server sent what the Worker could not have made, or out of order. */
export class RunError extends Error {
  constructor(readonly why: string) {
    super(`run: ${why}`);
  }
}

const refuse = (why: string): never => {
  throw new RunError(why);
};

/** What a device knows when a run arrives. */
export interface FilingState {
  budgetId: string;
  /** The Worker's run-signing public keys this app accepts, by key number (9.1). */
  workerKeys: Map<number, Uint8Array>;
  /** The last run this budget has filed; 0 before any. */
  filedThrough: number;
  /** Of that run: H(manifest), its time, and its inbox version. Zeros and 0 before any. */
  lastManifestHash: Uint8Array;
  lastRunTime: number;
  lastInboxVersion: number;
  /** H(cursor after) of the last run filed for each link. */
  cursors: Map<string, Uint8Array>;
  /** From the log's public state: the inbox version in force, and the last run that existed at the last key change. */
  inboxVersion: number;
  lastOldRun: number;
  /** The inbox pair for a version this device still holds, or null. */
  inbox(version: number): Promise<DhPair | null>;
  /** The device's clock, Unix milliseconds. */
  now: number;
}

export interface FiledRun {
  manifest: RunManifest;
  manifestHash: Bytes;
  /** Each page's payload, without its receipt bytes, with what it is. */
  pages: { what: What; payload: Bytes }[];
  /** What the filing entry shows for this run. */
  receipt: Bytes;
}

/**
 * A device's side: checks a run and opens it, or throws RunError (9.3). The run must be signed by a Worker key this
 * app accepts; be the next run, chained to the one before; be sealed to an inbox key that is the right one for its
 * number; continue its link's cursor; hold exactly the pages the manifest names; and not be dated in the future.
 */
export async function openRun(s: FilingState, run: SealedRun): Promise<FiledRun> {
  let m: RunManifest;
  try {
    m = readRunManifest(run.manifest);
  } catch (e) {
    if (e instanceof FormatError) return refuse(`manifest: ${e.message}`);
    throw e;
  }
  const workerKey = s.workerKeys.get(m.n);
  if (!workerKey || !(await verify(workerKey, await runMessage(run.manifest), run.signature)))
    refuse('signature');
  if (m.budgetId !== s.budgetId) refuse('another budget');
  if (m.run !== s.filedThrough + 1) refuse('not the next run');
  if (!equal(m.prevManifestHash, m.run === 1 ? ZERO32 : s.lastManifestHash))
    refuse('not chained to the run before');
  if (m.prevRunTime !== s.lastRunTime || m.runTime <= m.prevRunTime) refuse('run time');
  if (m.runTime > s.now + RUN_CLOCK_SLACK_MS) refuse('dated in the future');

  // The inbox key: never an older one than the run before used; after the last key change's runs, only the one in
  // force. An older key put back with its valid stamp would send new bank data to a key a removed way in holds.
  if (m.inboxVersion < s.lastInboxVersion || m.inboxVersion > s.inboxVersion) refuse('inbox version');
  if (m.run > s.lastOldRun && m.inboxVersion !== s.inboxVersion) refuse('sealed to a replaced inbox key');
  const inbox = await s.inbox(m.inboxVersion);
  if (!inbox) return refuse('no inbox key for this run');
  if (!equal(await sha256(inbox.pub), m.inboxPubHash)) refuse('inbox key');

  // The link's cursor continues from the last run filed for it: a rewound link shows here.
  const before = s.cursors.get(m.linkId) ?? (await cursorHash(''));
  if (!equal(m.cursorBefore, before)) refuse('cursor does not continue');

  if (run.pages.length !== m.pages.length) refuse('page count');
  const info = pageInfo(m.budgetId, m.linkId, m.inboxVersion);
  const parts: Bytes[] = [];
  const pages: FiledRun['pages'] = [];
  for (let p = 0; p < run.pages.length; p++) {
    const sealed = run.pages[p]!;
    const { what, hash } = m.pages[p]!;
    if (!equal(await sha256(sealed), hash)) refuse('page hash');
    let plain: Bytes;
    try {
      plain = await hpke.open(inbox, info, pageAad(m.run, m.restart, p, what), sealed);
    } catch (e) {
      if (e instanceof OpenError) return refuse('a page does not open');
      throw e;
    }
    if (plain.length < RECEIPT_PART) return refuse('a page does not open');
    parts.push(plain.slice(0, RECEIPT_PART) as Bytes);
    pages.push({ what, payload: plain.slice(RECEIPT_PART) as Bytes });
  }
  const receipt = await receiptOf(parts);
  if (!equal(await sha256(receipt), m.receiptHash)) refuse('receipt');
  return { manifest: m, manifestHash: await sha256(run.manifest), pages, receipt };
}

/** The filing state after a run is filed. */
export function afterRun(s: FilingState, filed: FiledRun): FilingState {
  const m = filed.manifest;
  return {
    ...s,
    filedThrough: m.run,
    lastManifestHash: filed.manifestHash,
    lastRunTime: m.runTime,
    lastInboxVersion: m.inboxVersion,
    cursors: new Map(s.cursors).set(m.linkId, m.cursorAfter),
  };
}

/**
 * The server's side of filing: whether the receipts a bank entry shows are those of exactly the next runs, given the
 * `H(receipt)` the Worker stored for each, in run order.
 */
export async function checkReceipts(receipts: Uint8Array[], storedHashes: Uint8Array[]): Promise<boolean> {
  if (receipts.length !== storedHashes.length) return false;
  let ok = true;
  for (let i = 0; i < receipts.length; i++)
    if (!equal(await sha256(receipts[i]!), storedHashes[i]!)) ok = false;
  return ok;
}
