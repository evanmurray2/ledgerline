// Bank runs of a sealed budget (docs/privacy.md 5.5; docs/privacy-keys.md 9; store migration 0006). The fetch
// step seals each page to the budget's inbox key the moment it arrives, and signs the run when it is whole. The
// server keeps no readable page, in the database or between steps: a page is fetched and sealed in one step.
//
// Everything the Worker reads back from the database to decide where bank data goes is under one of its stamps,
// since someone may have written to the database: the inbox key (`keyMac`), the bank link (`linkMac`), and the
// budget's whole run state (`runsMac`). A bad stamp stops the fetch (`BadStamp`); it never seals to an unstamped
// key. Each function here is one job step. Nothing calls this before the cutover.
import { MUTATION_DURING_PAGINATION, ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db, Stmt } from '@ledgerline/db/sql';
import { tokenKeyBytes, type TokenKeyring } from '@ledgerline/platform';
import {
  checkKeyMac,
  checkLinkMac,
  checkRunsMac,
  cursorHash,
  fromHex,
  isUlid,
  KEY_KIND,
  keyMac,
  readRunManifest,
  RestartRun,
  runsMac,
  sealPage,
  serverKeys,
  sha256,
  signRun,
  toHex,
  WHAT,
  type ChainState,
  type RunState,
  type ServerKeys,
  type What,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort, MAX_FETCH_RESTARTS } from '../sync/lease.js';
import { stateFromJson } from './log-store.js';

/** A value the Worker must have stamped has no good stamp: the database was changed from outside, or lost a row. */
export class BadStamp extends Error {
  constructor(readonly what: 'inbox key' | 'link' | 'run state') {
    super(`bad stamp: ${what}`);
  }
}

/** The run can't go on as it is (another step moved it, or the bank restarted it too often). */
export class RunStopped extends Error {}

/** The Worker's keys by key number, from the keyring that encrypts bank tokens (9.1). */
export interface WorkerKeys {
  current: number;
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
        // A key number the keyring doesn't hold stamped nothing this Worker can check.
        if (secret === undefined) return Promise.reject(new BadStamp('run state'));
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
  keys: WorkerKeys;
}

const ZERO_HASH = '0'.repeat(64);
const bytesOf = (v: unknown): Uint8Array<ArrayBuffer> =>
  v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v as ArrayBuffer);
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hexOr = (s: string): Uint8Array => {
  try {
    return fromHex(s);
  } catch {
    return new Uint8Array(0);
  }
};

// ---- the stamps on keys

/**
 * The stamps for the keys a stored write brought: the first entry's signing and inbox keys, and those of each key
 * change. `before` is the chain before the write (null for the first entry). The log store adds these statements
 * to the step that stores the write, so a key the log holds always has its stamp. The first entry also starts the
 * budget's run state, at no run.
 */
export async function keyStampStmts(
  d: RunDeps,
  before: ChainState | null,
  after: ChainState,
  now: number,
): Promise<Stmt[]> {
  const k = await d.keys.keysFor(d.keys.current);
  const out: Stmt[] = [];
  const stamp = async (kind: 1 | 2, version: number, pub: Uint8Array) => {
    const mac = await keyMac(k, d.budgetId, version, kind, pub);
    out.push(
      d.db
        .prepare(
          `INSERT INTO key_stamp (kind, version, pub, mac, n, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (kind, version) DO NOTHING`,
        )
        .bind(kind, version, toHex(pub), toHex(mac), k.n, now),
    );
  };
  const a = after.public;
  if (!before || before.public.keyVersion !== a.keyVersion)
    await stamp(KEY_KIND.sign, a.keyVersion, a.signPub);
  if (!before || before.public.inboxVersion !== a.inboxVersion)
    await stamp(KEY_KIND.inbox, a.inboxVersion, a.inboxPub);
  if (!before) out.push(await runStateStmt(d, k, { run: 0, hash: ZERO_HASH, time: 0 }, [], now, true));
  return out;
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
  return new Uint8Array(pub);
}

/**
 * The inbox version the log has in force, and for each replaced version the last run that may be sealed to it. The
 * log's state has no stamp: someone who changes it can at most make the Worker seal to an older stamped key, and a
 * device refuses such a run (9.3 check 3).
 */
async function inForce(db: Db): Promise<{ inboxVersion: number; retiredAt: Map<number, number> }> {
  const r = await db.prepare(`SELECT state FROM log_state WHERE id = 1`).first<{ state: string }>();
  if (!r) throw new BadStamp('inbox key');
  const p = (stateFromJson(r.state) as unknown as { public: { inboxVersion: number; retiredAt: unknown } })
    .public;
  if (!Number.isInteger(p.inboxVersion) || !(p.retiredAt instanceof Map)) throw new BadStamp('inbox key');
  return { inboxVersion: p.inboxVersion, retiredAt: p.retiredAt as Map<number, number> };
}

// ---- the run state

interface Standing {
  run: number;
  /** Hex. */
  hash: string;
  time: number;
}

async function runStateOf(s: Standing, cursors: { linkId: string; cursor: string }[]): Promise<RunState> {
  const links = [];
  for (const c of cursors) links.push({ linkId: c.linkId, cursorHash: await cursorHash(c.cursor) });
  return { run: s.run, lastManifestHash: hexOr(s.hash), lastRunTime: s.time, links };
}

async function runStateStmt(
  d: RunDeps,
  k: ServerKeys,
  s: Standing,
  cursors: { linkId: string; cursor: string }[],
  now: number,
  first = false,
): Promise<Stmt> {
  const mac = toHex(await runsMac(k, d.budgetId, await runStateOf(s, cursors)));
  return d.db
    .prepare(
      first
        ? `INSERT INTO run_state (id, run, last_manifest_hash, last_run_time, mac, n, updated_at)
           VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (id) DO NOTHING`
        : `UPDATE run_state SET run = ?1, last_manifest_hash = ?2, last_run_time = ?3, mac = ?4, n = ?5, updated_at = ?6
           WHERE id = 1`,
    )
    .bind(s.run, s.hash, s.time, mac, k.n, now);
}

/** The budget's run state, checked against its stamp. */
async function standing(d: RunDeps): Promise<{ s: Standing; cursors: { linkId: string; cursor: string }[] }> {
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
  return { s, cursors };
}

// ---- a run, step by step

export interface Stage {
  linkId: string;
  run: number;
  restart: number;
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
}

interface StageRow {
  link_id: string;
  run: number;
  restart: number;
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
}

export async function stageOf(db: Db): Promise<Stage | null> {
  const r = await db.prepare(`SELECT * FROM run_stage WHERE id = 1`).first<StageRow>();
  return r
    ? {
        linkId: r.link_id,
        run: r.run,
        restart: r.restart,
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
      }
    : null;
}

/** The bank link as the fetch may use it: its stamp is good. Gives what a bank call needs but the token. */
export async function stampedLink(
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

/**
 * Begins the next run, for one link: checks the run state, the link and the inbox key, and notes the run. Gives
 * the run to go on with; `busy` when another link's run is being fetched. A run already begun for this link is
 * the one to go on with.
 */
export async function beginSealedRun(d: RunDeps, linkId: string, now: number): Promise<Stage | 'busy'> {
  const open = await stageOf(d.db);
  if (open) return open.linkId === linkId ? open : 'busy';
  const { s, cursors } = await standing(d);
  await stampedLink(d, linkId);
  const { inboxVersion } = await inForce(d.db);
  await stampedKey(d, KEY_KIND.inbox, inboxVersion);
  // A link with no cursor yet has never run: its first run describes it, and fetches no transactions.
  const known = cursors.find((c) => c.linkId === linkId);
  const cursor = known?.cursor ?? '';
  try {
    await d.db.batch([
      conditionFence(
        d.db,
        `SELECT (SELECT run FROM run_state WHERE id = 1) = ?1 AND NOT EXISTS (SELECT 1 FROM run_stage)`,
        s.run,
      ),
      d.db
        .prepare(
          `INSERT INTO run_stage (id, link_id, run, restart, inbox_version, n, start_cursor, cursor, has_more, describes, pages, added, modified, removed, started_at)
           VALUES (1, ?1, ?2, 0, ?3, ?4, ?5, ?5, ?6, ?7, 0, 0, 0, 0, ?8)`,
        )
        .bind(linkId, s.run + 1, inboxVersion, d.keys.current, cursor, known ? 1 : 0, known ? 0 : 1, now),
      // Nothing of an attempt that was given up stays under this run's number.
      d.db.prepare(`DELETE FROM sealed_page WHERE run = ?1`).bind(s.run + 1),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    return 'busy';
  }
  return (await stageOf(d.db))!;
}

/** Starts the run again from its first cursor: its pages are dropped, and its next pages get new receipts. */
async function restart(d: RunDeps, st: Stage, inboxVersion: number): Promise<void> {
  if (st.restart + 1 > MAX_FETCH_RESTARTS) throw new RunStopped('too many restarts');
  await d.db.batch([
    conditionFence(d.db, `SELECT restart = ?1 AND run = ?2 FROM run_stage WHERE id = 1`, st.restart, st.run),
    d.db.prepare(`DELETE FROM sealed_page WHERE run = ?1`).bind(st.run),
    d.db
      .prepare(
        `UPDATE run_stage SET restart = restart + 1, inbox_version = ?1, cursor = start_cursor,
           has_more = 1 - describes, pages = 0, added = 0, modified = 0, removed = 0 WHERE id = 1`,
      )
      .bind(inboxVersion),
  ]);
}

/** Seals one page of the run and stores it, only if the run still stands where this step found it. */
async function addPage(
  d: RunDeps,
  st: Stage,
  what: What,
  payload: Uint8Array,
  move: { cursor: string; hasMore: boolean; added: number; modified: number; removed: number } | null,
): Promise<void> {
  const k = await d.keys.keysFor(st.n);
  const pub = await stampedKey(d, KEY_KIND.inbox, st.inboxVersion);
  const { sealed, page } = await sealPage(
    k,
    pub,
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
  try {
    await d.db.batch([
      conditionFence(
        d.db,
        `SELECT restart = ?1 AND run = ?2 AND pages = ?3 FROM run_stage WHERE id = 1`,
        st.restart,
        st.run,
        st.pages,
      ),
      d.db
        .prepare(`INSERT INTO sealed_page (run, page, what, hash, bytes) VALUES (?1, ?2, ?3, ?4, ?5)`)
        .bind(st.run, st.pages, what, toHex(page.hash), sealed),
      move
        ? d.db
            .prepare(
              `UPDATE run_stage SET pages = pages + 1, cursor = ?1, has_more = ?2, added = added + ?3,
                 modified = modified + ?4, removed = removed + ?5 WHERE id = 1`,
            )
            .bind(move.cursor, move.hasMore ? 1 : 0, move.added, move.modified, move.removed)
        : d.db.prepare(`UPDATE run_stage SET pages = pages + 1 WHERE id = 1`),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    throw new RunStopped('another step moved the run');
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
  accessToken: string,
  pageSize: number,
): Promise<{ more: boolean } | 'restarted'> {
  const st = await stageOf(d.db);
  if (!st) throw new RunStopped('no run');
  if (!st.hasMore) return { more: false };
  const link = await stampedLink(d, st.linkId);
  let staged;
  try {
    staged = await provider.fetchSyncPage(
      { id: link.connectionId, accessToken, providerItemId: link.itemId },
      st.cursor === '' ? null : st.cursor,
      pageSize,
    );
  } catch (e) {
    if (!(e instanceof ProviderError) || e.code !== MUTATION_DURING_PAGINATION) throw e;
    await restart(d, st, st.inboxVersion);
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
  await addPage(d, st, WHAT.transactions, staged.body, {
    cursor: staged.nextCursor,
    hasMore: staged.hasMore,
    added,
    modified,
    removed,
  });
  return { more: staged.hasMore };
}

/**
 * One step, after the last page of transactions: seals what the bank said about balances (`WHAT.balances`) or
 * card statements (`WHAT.liabilities`), as JSON. A run whose bank couldn't be asked is stored without it, and
 * its manifest says so: this step is then left out.
 */
export async function sealBankAnswer(d: RunDeps, what: 1 | 2, answer: unknown): Promise<void> {
  const st = await stageOf(d.db);
  if (!st || st.hasMore || st.pages === 0 || st.describes) throw new RunStopped('the run has no page yet');
  const held = await d.db
    .prepare(`SELECT 1 AS x FROM sealed_page WHERE run = ?1 AND what = ?2`)
    .bind(st.run, what)
    .first();
  // The step ran before and its answer was lost: the page is there.
  if (held) return;
  await addPage(d, st, what, new TextEncoder().encode(JSON.stringify(answer)), null);
}

/**
 * The one page of a link's first run: what the bank says about the link (its bank, its accounts and their
 * balances, when it was linked), as JSON. A device writes the link's accounts from it; the link's transactions
 * come with its next run.
 */
export async function sealLinkDescription(d: RunDeps, description: unknown): Promise<void> {
  const st = await stageOf(d.db);
  if (!st || !st.describes) throw new RunStopped('not a first run');
  // The step ran before and its answer was lost: the page is there.
  if (st.pages > 0) return;
  await addPage(d, st, WHAT.link, new TextEncoder().encode(JSON.stringify(description)), null);
}

/**
 * The last step: signs the run's manifest and, in one transaction, stores the run, moves the link's cursor and
 * stamps the budget's new run state. When a key change replaced the run's inbox key meanwhile, the run starts
 * again, sealed to the key in force (`restarted`).
 */
export async function completeSealedRun(d: RunDeps, now: number): Promise<{ run: number } | 'restarted'> {
  const st = await stageOf(d.db);
  if (!st || st.hasMore || st.pages === 0) throw new RunStopped('the run is not whole');
  const { s, cursors } = await standing(d);
  if (s.run !== st.run - 1) throw new RunStopped('not the next run');
  const rows = await d.db
    .prepare(`SELECT page, what, hash FROM sealed_page WHERE run = ?1 ORDER BY page`)
    .bind(st.run)
    .all<{ page: number; what: number; hash: string }>();
  if (rows.results.length !== st.pages || rows.results.some((r, i) => r.page !== i))
    throw new RunStopped('pages are missing');
  const force = await inForce(d.db);
  const k = await d.keys.keysFor(st.n);
  const pub = await stampedKey(d, KEY_KIND.inbox, st.inboxVersion);
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
        pages: rows.results.map((r) => ({ what: r.what as What, hash: fromHex(r.hash) })),
        prevManifestHash: fromHex(s.hash),
      },
      { inboxVersion: force.inboxVersion, lastRunForOld: force.retiredAt.get(st.inboxVersion) ?? 0 },
    );
  } catch (x) {
    if (!(x instanceof RestartRun)) throw x;
    await stampedKey(d, KEY_KIND.inbox, force.inboxVersion);
    await restart(d, st, force.inboxVersion);
    return 'restarted';
  }
  const hash = toHex(await sha256(signed.manifest));
  const after = [...cursors.filter((c) => c.linkId !== st.linkId), { linkId: st.linkId, cursor: st.cursor }];
  try {
    await d.db.batch([
      conditionFence(
        d.db,
        `SELECT (SELECT run FROM run_state WHERE id = 1) = ?1
           AND (SELECT restart = ?2 AND run = ?3 AND pages = ?4 FROM run_stage WHERE id = 1)`,
        s.run,
        st.restart,
        st.run,
        st.pages,
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
      await runStateStmt(d, k, { run: st.run, hash, time: runTime }, after, now),
      d.db
        .prepare(
          `INSERT INTO link_cursor (link_id, cursor, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (link_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .bind(st.linkId, st.cursor, now),
      d.db.prepare(`DELETE FROM run_stage WHERE id = 1`),
    ]);
  } catch (x) {
    if (!isFenceAbort(x)) throw x;
    throw new RunStopped('another step moved the run');
  }
  return { run: st.run };
}

/** Gives up the run being fetched (the bank refused, the link needs a repair): its pages go, the link's cursor stays. */
export async function abandonSealedRun(db: Db, linkId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM sealed_page WHERE run = (SELECT run FROM run_stage WHERE id = 1 AND link_id = ?1)`,
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
  return rows.results.map((r) => fromHex(r.receipt_hash));
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
