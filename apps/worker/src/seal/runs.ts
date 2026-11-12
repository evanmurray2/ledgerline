// Bank runs of a sealed budget (docs/privacy.md 5.5; docs/privacy-keys.md 9; store migration 0006). The fetch
// step seals each page to the budget's inbox key the moment it arrives, and signs the run when it is whole. The
// server keeps no readable page, in the database or between steps: a page is fetched and sealed in one step.
//
// Everything the Worker reads back from the database to decide where bank data goes, or what it signs, is under
// one of its stamps, since someone may have written to the database: the inbox key (`keyMac`), the bank link
// (`linkMac`), the budget's whole run state (`runsMac`), and the run being fetched (the stage's own stamp, which
// also covers a running hash of its pages). A bad stamp stops the fetch (`BadStamp`); it never seals to an
// unstamped key or signs what it did not fetch. The one thing with no stamp is the log's state, which says which
// inbox version is in force: a changed one can only point at an older stamped key, never older than the last
// signed run's, and a device refuses such a run (9.3 check 3).
//
// Each exported step is one job step, safe to run again. Nothing calls this before the cutover.
import { MUTATION_DURING_PAGINATION, ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db, Stmt } from '@ledgerline/db/sql';
import { decryptToken, tokenKeyBytes, type TokenKeyring } from '@ledgerline/platform';
import {
  checkKeyMac,
  checkLinkMac,
  checkRunsMac,
  concat,
  cursorHash,
  fromHex,
  hmac,
  hmacVerify,
  isUlid,
  KEY_KIND,
  keyMac,
  label,
  readRunManifest,
  RestartRun,
  runsMac,
  sealPage,
  serverKeys,
  sha256,
  signRun,
  str,
  toHex,
  u16,
  u32,
  u64,
  u8,
  WHAT,
  type ChainState,
  type RunState,
  type ServerKeys,
  type What,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort, LEASE_TTL_MS, MAX_FETCH_RESTARTS } from '../sync/lease.js';
import { stateFromJson } from './log-store.js';

/** A value the Worker must have stamped has no good stamp: the database was changed from outside, or lost a row. */
export class BadStamp extends Error {
  constructor(readonly what: 'inbox key' | 'link' | 'run state' | 'run stage') {
    super(`bad stamp: ${what}`);
  }
}

/** The run can't go on as it is (another step moved it, or the bank restarted it too often). */
export class RunStopped extends Error {}

/** The Worker's keys by key number, from the keyring that encrypts bank tokens (9.1). */
export interface WorkerKeys {
  current: number;
  /** Rejects for a key number the keyring doesn't hold. */
  keysFor(n: number): Promise<ServerKeys>;
}

export function workerKeys(ring: TokenKeyring): WorkerKeys {
  const made = new Map<number, Promise<ServerKeys>>();
  return {
    current: ring.current,
    keysFor(n) {
      let k = made.get(n);
      if (!k) {
        const secret = ring.keys[n];
        if (secret === undefined) return Promise.reject(new Error(`no Worker key ${n}`));
        k = tokenKeyBytes(secret).then(async (raw) => {
          try {
            return await serverKeys(raw, n);
          } finally {
            raw.fill(0);
          }
        });
        made.set(n, k);
      }
      return k;
    },
  };
}

export interface RunDeps {
  db: Db;
  budgetId: string;
  /** Opens a link's bank token. */
  ring: TokenKeyring;
  keys: WorkerKeys;
}

export const runDeps = (db: Db, budgetId: string, ring: TokenKeyring): RunDeps => ({
  db,
  budgetId,
  ring,
  keys: workerKeys(ring),
});

const ZERO_HASH = '0'.repeat(64);
const bytesOf = (v: unknown): Uint8Array<ArrayBuffer> =>
  v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v as ArrayBuffer);
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** Hex from the database: text that is no hex is no bytes, and fails whatever check comes next. */
const hexOr = (s: unknown): Uint8Array<ArrayBuffer> => {
  try {
    return fromHex(String(s));
  } catch {
    return new Uint8Array(0);
  }
};

// ---- the stamps on keys

/**
 * The stamps for the keys in force after a stored write, when the write changed them: the first entry's signing
 * and inbox keys, and those of a key change. `before` is the chain before the write (null for the first entry).
 * The log store adds these statements to the step that stores the write, so the keys in force always have their
 * stamps. The first entry also starts the budget's run state, at no run. The write passed the log's rules, so
 * its keys replace whatever a row held.
 */
export async function keyStampStmts(
  d: RunDeps,
  before: ChainState | null,
  after: ChainState,
  now: number,
): Promise<Stmt[]> {
  const a = after.public;
  const sign = !before || before.public.keyVersion !== a.keyVersion;
  const inbox = !before || before.public.inboxVersion !== a.inboxVersion;
  // Most writes bring no key: they cost no key derivation.
  if (!sign && !inbox) return [];
  const k = await d.keys.keysFor(d.keys.current);
  const out: Stmt[] = [];
  const stamp = async (kind: 1 | 2, version: number, pub: Uint8Array) => {
    const mac = await keyMac(k, d.budgetId, version, kind, pub);
    out.push(
      d.db
        .prepare(
          `INSERT INTO key_stamp (kind, version, pub, mac, n, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (kind, version) DO UPDATE SET pub = excluded.pub, mac = excluded.mac, n = excluded.n`,
        )
        .bind(kind, version, toHex(pub), toHex(mac), k.n, now),
    );
  };
  if (sign) await stamp(KEY_KIND.sign, a.keyVersion, a.signPub);
  if (inbox) await stamp(KEY_KIND.inbox, a.inboxVersion, a.inboxPub);
  if (!before) {
    const mac = toHex(
      await runsMac(k, d.budgetId, await runStateOf({ run: 0, hash: ZERO_HASH, time: 0 }, [])),
    );
    out.push(
      d.db
        .prepare(
          `INSERT INTO run_state (id, run, last_manifest_hash, last_run_time, mac, n, updated_at)
           VALUES (1, 0, ?1, 0, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET run = 0, last_manifest_hash = excluded.last_manifest_hash,
             last_run_time = 0, mac = excluded.mac, n = excluded.n, updated_at = excluded.updated_at`,
        )
        .bind(ZERO_HASH, mac, k.n, now),
    );
  }
  return out;
}

/**
 * The cutover of a budget that already has bank links (section 8 step 6): each link starts at its cutover
 * cursor, with no run yet. Only for a budget whose runs have not started; the run state gets its stamp anew.
 */
export async function startLinks(d: RunDeps, cursors: Cursors, now: number): Promise<void> {
  const { s } = await standing(d);
  if (s.run !== 0) throw new RunStopped('runs have started');
  const k = await d.keys.keysFor(d.keys.current);
  const mac = toHex(await runsMac(k, d.budgetId, await runStateOf(s, cursors)));
  await d.db.batch([
    conditionFence(
      d.db,
      `SELECT (SELECT run FROM run_state WHERE id = 1) = 0 AND NOT EXISTS (SELECT 1 FROM run_stage)`,
    ),
    d.db.prepare(`DELETE FROM link_cursor`),
    ...cursors.map((c) =>
      d.db
        .prepare(`INSERT INTO link_cursor (link_id, cursor, updated_at) VALUES (?1, ?2, ?3)`)
        .bind(c.linkId, c.cursor, now),
    ),
    d.db.prepare(`UPDATE run_state SET mac = ?1, n = ?2, updated_at = ?3 WHERE id = 1`).bind(mac, k.n, now),
  ]);
}

/** A key the Worker stamped, by kind and version; throws when the row is missing or its stamp is bad. */
async function stampedKey(d: RunDeps, kind: 1 | 2, version: number): Promise<Uint8Array<ArrayBuffer>> {
  const r = await d.db
    .prepare(`SELECT pub, mac, n FROM key_stamp WHERE kind = ?1 AND version = ?2`)
    .bind(kind, version)
    .first<{ pub: string; mac: string; n: number }>();
  if (!r) throw new BadStamp('inbox key');
  const pub = hexOr(r.pub);
  const k = await d.keys.keysFor(r.n).catch(() => null);
  if (!k || !(await checkKeyMac(k, d.budgetId, version, kind, pub, hexOr(r.mac))))
    throw new BadStamp('inbox key');
  return pub;
}

/**
 * What the log has in force: its last entry's number, the inbox version, and for each replaced version the last
 * run that may be sealed to it. The log's state has no stamp (see the top of this file).
 */
async function inForce(
  db: Db,
): Promise<{ number: number; inboxVersion: number; retiredAt: Map<number, number> }> {
  const r = await db
    .prepare(`SELECT number, state FROM log_state WHERE id = 1`)
    .first<{ number: number; state: string }>();
  if (!r) throw new BadStamp('inbox key');
  let p: { inboxVersion?: unknown; retiredAt?: unknown } | undefined;
  try {
    p = (stateFromJson(r.state) as unknown as { public?: typeof p }).public;
  } catch {
    p = undefined;
  }
  const v = p?.inboxVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || !(p?.retiredAt instanceof Map))
    throw new BadStamp('inbox key');
  return { number: r.number, inboxVersion: v, retiredAt: p.retiredAt as Map<number, number> };
}

// ---- the run state

interface Standing {
  run: number;
  /** Hex. */
  hash: string;
  time: number;
}
type Cursors = { linkId: string; cursor: string }[];

async function runStateOf(s: Standing, cursors: Cursors): Promise<RunState> {
  const links = [];
  for (const c of cursors) links.push({ linkId: c.linkId, cursorHash: await cursorHash(c.cursor) });
  return { run: s.run, lastManifestHash: hexOr(s.hash), lastRunTime: s.time, links };
}

/**
 * The budget's run state, checked against its stamp, with the inbox version of the last run: its manifest is the
 * one the stamped state names by hash. No run goes back to an older inbox key than the run before.
 */
async function standing(d: RunDeps): Promise<{ s: Standing; cursors: Cursors; lastInbox: number }> {
  const r = await d.db
    .prepare(`SELECT run, last_manifest_hash, last_run_time, mac, n FROM run_state WHERE id = 1`)
    .first<{ run: number; last_manifest_hash: string; last_run_time: number; mac: string; n: number }>();
  if (!r) throw new BadStamp('run state');
  const rows = await d.db
    .prepare(`SELECT link_id, cursor FROM link_cursor ORDER BY link_id`)
    .all<{ link_id: string; cursor: string }>();
  const cursors = rows.results.map((x) => ({ linkId: x.link_id, cursor: x.cursor }));
  const s = { run: r.run, hash: r.last_manifest_hash, time: r.last_run_time };
  const k = await d.keys.keysFor(r.n).catch(() => null);
  if (!k || !(await checkRunsMac(k, d.budgetId, await runStateOf(s, cursors), hexOr(r.mac))))
    throw new BadStamp('run state');
  if (s.run === 0) return { s, cursors, lastInbox: 0 };
  const last = await d.db
    .prepare(`SELECT manifest FROM sealed_run WHERE run = ?1`)
    .bind(s.run)
    .first<{ manifest: unknown }>();
  if (!last) throw new BadStamp('run state');
  const manifest = bytesOf(last.manifest);
  if (toHex(await sha256(manifest)) !== s.hash) throw new BadStamp('run state');
  return { s, cursors, lastInbox: readRunManifest(manifest).inboxVersion };
}

// ---- the run being fetched, under its own stamp

export interface Stage {
  linkId: string;
  run: number;
  restart: number;
  /** Restarts the bank asked for; these have a limit. */
  bankRestarts: number;
  inboxVersion: number;
  n: number;
  startCursor: string;
  cursor: string;
  hasMore: boolean;
  /** The link's first run: it holds the link's description and no transactions (9.3 check 4). */
  describes: boolean;
  pages: number;
  added: number;
  modified: number;
  removed: number;
  /** Hex: zeros, then H(pagesHash || what || H(sealed page)) for each page stored. */
  pagesHash: string;
  startedAt: number;
}

interface StageRow {
  link_id: string;
  run: number;
  restart: number;
  bank_restarts: number;
  inbox_version: number;
  n: number;
  start_cursor: string;
  cursor: string;
  has_more: number;
  describes: number;
  pages: number;
  added: number;
  modified: number;
  removed: number;
  pages_hash: string;
  started_at: number;
  mac: string;
}

const STAGE_LABEL = 'ledgerline/v1/mac/stage';

function stageInput(budgetId: string, st: Stage): Uint8Array<ArrayBuffer> {
  return concat(
    label(STAGE_LABEL),
    str(budgetId),
    str(st.linkId),
    u64(st.run),
    u32(st.restart),
    u32(st.bankRestarts),
    u32(st.inboxVersion),
    u32(st.n),
    str(st.startCursor),
    str(st.cursor),
    u8(st.hasMore ? 1 : 0),
    u8(st.describes ? 1 : 0),
    u16(st.pages),
    u32(st.added),
    u32(st.modified),
    u32(st.removed),
    fromHex(st.pagesHash),
    u64(st.startedAt),
  );
}

/** The statement that writes the stage, whole, with its stamp. */
async function stageStmt(d: RunDeps, st: Stage): Promise<Stmt> {
  const k = await d.keys.keysFor(st.n);
  const mac = toHex(await hmac(k.mac, stageInput(d.budgetId, st)));
  return d.db
    .prepare(
      `INSERT OR REPLACE INTO run_stage (id, link_id, run, restart, bank_restarts, inbox_version, n, start_cursor, cursor,
         has_more, describes, pages, added, modified, removed, pages_hash, started_at, mac)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    )
    .bind(
      st.linkId,
      st.run,
      st.restart,
      st.bankRestarts,
      st.inboxVersion,
      st.n,
      st.startCursor,
      st.cursor,
      st.hasMore ? 1 : 0,
      st.describes ? 1 : 0,
      st.pages,
      st.added,
      st.modified,
      st.removed,
      st.pagesHash,
      st.startedAt,
      mac,
    );
}

/** The stage as it is stored, with whether its stamp is good. Null: no run is being fetched. */
async function readStage(d: RunDeps): Promise<{ st: Stage; mac: string; good: boolean } | null> {
  const r = await d.db.prepare(`SELECT * FROM run_stage WHERE id = 1`).first<StageRow>();
  if (!r) return null;
  const st: Stage = {
    linkId: r.link_id,
    run: r.run,
    restart: r.restart,
    bankRestarts: r.bank_restarts,
    inboxVersion: r.inbox_version,
    n: r.n,
    startCursor: r.start_cursor,
    cursor: r.cursor,
    hasMore: r.has_more === 1,
    describes: r.describes === 1,
    pages: r.pages,
    added: r.added,
    modified: r.modified,
    removed: r.removed,
    pagesHash: r.pages_hash,
    startedAt: r.started_at,
  };
  let good = false;
  try {
    const k = await d.keys.keysFor(st.n);
    good = await hmacVerify(k.mac, stageInput(d.budgetId, st), hexOr(r.mac));
  } catch {
    // A row whose values can't be stamped, or whose key the Worker doesn't hold, has no good stamp.
    good = false;
  }
  return { st, mac: String(r.mac), good };
}

/** The run being fetched, as the Worker left it; null when there is none. For the job and the tests. */
export async function stageOf(d: RunDeps): Promise<Stage | null> {
  const s = await readStage(d);
  if (s && !s.good) throw new BadStamp('run stage');
  return s?.st ?? null;
}

/** The run a job began: its steps act on that run only, never on one that took its place. */
export interface OwnRun {
  linkId: string;
  startedAt: number;
}
const own = (st: Stage, only: OwnRun | undefined): boolean =>
  !only || (st.linkId === only.linkId && st.startedAt === only.startedAt);

/** The stage a step goes on from: there, with a good stamp, and the one its job began. */
async function openStage(d: RunDeps, only?: OwnRun): Promise<{ st: Stage; mac: string }> {
  const s = await readStage(d);
  if (!s) throw new RunStopped('no run');
  if (!s.good) throw new BadStamp('run stage');
  if (!own(s.st, only)) throw new RunStopped('another run took its place');
  return s;
}

/** True only while the stage is still the one a step read: any other step, or a new run, changes its stamp. */
const stageFence = (d: RunDeps, mac: string): Stmt =>
  conditionFence(d.db, `SELECT mac = ?1 FROM run_stage WHERE id = 1`, mac);

const stopped = (x: unknown): never => {
  if (!isFenceAbort(x)) throw x;
  throw new RunStopped('another step moved the run');
};

/** The bank link as the fetch may use it: its stamp is good. */
async function stampedLink(
  d: RunDeps,
  linkId: string,
): Promise<{ connectionId: string; itemId: string; tokenEnc: string; keyVersion: number }> {
  const l = await d.db
    .prepare(
      `SELECT connection_id, budget_id, provider_item_id, access_token_enc, key_version, mac FROM bank_link WHERE id = ?1`,
    )
    .bind(linkId)
    .first<{
      connection_id: string;
      budget_id: string;
      provider_item_id: string | null;
      access_token_enc: string | null;
      key_version: number | null;
      mac: string | null;
    }>();
  if (!l || !l.mac || !l.provider_item_id || !l.access_token_enc || l.key_version === null)
    throw new BadStamp('link');
  if (l.budget_id !== d.budgetId || !isUlid(linkId)) throw new BadStamp('link');
  let ok = false;
  try {
    const k = await d.keys.keysFor(l.key_version);
    ok = await checkLinkMac(
      k,
      d.budgetId,
      linkId,
      l.provider_item_id,
      unb64(l.access_token_enc),
      unb64(l.mac),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new BadStamp('link');
  return {
    connectionId: l.connection_id,
    itemId: l.provider_item_id,
    tokenEnc: l.access_token_enc,
    keyVersion: l.key_version,
  };
}

/** What a bank call for a link needs: the link checked against its stamp, and its token opened. */
export async function linkForBank(
  d: RunDeps,
  linkId: string,
): Promise<{ id: string; accessToken: string; providerItemId: string }> {
  const l = await stampedLink(d, linkId);
  return {
    id: l.connectionId,
    accessToken: await decryptToken(d.ring, l.tokenEnc, l.keyVersion, l.connectionId),
    providerItemId: l.itemId,
  };
}

/** A run left alone this long is given up, so one link's fault can't hold back the others for good. */
export const STAGE_MAX_MS = LEASE_TTL_MS;

/**
 * Begins the next run, for one link: checks the run state, the link and the inbox key, and notes the run. Gives
 * the run to go on with; `busy` when another link's run is being fetched. A run already begun for this link is
 * the one to go on with. A run whose stamp is bad, or that was left alone too long, is dropped first: nothing of
 * it was shown to a device, and the link's cursor has not moved.
 */
export async function beginSealedRun(d: RunDeps, linkId: string, now: number): Promise<Stage | 'busy'> {
  const open = await readStage(d);
  if (open) {
    if (open.good && now - open.st.startedAt <= STAGE_MAX_MS)
      return open.st.linkId === linkId ? open.st : 'busy';
    try {
      await d.db.batch([
        stageFence(d, open.mac),
        d.db
          .prepare(`DELETE FROM sealed_page WHERE run = ?1 AND run NOT IN (SELECT run FROM sealed_run)`)
          .bind(open.st.run),
        d.db.prepare(`DELETE FROM run_stage WHERE id = 1`),
      ]);
    } catch (x) {
      if (!isFenceAbort(x)) throw x;
      return 'busy';
    }
  }
  const { s, cursors, lastInbox } = await standing(d);
  await stampedLink(d, linkId);
  const { inboxVersion } = await inForce(d.db);
  if (inboxVersion < lastInbox) throw new BadStamp('inbox key');
  await stampedKey(d, KEY_KIND.inbox, inboxVersion);
  // A link with no cursor yet has never run: its first run describes it, and fetches no transactions.
  const known = cursors.find((c) => c.linkId === linkId);
  const cursor = known?.cursor ?? '';
  const st: Stage = {
    linkId,
    run: s.run + 1,
    restart: 0,
    bankRestarts: 0,
    inboxVersion,
    n: d.keys.current,
    startCursor: cursor,
    cursor,
    hasMore: !!known,
    describes: !known,
    pages: 0,
    added: 0,
    modified: 0,
    removed: 0,
    pagesHash: ZERO_HASH,
    startedAt: now,
  };
  try {
    await d.db.batch([
      conditionFence(
        d.db,
        `SELECT (SELECT run FROM run_state WHERE id = 1) = ?1 AND NOT EXISTS (SELECT 1 FROM run_stage)`,
        s.run,
      ),
      // Nothing of an attempt that was given up stays under this run's number.
      d.db.prepare(`DELETE FROM sealed_page WHERE run = ?1`).bind(st.run),
      await stageStmt(d, st),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    return 'busy';
  }
  return st;
}

/**
 * Starts the run again from its first cursor: its pages are dropped, and its next pages get new receipts. `bank`:
 * the bank asked for it (its data changed mid-run), which may happen only so often; a key change may always.
 */
async function restart(
  d: RunDeps,
  o: { st: Stage; mac: string },
  inboxVersion: number,
  bank: boolean,
): Promise<void> {
  const { st } = o;
  if (bank && st.bankRestarts + 1 > MAX_FETCH_RESTARTS) throw new RunStopped('too many restarts');
  const next: Stage = {
    ...st,
    restart: st.restart + 1,
    bankRestarts: st.bankRestarts + (bank ? 1 : 0),
    inboxVersion,
    n: d.keys.current,
    cursor: st.startCursor,
    hasMore: !st.describes,
    pages: 0,
    added: 0,
    modified: 0,
    removed: 0,
    pagesHash: ZERO_HASH,
  };
  try {
    await d.db.batch([
      stageFence(d, o.mac),
      d.db.prepare(`DELETE FROM sealed_page WHERE run = ?1`).bind(st.run),
      await stageStmt(d, next),
    ]);
  } catch (x) {
    stopped(x);
  }
}

/** The keys a page of this run is sealed with, checked: the Worker's for the run, and the stamped inbox key. */
async function sealKeys(d: RunDeps, st: Stage): Promise<{ k: ServerKeys; pub: Uint8Array }> {
  const k = await d.keys.keysFor(st.n).catch(() => null);
  if (!k) throw new BadStamp('run stage');
  return { k, pub: await stampedKey(d, KEY_KIND.inbox, st.inboxVersion) };
}

const nextPagesHash = async (before: string, what: number, pageHash: Uint8Array): Promise<string> =>
  toHex(await sha256(concat(fromHex(before), u8(what), pageHash)));

/** Seals one page of the run and stores it, only if the run still stands where this step found it. */
async function addPage(
  d: RunDeps,
  o: { st: Stage; mac: string },
  keys: { k: ServerKeys; pub: Uint8Array },
  what: What,
  payload: Uint8Array,
  move: { cursor: string; hasMore: boolean; added: number; modified: number; removed: number } | null,
): Promise<void> {
  const { st } = o;
  const { sealed, page } = await sealPage(
    keys.k,
    keys.pub,
    {
      budgetId: d.budgetId,
      linkId: st.linkId,
      inboxVersion: st.inboxVersion,
      run: st.run,
      restart: st.restart,
      page: st.pages,
    },
    what,
    payload,
  );
  const next: Stage = {
    ...st,
    pages: st.pages + 1,
    pagesHash: await nextPagesHash(st.pagesHash, what, page.hash),
    ...(move
      ? {
          cursor: move.cursor,
          hasMore: move.hasMore,
          added: st.added + move.added,
          modified: st.modified + move.modified,
          removed: st.removed + move.removed,
        }
      : {}),
  };
  try {
    await d.db.batch([
      stageFence(d, o.mac),
      d.db
        .prepare(
          `INSERT OR REPLACE INTO sealed_page (run, page, what, hash, bytes) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(st.run, st.pages, what, toHex(page.hash), sealed),
      await stageStmt(d, next),
    ]);
  } catch (x) {
    stopped(x);
  }
}

/**
 * One step: fetches the next page of transactions, checks that it reads, counts its rows, seals it and stores
 * it. The page's plain text lives only in this step's memory. Gives whether the bank has more pages. When the
 * bank says its data changed while the run was read, the run starts again (`restarted`).
 */
export async function fetchSealedPage(
  d: RunDeps,
  provider: BankDataProvider,
  pageSize: number,
  only?: OwnRun,
): Promise<{ more: boolean } | 'restarted'> {
  const o = await openStage(d, only);
  const { st } = o;
  if (!st.hasMore) return { more: false };
  // Everything the page will be sealed with is checked before the bank is asked.
  const keys = await sealKeys(d, st);
  const conn = await linkForBank(d, st.linkId);
  let staged;
  try {
    staged = await provider.fetchSyncPage(conn, st.cursor === '' ? null : st.cursor, pageSize);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== MUTATION_DURING_PAGINATION) throw e;
    await restart(d, o, st.inboxVersion, true);
    return 'restarted';
  }
  // A page a device couldn't read is not sealed: the step fails and is tried again.
  const page = provider.parsePage(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(staged.body),
  );
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const e of page.events)
    if (e.kind === 'added') added++;
    else if (e.kind === 'modified') modified++;
    else removed++;
  await addPage(d, o, keys, WHAT.transactions, staged.body, {
    cursor: staged.nextCursor,
    hasMore: staged.hasMore,
    added,
    modified,
    removed,
  });
  return { more: staged.hasMore };
}

const jsonBytes = (v: unknown): Uint8Array => {
  const text = JSON.stringify(v) as string | undefined;
  if (text === undefined) throw new RangeError('nothing to seal');
  return new TextEncoder().encode(text);
};

/**
 * One step, after the last page of transactions: seals what the bank said about balances (`WHAT.balances`) or
 * card statements (`WHAT.liabilities`), as JSON. A run whose bank couldn't be asked is stored without it, and
 * its manifest says so: this step is then left out.
 */
export async function sealBankAnswer(d: RunDeps, what: 1 | 2, answer: unknown, only?: OwnRun): Promise<void> {
  const o = await openStage(d, only);
  const { st } = o;
  if (st.hasMore || st.pages === 0 || st.describes) throw new RunStopped('the run has no page yet');
  const held = await d.db
    .prepare(`SELECT 1 AS x FROM sealed_page WHERE run = ?1 AND what = ?2`)
    .bind(st.run, what)
    .first();
  // The step ran before and its answer was lost: the page is there.
  if (held) return;
  await addPage(d, o, await sealKeys(d, st), what, jsonBytes(answer), null);
}

/**
 * The one page of a link's first run: what the bank says about the link (its bank, its accounts and their
 * balances, when it was linked), as JSON. A device writes the link's accounts from it; the link's transactions
 * come with its next run.
 */
export async function sealLinkDescription(d: RunDeps, description: unknown, only?: OwnRun): Promise<void> {
  const o = await openStage(d, only);
  const { st } = o;
  if (!st.describes) throw new RunStopped('not a first run');
  // The step ran before and its answer was lost: the page is there.
  if (st.pages > 0) return;
  await addPage(d, o, await sealKeys(d, st), WHAT.link, jsonBytes(description), null);
}

/**
 * The last step: signs the run's manifest and, in one transaction, stores the run, moves the link's cursor and
 * stamps the budget's new run state. When a key change replaced the run's inbox key meanwhile, the run starts
 * again, sealed to the key in force (`restarted`). `run`: the run this step is to complete; when the step ran
 * before and its answer was lost, the run is there, and that is the answer.
 */
export async function completeSealedRun(
  d: RunDeps,
  now: number,
  run?: number,
  only?: OwnRun,
): Promise<{ run: number } | 'restarted'> {
  const o = await readStage(d);
  if (!o || (run !== undefined && o.st.run !== run) || (o.good && !own(o.st, only))) {
    if (run !== undefined) {
      const done = await d.db
        .prepare(`SELECT link_id FROM sealed_run WHERE run = ?1`)
        .bind(run)
        .first<{ link_id: string }>();
      if (done && (!only || done.link_id === only.linkId)) return { run };
    }
    throw new RunStopped('no run');
  }
  if (!o.good) throw new BadStamp('run stage');
  const { st } = o;
  if (st.hasMore || st.pages === 0) throw new RunStopped('the run is not whole');
  const { s, cursors, lastInbox } = await standing(d);
  if (s.run !== st.run - 1) throw new RunStopped('not the next run');

  // The pages are the ones the steps stored, in order: their hashes chain to the stage's stamped hash.
  const rows = await d.db
    .prepare(`SELECT page, what, hash FROM sealed_page WHERE run = ?1 ORDER BY page`)
    .bind(st.run)
    .all<{ page: number; what: number; hash: string }>();
  let chain = ZERO_HASH;
  const pages: { what: What; hash: Uint8Array<ArrayBuffer> }[] = [];
  for (const [i, r] of rows.results.entries()) {
    const hash = hexOr(r.hash);
    if (r.page !== i || hash.length !== 32 || ![0, 1, 2, 3].includes(r.what)) throw new BadStamp('run stage');
    chain = await nextPagesHash(chain, r.what, hash);
    pages.push({ what: r.what as What, hash });
  }
  if (pages.length !== st.pages || chain !== st.pagesHash) throw new BadStamp('run stage');

  const force = await inForce(d.db);
  // Never sealed to a newer key than the log has, nor to an older one than the run before.
  if (st.inboxVersion > force.inboxVersion || st.inboxVersion < lastInbox) throw new BadStamp('inbox key');
  const { k, pub } = await sealKeys(d, st);
  // Later than the run before, whatever this clock says (9.3).
  const runTime = Math.max(now, s.time + 1);
  let signed;
  try {
    signed = await signRun(
      k,
      pub,
      {
        budgetId: d.budgetId,
        linkId: st.linkId,
        run: st.run,
        restart: st.restart,
        inboxVersion: st.inboxVersion,
        runTime,
        prevRunTime: s.time,
        cursorBefore: await cursorHash(st.startCursor),
        cursorAfter: await cursorHash(st.cursor),
        added: st.added,
        modified: st.modified,
        removed: st.removed,
        pages,
        prevManifestHash: fromHex(s.hash),
      },
      { inboxVersion: force.inboxVersion, lastRunForOld: force.retiredAt.get(st.inboxVersion) ?? 0 },
    );
  } catch (x) {
    if (!(x instanceof RestartRun)) throw x;
    await stampedKey(d, KEY_KIND.inbox, force.inboxVersion);
    await restart(d, o, force.inboxVersion, false);
    return 'restarted';
  }
  const hash = toHex(await sha256(signed.manifest));
  const after = [...cursors.filter((c) => c.linkId !== st.linkId), { linkId: st.linkId, cursor: st.cursor }];
  const mac = toHex(
    await runsMac(k, d.budgetId, await runStateOf({ run: st.run, hash, time: runTime }, after)),
  );
  try {
    await d.db.batch([
      // The run state, the stage and the log are all where this step read them: a key change stored meanwhile
      // (which names the last run sealed to the old key) makes the step run again.
      conditionFence(
        d.db,
        `SELECT (SELECT run FROM run_state WHERE id = 1) = ?1 AND (SELECT mac FROM run_stage WHERE id = 1) = ?2
           AND (SELECT number FROM log_state WHERE id = 1) = ?3`,
        s.run,
        o.mac,
        force.number,
      ),
      d.db
        .prepare(
          `INSERT INTO sealed_run (run, link_id, manifest, signature, receipt_hash, first_cursor, pages, run_time, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          st.run,
          st.linkId,
          signed.manifest,
          signed.signature,
          toHex(readRunManifest(signed.manifest).receiptHash),
          st.startCursor,
          st.pages,
          runTime,
          now,
        ),
      d.db
        .prepare(
          `UPDATE run_state SET run = ?1, last_manifest_hash = ?2, last_run_time = ?3, mac = ?4, n = ?5, updated_at = ?6
           WHERE id = 1`,
        )
        .bind(st.run, hash, runTime, mac, k.n, now),
      d.db
        .prepare(
          `INSERT INTO link_cursor (link_id, cursor, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (link_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .bind(st.linkId, st.cursor, now),
      d.db.prepare(`DELETE FROM run_stage WHERE id = 1`),
    ]);
  } catch (x) {
    stopped(x);
  }
  return { run: st.run };
}

/** Gives up the run being fetched (the bank refused, the link needs a repair): its pages go, the link's cursor stays. */
export async function abandonSealedRun(db: Db, linkId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM sealed_page WHERE run = (SELECT run FROM run_stage WHERE id = 1 AND link_id = ?1)
           AND run NOT IN (SELECT run FROM sealed_run)`,
      )
      .bind(linkId),
    db.prepare(`DELETE FROM run_stage WHERE id = 1 AND link_id = ?1`).bind(linkId),
  ]);
}

// ---- what the log store and a device read

/** The highest run that is complete (0: none). The server's own count for its write rules, so it needs no stamp. */
export async function lastCompleteRun(db: Db): Promise<number> {
  return (await db.prepare(`SELECT run FROM run_state WHERE id = 1`).first<{ run: number }>())?.run ?? 0;
}

/** H(receipt) of runs `from` to `to`, in order; null when one is missing. */
export async function receiptHashes(db: Db, from: number, to: number): Promise<Uint8Array[] | null> {
  if (!(from >= 1) || to < from || to - from >= 256) return null;
  const rows = await db
    .prepare(`SELECT run, receipt_hash FROM sealed_run WHERE run >= ?1 AND run <= ?2 ORDER BY run`)
    .bind(from, to)
    .all<{ run: number; receipt_hash: string }>();
  if (rows.results.length !== to - from + 1) return null;
  const out = rows.results.map((r) => hexOr(r.receipt_hash));
  return out.every((h) => h.length === 32) ? out : null;
}

/** Complete runs after `after`, in order: each manifest with its signature and its number of pages. */
export async function runsAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ run: number; manifest: Uint8Array; signature: Uint8Array; pages: number }[]> {
  const rows = await db
    .prepare(`SELECT run, manifest, signature, pages FROM sealed_run WHERE run > ?1 ORDER BY run LIMIT ?2`)
    .bind(after, limit)
    .all<{ run: number; manifest: unknown; signature: unknown; pages: number }>();
  return rows.results.map((r) => ({
    run: r.run,
    manifest: bytesOf(r.manifest),
    signature: bytesOf(r.signature),
    pages: r.pages,
  }));
}

/** One sealed page of a complete run; null when there is none (a run still being fetched has none to give). */
export async function sealedPageOf(db: Db, run: number, page: number): Promise<Uint8Array | null> {
  const r = await db
    .prepare(
      `SELECT p.bytes FROM sealed_page p JOIN sealed_run r ON r.run = p.run WHERE p.run = ?1 AND p.page = ?2`,
    )
    .bind(run, page)
    .first<{ bytes: unknown }>();
  return r ? bytesOf(r.bytes) : null;
}
