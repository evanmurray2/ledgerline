// The steps of a bank run (docs/privacy.md 5.5; docs/privacy-keys.md 9), one job step each, safe to run again:
// begin, each page fetched and sealed, the bank's answers, and sign and store. Split from runs.ts.
import { MUTATION_DURING_PAGINATION, ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db } from '@ledgerline/db/sql';
import {
  concat,
  cursorHash,
  fromHex,
  KEY_KIND,
  readRunManifest,
  RestartRun,
  runsMac,
  sealPage,
  sha256,
  signRun,
  toHex,
  u8,
  WHAT,
  type ServerKeys,
  type What,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort, LEASE_TTL_MS, MAX_FETCH_RESTARTS } from '../sync/lease.js';
import {
  linkForBank,
  openStage,
  own,
  readStage,
  stageFence,
  stageStmt,
  stampedLink,
  stopped,
  type OwnRun,
  type Stage,
} from './run-stage.js';
import {
  BadStamp,
  hexOr,
  inForce,
  runStateOf,
  RunStopped,
  stampedKey,
  standing,
  ZERO_HASH,
  type RunDeps,
} from './runs.js';

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
