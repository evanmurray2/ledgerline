// A bank run (docs/privacy-keys.md 9.3): what the Worker fetched from Plaid for one bank link, each page sealed to
// the budget's inbox key the moment it arrives, under a manifest the Worker signs. The seal keeps the server from
// keeping anything readable; the signature and the chain of manifests keep someone who can write to the database,
// but holds no Worker secret, from inventing a run, replaying one, dropping one, or rewinding a link.
//
// The Worker's side is two functions, because each page is its own job step (10 ms of CPU): `sealPage` for a page,
// and `signRun` once the run is complete.
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
import { OpenError } from './aead.js';
import { type DhPair, sign, verify } from './curve.js';
import { hmac, sha256 } from './hash.js';
import * as hpke from './hpke.js';
import type { ServerKeys } from './server-keys.js';

export const WHAT = { transactions: 0, balances: 1, liabilities: 2, link: 3 } as const;
export type What = (typeof WHAT)[keyof typeof WHAT];

export const FLAG = { balances: 1, liabilities: 2, link: 4 } as const;
export const MAX_PAGES = 4096;
export const MAX_RECEIPTS_PER_ENTRY = 256;
/** How far ahead of the device's clock a run's time may be. */
export const RUN_CLOCK_SLACK_MS = 10 * 60 * 1000;
const ZERO32 = new Uint8Array(32);
const RECEIPT_PART = 32;
const WHATS: readonly number[] = [0, 1, 2, 3];

export interface RunPage {
  what: What;
  /** H(sealed page). */
  hash: Bytes;
}

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
  /** Later than the run before: the Worker uses the later of its clock and 1 ms after that run. */
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
  /** Each page, in order. */
  pages: RunPage[];
  /** H(receipt). */
  receiptHash: Bytes;
  /** H(manifest) of run - 1; zeros for run 1. */
  prevManifestHash: Bytes;
  /** The Worker key number that signs this manifest. */
  n: number;
}

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

/** What is wrong with a manifest's fields, or null. */
function manifestFault(m: RunManifest): string | null {
  if (!isUlid(m.budgetId) || !isUlid(m.linkId)) return 'id';
  if (!whole(m.run, Number.MAX_SAFE_INTEGER, 1) || !whole(m.restart, 0xffffffff)) return 'run';
  if (!whole(m.inboxVersion, 0xffffffff, 1) || !whole(m.n, 0xffffffff, 1)) return 'version';
  if (!whole(m.runTime, Number.MAX_SAFE_INTEGER) || !whole(m.prevRunTime, Number.MAX_SAFE_INTEGER))
    return 'time';
  // A run's time is later than the run before, or no device would ever file it and every later run chains to it.
  if (m.runTime <= m.prevRunTime) return 'run time';
  for (const c of [m.added, m.modified, m.removed]) if (!whole(c, 0xffffffff)) return 'count';
  if (m.pages.length < 1 || m.pages.length > MAX_PAGES) return 'page count';
  if (m.pages.some((p) => !WHATS.includes(p.what))) return 'what';
  if (!whole(m.flags, 7) || flagsOf(m.pages) !== m.flags) return 'flags';
  for (const h of [m.inboxPubHash, m.cursorBefore, m.cursorAfter, m.receiptHash, m.prevManifestHash])
    if (h.length !== 32) return 'hash';
  if (m.pages.some((p) => p.hash.length !== 32)) return 'hash';
  if ((m.run === 1) !== equal(m.prevManifestHash, ZERO32)) return 'previous manifest';
  if (m.run === 1 && m.prevRunTime !== 0) return 'previous run time';
  return null;
}

/** Writes a manifest. A field a writer got wrong is the writer's mistake: RangeError. */
export function encodeRunManifest(m: RunManifest): Bytes {
  const fault = manifestFault(m);
  if (fault) throw new RangeError(`run manifest: ${fault}`);
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

/** Reads a manifest. One that doesn't hold together is refused whole: FormatError. */
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
  const count = r.u16();
  if (count < 1 || count > MAX_PAGES) throw new FormatError('page count');
  const pages: RunPage[] = [];
  for (let i = 0; i < count; i++) pages.push({ what: r.u8() as What, hash: r.take(32) });
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
    pages,
    receiptHash: r.take(32),
    prevManifestHash: r.take(32),
    n: r.u32(),
  };
  r.end();
  const fault = manifestFault(m);
  if (fault) throw new FormatError(fault);
  return m;
}

/** The hash of a link's cursor as manifests name it. A link that has never run has the empty cursor. */
export function cursorHash(cursor: string): Promise<Bytes> {
  return sha256(utf8(cursor));
}

/** Where a page sits. */
export interface PagePlace {
  budgetId: string;
  linkId: string;
  inboxVersion: number;
  run: number;
  restart: number;
  /** The page's place in the run, from 0. */
  page: number;
}

function checkPlace(at: PagePlace): void {
  if (!isUlid(at.budgetId) || !isUlid(at.linkId)) throw new RangeError('id');
  if (!whole(at.run, Number.MAX_SAFE_INTEGER, 1) || !whole(at.restart, 0xffffffff))
    throw new RangeError('run');
  if (!whole(at.inboxVersion, 0xffffffff, 1)) throw new RangeError('inbox version');
  if (!whole(at.page, MAX_PAGES - 1)) throw new RangeError('page');
}

const pageInfo = (budgetId: string, linkId: string, inboxVersion: number): Bytes =>
  concat(label('ledgerline/v1/hpke/inbox'), str(budgetId), str(linkId), u32(inboxVersion));
const pageAad = (run: number, restart: number, p: number, what: What): Bytes =>
  concat(u64(run), u32(restart), u16(p), u8(what));
const receiptOf = (parts: Uint8Array[]): Promise<Bytes> =>
  sha256(concat(label('ledgerline/v1/receipt'), ...parts));
const runMessage = async (manifest: Uint8Array): Promise<Bytes> =>
  concat(label('ledgerline/v1/run'), await sha256(manifest));

/**
 * The 32 bytes that start a page's plain text. They come from the Worker's HMAC key and the page's place, so the
 * Worker keeps nothing secret between sealing a page and signing its run, and nobody without that key can guess them.
 */
function receiptPart(k: ServerKeys, at: PagePlace): Promise<Bytes> {
  return hmac(
    k.mac,
    concat(
      label('ledgerline/v1/receipt-part'),
      str(at.budgetId),
      str(at.linkId),
      u64(at.run),
      u32(at.restart),
      u16(at.page),
    ),
  );
}

/**
 * The Worker's side, one page: seals the page to the inbox key. One job step per page. The page's plain text is
 * `r || payload`, and the copy made here is zeroed before the function returns.
 */
export async function sealPage(
  k: ServerKeys,
  inboxPub: Uint8Array,
  at: PagePlace,
  what: What,
  payload: Uint8Array,
): Promise<{ sealed: Bytes; page: RunPage }> {
  checkPlace(at);
  if (!WHATS.includes(what)) throw new RangeError('what');
  if (inboxPub.length !== 32) throw new RangeError('inbox key');
  const r = await receiptPart(k, at);
  const plain = concat(r, payload);
  try {
    const sealed = await hpke.seal(
      inboxPub,
      pageInfo(at.budgetId, at.linkId, at.inboxVersion),
      pageAad(at.run, at.restart, at.page, what),
      plain,
    );
    return { sealed, page: { what, hash: await sha256(sealed) } };
  } finally {
    r.fill(0);
    plain.fill(0);
  }
}

/** The run must start again: a key change landed while it was being fetched, and its pages are sealed to the old inbox key. */
export class RestartRun extends Error {
  constructor() {
    super('restart this run: its pages are sealed to a replaced inbox key');
  }
}

/**
 * The Worker's side, last step: signs the manifest of a complete run. `inForce` is read in the transaction that
 * completes the run: the inbox version in force, and the last run that may still be sealed to the run's own inbox
 * version if that version was replaced (the `lastOldRun` of the key change that replaced it). A run past that number
 * sealed to a replaced key is thrown back to be fetched again, or no device would ever file it.
 */
export async function signRun(
  k: ServerKeys,
  inboxPub: Uint8Array,
  run: Omit<RunManifest, 'inboxPubHash' | 'receiptHash' | 'n' | 'flags'>,
  inForce: { inboxVersion: number; lastRunForOld: number },
): Promise<{ manifest: Bytes; signature: Bytes }> {
  if (inboxPub.length !== 32) throw new RangeError('inbox key');
  if (run.inboxVersion > inForce.inboxVersion) throw new RangeError('inbox version');
  if (run.inboxVersion !== inForce.inboxVersion && run.run > inForce.lastRunForOld) throw new RestartRun();
  const parts: Bytes[] = [];
  try {
    for (let p = 0; p < run.pages.length; p++) parts.push(await receiptPart(k, { ...run, page: p }));
    const receipt = await receiptOf(parts);
    const manifest = encodeRunManifest({
      ...run,
      inboxPubHash: await sha256(inboxPub),
      flags: flagsOf(run.pages),
      receiptHash: await sha256(receipt),
      n: k.n,
    });
    receipt.fill(0);
    return { manifest, signature: await sign(k.runSign.privateKey, await runMessage(manifest)) };
  } finally {
    for (const r of parts) r.fill(0);
  }
}

/** What the Worker hands a device for one run, and keeps until a checked snapshot covers it. */
export interface SealedRun {
  manifest: Bytes;
  signature: Bytes;
  pages: Bytes[];
}

/**
 * A run a device doesn't file. `retry` is true when the cause may be the device itself and not the run: its clock is
 * behind, it hasn't taken the log entry that brings a new inbox key, or it doesn't hold the inbox key yet. Such a run
 * is tried again later; any other is the server sending what the Worker could not have made, or out of order.
 */
export class RunError extends Error {
  constructor(
    readonly why: string,
    readonly retry = false,
  ) {
    super(`run: ${why}`);
  }
}

const refuse = (why: string, retry = false): never => {
  throw new RunError(why, retry);
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
  /** From the log's public state (chain.ts): the inbox version in force... */
  inboxVersion: number;
  /** ...and, for each inbox version a key change replaced, the last run that may be sealed to it. */
  retiredAt: Map<number, number>;
  /** The inbox pair for a version this device holds, or null. */
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
  if (m.prevRunTime !== s.lastRunTime) refuse('run time does not follow the run before');
  if (m.runTime > s.now + RUN_CLOCK_SLACK_MS) refuse('dated in the future', true);

  // The inbox key. Never an older one than the run before used. A replaced one only for the runs that existed when
  // it was replaced: an old inbox key put back with its valid stamp would otherwise send new bank data to a key a
  // removed way in holds. And never a newer one than the log has brought this device.
  if (m.inboxVersion > s.inboxVersion) refuse('sealed to an inbox key this device has not reached', true);
  if (m.inboxVersion < s.lastInboxVersion) refuse('sealed to an older inbox key than the run before');
  if (m.inboxVersion !== s.inboxVersion && m.run > (s.retiredAt.get(m.inboxVersion) ?? 0))
    refuse('sealed to a replaced inbox key');
  const inbox = await s.inbox(m.inboxVersion);
  if (!inbox) return refuse('no inbox key for this run', true);
  if (!equal(await sha256(inbox.pub), m.inboxPubHash)) refuse('not the inbox key the log names');

  // The link's cursor continues from the last run filed for it: a rewound link shows here. A link's first run, and
  // only that one, carries its description.
  const known = s.cursors.get(m.linkId);
  if (!equal(m.cursorBefore, known ?? (await cursorHash('')))) refuse('cursor does not continue');
  if (((m.flags & FLAG.link) !== 0) !== (known === undefined)) refuse('link description');

  if (run.pages.length !== m.pages.length) refuse('page count');
  const info = pageInfo(m.budgetId, m.linkId, m.inboxVersion);
  const parts: Bytes[] = [];
  const pages: FiledRun['pages'] = [];
  try {
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
      plain.fill(0);
    }
    const receipt = await receiptOf(parts);
    if (!equal(await sha256(receipt), m.receiptHash)) refuse('receipt');
    return { manifest: m, manifestHash: await sha256(run.manifest), pages, receipt };
  } finally {
    for (const r of parts) r.fill(0);
  }
}

/** The filing state after a run is filed. The run must be the one `openRun` just opened against this state. */
export function afterRun(s: FilingState, filed: FiledRun): FilingState {
  const m = filed.manifest;
  if (m.budgetId !== s.budgetId || m.run !== s.filedThrough + 1 || m.prevRunTime !== s.lastRunTime)
    throw new RangeError('not the next run');
  if (!equal(m.prevManifestHash, m.run === 1 ? ZERO32 : s.lastManifestHash))
    throw new RangeError('not the next run');
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
 * `H(receipt)` the Worker stored for each, in run order. Between 1 and 256 runs.
 */
export async function checkReceipts(receipts: Uint8Array[], storedHashes: Uint8Array[]): Promise<boolean> {
  if (receipts.length < 1 || receipts.length > MAX_RECEIPTS_PER_ENTRY) return false;
  if (receipts.length !== storedHashes.length) return false;
  let ok = true;
  for (let i = 0; i < receipts.length; i++)
    if (!equal(await sha256(receipts[i]!), storedHashes[i]!)) ok = false;
  return ok;
}
