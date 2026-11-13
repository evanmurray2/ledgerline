// The start of a new budget (D-102): every budget is locked from its first moment. The device makes the budget's
// key, its recovery key and its first entry (apps/web/src/keys/budget.ts createBudget), and a first snapshot of
// its copy, which holds only the budget's own row. The server stores the two as it stores any entry and any
// snapshot, under the Worker's stamps, and marks the budget sealed. The steps, each one request:
//
//   begin    The first entry and the header of the first snapshot are stored. The answer names this start (a
//            start id); a later `begin` names a new one, and the older id is refused from then on.
//   chunk    The snapshot's sealed chunks, for the start id.
//   seal     The log holds the first entry and nothing more, the snapshot is whole: the budget is marked sealed.
//            Only for the newest start id, so two devices that lock at once can't seal each other's entry.
//            From here only the log's routes answer for it.
//
// A start that ends without `seal` leaves nothing in use: the next `begin` clears what the first one stored.
// Only a budget with no data of its own starts: one that holds a bank link is refused.
import type { Db } from '@ledgerline/db/sql';
import { readEntry } from '@ledgerline/seal';
import { conditionFence, isFenceAbort } from '../sync/lease.js';
import { SEALED_BACKSTOP, SEALED_FETCH } from './fetch-job.js';
import { logGenesis, logHead, type AppendResult } from './log-store.js';
import { keyStampStmts, startLinks, type RunDeps } from './runs.js';
import { snapshotBegin, snapshotChunk, type SnapshotAnswer } from './snapshot-store.js';

/** How old the first entry may be when it arrives: the time to write the recovery key down and type it back. */
export const GENESIS_AGE_MS = 60 * 60_000;

export interface StartDeps {
  db: Db;
  budgetId: string;
  /** The server's clock for this request. */
  now: number;
  runs: RunDeps;
}

export type StartAnswer = { ok: true } | { ok: false; why: string };

/** The newest start's id, in `store_note` (a number; the device gets it as a string). */
const START_ID = 'start_id';
/** The answer to a chunk or a seal of a start that a newer `begin` replaced. */
export const OLD_START = 'A newer start of this budget began. Start again.';

/** A new start id: 48 random bits, so an older id is never made again. */
function newStartId(): number {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return b.reduce((n, x) => n * 256 + x, 0) || 1;
}

/** Whether `startId` names the newest start (the one `begin` answered last). */
async function isNewestStart(db: Db, startId: string): Promise<boolean> {
  if (!/^[0-9]{1,16}$/.test(startId)) return false;
  const r = await db
    .prepare(`SELECT value FROM store_note WHERE key = ?1`)
    .bind(START_ID)
    .first<{ value: number }>();
  return r !== null && String(r.value) === startId;
}

/** The tables a sealed budget lives in: cleared when a start that did not finish begins again. */
const SEALED_TABLES = [
  'log_entry',
  'log_state',
  'key_stamp',
  'run_state',
  'link_cursor',
  'run_stage',
  'sealed_page',
  'sealed_run',
  'snapshot_chunk',
  'snapshot',
];

/** The budget is sealed (store/marks.ts). */
export async function isSealedStore(db: Db): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS x FROM store_mark WHERE key = 'sealed'`).first()) !== null;
}

/**
 * Why this budget can't start locked, or null when it can: it is sealed already, or it holds a bank link. Its
 * own row, made by the store on first use, is not data. (The old budget tables are gone: D-106.)
 */
export async function startRefusal(db: Db): Promise<string | null> {
  if (await isSealedStore(db)) return 'This budget is locked already.';
  if (await db.prepare(`SELECT 1 AS x FROM bank_link LIMIT 1`).first())
    return 'This budget already holds data. It can’t start again.';
  return null;
}

/** Stores the device's first entry (with the Worker's stamps on its keys) and begins its first snapshot. */
export async function startBegin(
  d: StartDeps,
  s: { genesis: Uint8Array; header: Uint8Array; signature: Uint8Array; manifest: Uint8Array; chunks: number },
): Promise<{ ok: true; startId: string } | { ok: false; why: string }> {
  const not = await startRefusal(d.db);
  if (not) return { ok: false, why: not };
  // What an earlier try stored goes: nothing reads it until the budget is sealed. Its start id goes with it.
  const startId = newStartId();
  await d.db.batch([
    ...SEALED_TABLES.map((t) => d.db.prepare(`DELETE FROM ${t}`)),
    // A start before this one may have left its devices' counters (log-store.ts `device:<id>` notes).
    d.db.prepare(`DELETE FROM store_note WHERE key LIKE 'device:%'`),
    d.db
      .prepare(
        `INSERT INTO store_note (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(START_ID, startId),
  ]);
  // The first entry was made before the person wrote the recovery key down and typed it back, so it is older
  // than an entry may be (5 minutes). Up to an hour is taken here, for this one entry.
  let made = d.now;
  try {
    const t = (await readEntry(s.genesis)).header.time;
    if (t <= d.now && d.now - t <= GENESIS_AGE_MS) made = t;
  } catch {
    // Not an entry: the log's own check says so below.
  }
  const first: AppendResult = await logGenesis(
    {
      db: d.db,
      budgetId: d.budgetId,
      now: made,
      resting: false,
      freshWay: false,
      lastCompleteRun: 0,
      receiptHashes: async () => null,
      stamps: (before, after) => keyStampStmts(d.runs, before, after, d.now),
    },
    s.genesis,
  );
  if (!first.ok) return { ok: false, why: `The first entry was refused: ${first.why}.` };
  const snap: SnapshotAnswer = await snapshotBegin(
    { db: d.db, budgetId: d.budgetId, now: d.now, resting: false },
    { header: s.header, signature: s.signature, manifest: s.manifest, chunks: s.chunks },
  );
  return snap.ok
    ? { ok: true, startId: String(startId) }
    : { ok: false, why: `The snapshot was refused: ${snap.why}.` };
}

/** One sealed chunk of the first snapshot. */
export async function startChunk(
  d: StartDeps,
  startId: string,
  id: string,
  k: number,
  bytes: Uint8Array,
): Promise<StartAnswer> {
  if (await isSealedStore(d.db)) return { ok: false, why: 'This budget is locked already.' };
  if (!(await isNewestStart(d.db, startId))) return { ok: false, why: OLD_START };
  const r = await snapshotChunk({ db: d.db, budgetId: d.budgetId, now: d.now, resting: false }, id, k, bytes);
  return r.ok ? { ok: true } : { ok: false, why: `The chunk was refused: ${r.why}.` };
}

/**
 * Seals the new budget: the log holds the first entry and nothing more, and the first snapshot is whole and
 * stands at that entry. The run state gets its stamp, any job queued for the budget goes, and the mark is set.
 */
export async function startSeal(d: StartDeps, startId: string, markNow: number): Promise<StartAnswer> {
  const not = await startRefusal(d.db);
  if (not) return { ok: false, why: not };
  if (!(await isNewestStart(d.db, startId))) return { ok: false, why: OLD_START };
  if ((await logHead(d.db)) !== 1) return { ok: false, why: 'The first entry is not stored.' };
  const snap = await d.db
    .prepare(`SELECT count(*) AS n FROM snapshot WHERE whole_at IS NOT NULL AND number = 1`)
    .first<{ n: number }>();
  if ((snap?.n ?? 0) !== 1) return { ok: false, why: 'The first snapshot is not stored whole.' };
  // No bank link yet: the run state is stamped with none.
  await startLinks(d.runs, [], d.now);
  try {
    await sealNow(d, startId, markNow);
  } catch (x) {
    // A newer `begin` came between the checks above and the mark.
    if (isFenceAbort(x)) return { ok: false, why: OLD_START };
    throw x;
  }
  return { ok: true };
}

/** The mark, in one write that holds only while `startId` is still the newest start. */
async function sealNow(d: StartDeps, startId: string, markNow: number): Promise<void> {
  await d.db.batch([
    conditionFence(d.db, `SELECT value = ?2 FROM store_note WHERE key = ?1`, START_ID, Number(startId)),
    // A sealed budget runs only its own jobs; they are queued by the store once this answers.
    d.db
      .prepare(`DELETE FROM job WHERE kind NOT IN (?1, ?2, 'register_link')`)
      .bind(SEALED_FETCH, SEALED_BACKSTOP),
    d.db
      .prepare(
        `INSERT INTO store_note (key, value) VALUES ('started_at', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(d.now),
    d.db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(markNow),
    d.db.prepare(`DELETE FROM store_note WHERE key = ?1`).bind(START_ID),
  ]);
}
