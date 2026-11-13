// The steps of a bank run (docs/privacy.md 5.5; docs/privacy-keys.md 9), one job step each, safe to run again:
// begin, each page fetched and sealed, the bank's answers, and sign and store. Split from runs.ts.
import { MUTATION_DURING_PAGINATION, ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  concat,
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
  cursorHashOf,
  hexOr,
  inForce,
  runStateOf,
  RunStopped,
  stampedKey,
  standing,
  ZERO_HASH,
  type CursorHashes,
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

/** What a page moves the run on by: its cursor and its counts. Pages that hold the bank's answers move nothing. */
type Move = { cursor: string; hasMore: boolean; added: number; modified: number; removed: number };

/**
 * Seals pages of the run and stores them, in one transaction, only if the run still stands where this step found it:
 * one fence, one stamp of the stage, however many pages the step adds (a last page and the bank's answers).
 */
async function addPages(
  d: RunDeps,
  o: { st: Stage; mac: string },
  keys: { k: ServerKeys; pub: Uint8Array },
  parts: { what: What; payload: Uint8Array; move: Move | null }[],
): Promise<void> {
  let st = o.st;
  const stmts: Stmt[] = [stageFence(d, o.mac)];
  for (const p of parts) {
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
      p.what,
      p.payload,
    );
    stmts.push(
      d.db
        .prepare(
          `INSERT OR REPLACE INTO sealed_page (run, page, what, hash, bytes) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(st.run, st.pages, p.what, toHex(page.hash), sealed),
    );
    const m = p.move;
    st = {
      ...st,
      pages: st.pages + 1,
      pagesHash: await nextPagesHash(st.pagesHash, p.what, page.hash),
      ...(m
        ? {
            cursor: m.cursor,
            hasMore: m.hasMore,
            added: st.added + m.added,
            modified: st.modified + m.modified,
            removed: st.removed + m.removed,
          }
        : {}),
    };
  }
  stmts.push(await stageStmt(d, st));
  try {
    await d.db.batch(stmts);
  } catch (x) {
    stopped(x);
  }
}

/** What the bank says about a link besides its transactions (`WHAT.balances` or `WHAT.liabilities`), as JSON. */
export interface BankAnswer {
  what: 1 | 2;
  answer: unknown;
}

/** Asks the bank its answers; `conn` gives the link with its token opened, checked against its stamp. */
export type AskBank = (conn: () => Promise<Awaited<ReturnType<typeof linkForBank>>>) => Promise<BankAnswer[]>;

/**
 * One step: fetches the next page of transactions, checks that it reads, counts its rows, seals it and stores
 * it. The page's plain text lives only in this step's memory. Gives whether the bank has more pages. When the
 * bank says its data changed while the run was read, the run starts again (`restarted`). With `ask`, the last
 * page's step also asks the bank's answers and seals them after the page, in the same transaction (D-110):
 * `answered` says it did.
 */
export async function fetchSealedPage(
  d: RunDeps,
  provider: BankDataProvider,
  pageSize: number,
  only?: OwnRun,
  ask?: AskBank,
): Promise<{ more: boolean; answered?: boolean } | 'restarted'> {
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
  const parts = [
    {
      what: WHAT.transactions as What,
      payload: staged.body as Uint8Array,
      move: { cursor: staged.nextCursor, hasMore: staged.hasMore, added, modified, removed } as Move | null,
    },
  ];
  // The run's last page: nothing of the bank's answers is held yet, since they come only after it.
  const answered = !staged.hasMore && !!ask;
  if (answered)
    for (const a of await ask(async () => conn))
      parts.push({ what: a.what, payload: jsonBytes(a.answer), move: null });
  await addPages(d, o, keys, parts);
  return answered ? { more: false, answered } : { more: staged.hasMore };
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
  await sealBankAnswers(d, [{ what }], async () => [{ what, answer }], only);
}

/**
 * The bank's answers after the last page, in one step and one transaction: `ask` is called with the link's token
 * only when one of `whats` is not held yet. An answer held already (the step ran before and its answer was lost)
 * is not sealed again.
 */
export async function sealBankAnswers(
  d: RunDeps,
  whats: { what: 1 | 2 }[],
  ask: AskBank,
  only?: OwnRun,
): Promise<void> {
  const o = await openStage(d, only);
  const { st } = o;
  if (st.hasMore || st.pages === 0 || st.describes) throw new RunStopped('the run has no page yet');
  const held = new Set(
    (
      await d.db
        .prepare(`SELECT what FROM sealed_page WHERE run = ?1 AND what IN (1, 2)`)
        .bind(st.run)
        .all<{ what: number }>()
    ).results.map((r) => r.what),
  );
  if (whats.every((w) => held.has(w.what))) return;
  const keys = await sealKeys(d, st);
  const parts = (await ask(() => linkForBank(d, st.linkId)))
    .filter((a) => !held.has(a.what))
    .map((a) => ({ what: a.what as What, payload: jsonBytes(a.answer), move: null }));
  if (parts.length) await addPages(d, o, keys, parts);
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
  await addPages(d, o, await sealKeys(d, st), [
    { what: WHAT.link, payload: jsonBytes(description), move: null },
  ]);
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
  // The run state's cursors are hashed once, for its check, the manifest and the new state.
  const known: CursorHashes = new Map();
  const { s, cursors, lastInbox } = await standing(d, known);
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
        cursorBefore: await cursorHashOf(st.startCursor, known),
        cursorAfter: await cursorHashOf(st.cursor, known),
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
    await runsMac(k, d.budgetId, await runStateOf({ run: st.run, hash, time: runTime }, after, known)),
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
