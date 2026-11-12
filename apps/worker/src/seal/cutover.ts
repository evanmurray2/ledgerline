// The cutover of a budget that already exists (docs/privacy.md section 8, steps 6 and 7): its tables stop being
// the budget, and its sealed log starts, from the first entry and the first snapshot a device made of its own
// copy. The steps, each one request:
//
//   freeze   The budget takes no write and runs no job, for at most 15 minutes. The server checks that nothing is
//            part-way (a bank update, a filing, a job), and gives the device a hash of every table, so the device
//            can see that its copy is the server's, row for row; and what filing starts from (each link's cursor
//            as a hash, and the place of the last update the server filed).
//   begin    The device's first entry and the header of its first snapshot are stored.
//   chunk    The snapshot's sealed chunks.
//   seal     Still frozen, nothing changed, the snapshot whole: each link starts at its cutover cursor under the
//            Worker's stamp, the old jobs go, and the budget is marked sealed. From here only the log's routes
//            answer for it.
//   back     For 7 days, the way back: the mark is cleared and the old code runs on the old tables, which nothing
//            touched. Edits made since are gone; bank rows since come again from the bank.
//
// A freeze that ends without `seal` leaves the budget as it was: what `begin` stored sits in tables the old code
// never reads, and the next freeze clears it. Nothing here runs unless the Worker's `CUTOVER` variable is `on`.
import type { Db } from '@ledgerline/db/sql';
import { cursorHash, toHex } from '@ledgerline/seal';
import { tableHashes } from '../local/device-snapshot.js';
import { MAX_FREEZE_MS } from '../store/marks.js';
import { SEALED_BACKSTOP, SEALED_FETCH } from './fetch-job.js';
import { logGenesis, logHead, type AppendResult } from './log-store.js';
import { keyStampStmts, startLinks, type RunDeps } from './runs.js';
import { snapshotBegin, snapshotChunk, type SnapshotAnswer } from './snapshot-store.js';

/** How long after the cutover the way back stays open. */
export const WAY_BACK_MS = 7 * 86_400_000;

export interface CutoverDeps {
  db: Db;
  budgetId: string;
  /** The server's clock for this request: the times of what is stored, and the 7 days of the way back. */
  now: number;
  /**
   * The store's own clock, which its marks are read by (store/marks.ts): the freeze begins and ends by it, so
   * that the cutover and every old route agree on whether the budget is frozen. In production the two are one.
   */
  markNow: number;
  runs: RunDeps;
}

/** The tables the sealed budget lives in: empty before the cutover, and cleared when one starts over. */
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
  'store_note',
];

const note = async (db: Db, key: string): Promise<number | null> =>
  (await db.prepare(`SELECT value FROM store_note WHERE key = ?1`).bind(key).first<{ value: number }>())
    ?.value ?? null;

async function marks(db: Db, now: number): Promise<{ sealed: boolean; frozenUntil: number | null }> {
  const rows = (
    await db.prepare(`SELECT key, until FROM store_mark`).all<{ key: string; until: number | null }>()
  ).results;
  const frozen = rows.find((r) => r.key === 'frozen');
  return {
    sealed: rows.some((r) => r.key === 'sealed'),
    frozenUntil: frozen && typeof frozen.until === 'number' && frozen.until > now ? frozen.until : null,
  };
}

/**
 * What stands in the way of the cutover, in words for the person; empty when nothing does. Checked when the
 * budget is frozen and again before it is sealed.
 */
export async function cutoverBlocks(db: Db, budgetId: string, now: number): Promise<string[]> {
  const one = async (sql: string, ...p: unknown[]) =>
    ((
      await db
        .prepare(sql)
        .bind(...p)
        .first<{ n: number }>()
    )?.n ?? 0) > 0;
  const why: string[] = [];
  if (
    await one(
      `SELECT count(*) AS n FROM sync_run r WHERE r.budget_id = ?1 AND r.phase NOT IN ('done', 'failed')
         AND EXISTS (SELECT 1 FROM connection c WHERE c.id = r.connection_id AND c.removed_at IS NULL)`,
      budgetId,
    )
  )
    why.push('A bank update is being fetched or filed.');
  if (await one(`SELECT count(*) AS n FROM sync_page WHERE budget_id = ?1`, budgetId))
    why.push('Pages of a bank update wait to be filed.');
  if (
    await one(
      `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND removed_at IS NULL
         AND ((sync_lock IS NOT NULL AND coalesce(lock_expires, 0) >= ?2) OR resync_requested = 1)`,
      budgetId,
      now,
    )
  )
    why.push('A bank update is asked for or in progress.');
  if (
    await one(
      `SELECT count(*) AS n FROM bank_event e JOIN budget b ON b.id = e.budget_id
       WHERE e.budget_id = ?1 AND e.id > b.processed_through`,
      budgetId,
    )
  )
    why.push('Bank rows wait to be filed.');
  // A job that is not one of the daily ones is work part-way (a sync, a one-time fix); so is a maintenance run
  // past its first step.
  if (
    await one(
      `SELECT count(*) AS n FROM job WHERE failed_at IS NULL AND (recurring = 0
         OR (kind = 'maintenance' AND coalesce(json_extract(state, '$.phase'), 'start') != 'start'))
         AND kind NOT IN ('register_link')`,
    )
  )
    why.push('A background job is part-way.');
  // A step of any job that is running now, or failed and waits to run again.
  if (await one(`SELECT count(*) AS n FROM job WHERE failed_at IS NULL AND attempts > 0`))
    why.push('A background job is running.');
  // A link the old code never fetched (not set up, or with no cursor) has no place to go on from.
  if (
    await one(
      `SELECT count(*) AS n FROM bank_link l JOIN connection c ON c.id = l.connection_id
       WHERE l.budget_id = ?1 AND l.provider = 'plaid' AND l.mac IS NOT NULL AND c.removed_at IS NULL
         AND (c.setup_done != 1 OR c.cursor IS NULL OR c.cursor = '')`,
      budgetId,
    )
  )
    why.push('A bank link is not set up yet.');
  if (
    await one(
      // Every link must carry the Worker's stamp, but for one that never had a token: there is nothing to fetch.
      `SELECT count(*) AS n FROM bank_link WHERE budget_id = ?1 AND provider = 'plaid' AND mac IS NULL
         AND coalesce(check_result, '') != 'no_token'`,
      budgetId,
    )
  )
    why.push('A bank link has not been checked yet.');
  return why;
}

export type FreezeAnswer =
  | { ok: false; why: string[] }
  | {
      ok: true;
      /** When the freeze ends by itself. */
      until: number;
      /** A hash of every table, as a snapshot's manifest names them (local/device-snapshot.ts). */
      tables: { name: string; hash: string }[];
      /** Each bank link the server goes on fetching, with the hash of its cursor now. */
      links: { linkId: string; cursorHash: string }[];
      /** The place of the last bank update the server itself filed (`sync_run.fetch_seq`). */
      seqBase: number;
    };

/**
 * What moves whenever anything in the budget's tables is written: the change log's last number (every write to
 * a synced table, by trigger), and the size and last key of the tables that have no trigger. Taken when the
 * budget is frozen and compared before each later step: a write that slipped past the freeze (one that began
 * before it, or a read that also writes) stops the cutover.
 */
async function fingerprint(db: Db, budgetId: string): Promise<string> {
  const r = await db
    .prepare(
      `SELECT
         (SELECT data_version FROM budget WHERE id = ?1) AS version,
         (SELECT coalesce(max(seq), 0) FROM change_log) AS changes,
         (SELECT count(*) || ':' || coalesce(max(id), 0) FROM audit_log) AS audit,
         (SELECT count(*) || ':' || coalesce(max(at), 0) FROM txn_key_move) AS moves,
         (SELECT count(*) || ':' || coalesce(max(id), 0) FROM bank_event) AS events,
         (SELECT count(*) || ':' || coalesce(max(updated_at), 0) FROM sync_run) AS runs,
         (SELECT count(*) FROM job) AS jobs`,
    )
    .bind(budgetId)
    .first<Record<string, unknown>>();
  return JSON.stringify(r);
}

/** The links the sealed fetch takes over, each with its cursor as the old tables hold it. */
async function linkCursors(db: Db, budgetId: string): Promise<{ linkId: string; cursor: string }[]> {
  const rows = await db
    .prepare(
      `SELECT l.id, c.cursor FROM bank_link l JOIN connection c ON c.id = l.connection_id
       WHERE l.budget_id = ?1 AND l.provider = 'plaid' AND l.mac IS NOT NULL AND c.removed_at IS NULL ORDER BY l.id`,
    )
    .bind(budgetId)
    .all<{ id: string; cursor: string | null }>();
  return rows.results.map((r) => ({ linkId: r.id, cursor: r.cursor ?? '' }));
}

/** Freezes the budget for the cutover, when nothing stands in its way. */
export async function cutoverFreeze(d: CutoverDeps): Promise<FreezeAnswer> {
  const m = await marks(d.db, d.markNow);
  if (m.sealed) return { ok: false, why: ['This budget is sealed already.'] };
  const why = await cutoverBlocks(d.db, d.budgetId, d.now);
  if (why.length) return { ok: false, why };
  // The answer is worked out first, and the budget is frozen last, only if nothing moved meanwhile: a request
  // that dies while it hashes leaves no freeze behind.
  const before = await fingerprint(d.db, d.budgetId);
  const tables = (await tableHashes(d.db)).map((t) => ({ name: t.name, hash: toHex(t.hash) }));
  const links = [];
  for (const l of await linkCursors(d.db, d.budgetId))
    links.push({ linkId: l.linkId, cursorHash: toHex(await cursorHash(l.cursor)) });
  const seq = await d.db
    .prepare(`SELECT coalesce(max(abs(fetch_seq)), 0) AS n FROM sync_run WHERE budget_id = ?1`)
    .bind(d.budgetId)
    .first<{ n: number }>();
  if ((await fingerprint(d.db, d.budgetId)) !== before)
    return { ok: false, why: ['The budget changed just now. Try again.'] };
  const until = d.markNow + MAX_FREEZE_MS;
  await d.db.batch([
    // What an earlier try stored goes: the old code never read it.
    ...SEALED_TABLES.map((t) => d.db.prepare(`DELETE FROM ${t}`)),
    // With the freeze: what the budget looked like, and the hashes the phone must show it has too.
    d.db
      .prepare(
        `INSERT INTO store_mark (key, at, until, note) VALUES ('frozen', ?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET at = excluded.at, until = excluded.until, note = excluded.note`,
      )
      .bind(d.markNow, until, JSON.stringify({ print: before, tables })),
  ]);
  // Frozen now. If a write landed between the last look and the mark, the next step sees it and stops.
  return { ok: true, until, tables, links, seqBase: seq?.n ?? 0 };
}

/** What the freeze noted: the budget's fingerprint and the table hashes given to the phone. */
async function frozenNote(
  db: Db,
): Promise<{ print: string; tables: { name: string; hash: string }[] } | null> {
  const r = await db
    .prepare(`SELECT note FROM store_mark WHERE key = 'frozen'`)
    .first<{ note: string | null }>();
  if (!r?.note) return null;
  try {
    return JSON.parse(r.note) as { print: string; tables: { name: string; hash: string }[] };
  } catch {
    return null;
  }
}

/** Whether the budget is still frozen for this cutover and nothing changed since: null, or why not. */
async function stillFrozen(d: CutoverDeps): Promise<string | null> {
  const m = await marks(d.db, d.markNow);
  if (m.sealed) return 'This budget is sealed already.';
  if (m.frozenUntil === null) return 'The budget is not frozen any more. Start again.';
  const noted = await frozenNote(d.db);
  if (!noted || noted.print !== (await fingerprint(d.db, d.budgetId)))
    return 'The budget changed while it was frozen. Start again.';
  const why = await cutoverBlocks(d.db, d.budgetId, d.now);
  return why[0] ?? null;
}

export type CutoverAnswer = { ok: true } | { ok: false; why: string };

/** Stores the device's first entry (with the Worker's stamps on its keys) and begins its first snapshot. */
export async function cutoverBegin(
  d: CutoverDeps,
  s: {
    genesis: Uint8Array;
    header: Uint8Array;
    signature: Uint8Array;
    manifest: Uint8Array;
    chunks: number;
    /** The hash of every table of the phone's copy, as it was when the phone compared it with the freeze's answer. */
    tables: { name: string; hash: string }[];
  },
): Promise<CutoverAnswer> {
  const not = await stillFrozen(d);
  if (not) return { ok: false, why: not };
  // The server does not take the phone's word that its copy is the budget: the phone shows its hashes.
  const mine = new Map((await frozenNote(d.db))!.tables.map((t) => [t.name, t.hash]));
  if (s.tables.length !== mine.size || s.tables.some((t) => mine.get(t.name) !== t.hash))
    return { ok: false, why: 'This device’s copy is not the same as the server’s.' };
  // One first entry and one snapshot to a freeze.
  if ((await logHead(d.db)) !== 0)
    return { ok: false, why: 'The first entry is stored already. Start again.' };
  const first: AppendResult = await logGenesis(
    {
      db: d.db,
      budgetId: d.budgetId,
      now: d.now,
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
  return snap.ok ? { ok: true } : { ok: false, why: `The snapshot was refused: ${snap.why}.` };
}

/** One sealed chunk of the first snapshot. */
export async function cutoverChunk(
  d: CutoverDeps,
  id: string,
  k: number,
  bytes: Uint8Array,
): Promise<CutoverAnswer> {
  const not = await stillFrozen(d);
  if (not) return { ok: false, why: not };
  const r = await snapshotChunk({ db: d.db, budgetId: d.budgetId, now: d.now, resting: false }, id, k, bytes);
  return r.ok ? { ok: true } : { ok: false, why: `The chunk was refused: ${r.why}.` };
}

/**
 * Seals the budget: nothing changed since the freeze, the log holds the first entry and nothing more, and the
 * first snapshot is whole and stands at that entry. Then the links start at their cutover cursors, the old jobs
 * go, and the mark is set.
 */
export async function cutoverSeal(d: CutoverDeps): Promise<CutoverAnswer> {
  const not = await stillFrozen(d);
  if (not) return { ok: false, why: not };
  if ((await logHead(d.db)) !== 1) return { ok: false, why: 'The first entry is not stored.' };
  const snap = await d.db
    .prepare(`SELECT count(*) AS n FROM snapshot WHERE whole_at IS NOT NULL AND number = 1`)
    .first<{ n: number }>();
  if ((snap?.n ?? 0) !== 1) return { ok: false, why: 'The first snapshot is not stored whole.' };
  // Each link's cursor moves under the Worker's stamp: the sealed fetch goes on from it.
  await startLinks(d.runs, await linkCursors(d.db, d.budgetId), d.now);
  await d.db.batch([
    // The link's fetch state, as the old tables last had it.
    d.db.prepare(
      `UPDATE bank_link SET
         status = iif((SELECT c.status FROM connection c WHERE c.id = bank_link.connection_id) = 'login_required', 'needs_repair', 'ok'),
         error_code = (SELECT c.error_code FROM connection c WHERE c.id = bank_link.connection_id),
         last_fetched_at = (SELECT c.last_synced_at FROM connection c WHERE c.id = bank_link.connection_id)`,
    ),
    // The old jobs go; the sealed budget's own are queued by the next daily check and by the first request.
    d.db
      .prepare(`DELETE FROM job WHERE kind NOT IN (?1, ?2, 'register_link', 'stamp_links')`)
      .bind(SEALED_FETCH, SEALED_BACKSTOP),
    d.db
      .prepare(
        `INSERT INTO store_note (key, value) VALUES ('cutover_at', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(d.now),
    d.db.prepare(`INSERT INTO store_mark (key, at) VALUES ('sealed', ?1)`).bind(d.markNow),
    d.db.prepare(`DELETE FROM store_mark WHERE key = 'frozen'`),
  ]);
  return { ok: true };
}

/**
 * Where the budget stands, for the screen that offers the move and the way back: sealed or not, and until when
 * the way back is open. It says nothing of the budget itself.
 */
export async function cutoverState(
  d: Pick<CutoverDeps, 'db' | 'now' | 'markNow'>,
): Promise<{ sealed: boolean; backUntil: number | null }> {
  const m = await marks(d.db, d.markNow);
  if (!m.sealed) return { sealed: false, backUntil: null };
  const at = await note(d.db, 'cutover_at');
  return { sealed: true, backUntil: at !== null && d.now - at <= WAY_BACK_MS ? at + WAY_BACK_MS : null };
}

/**
 * The way back, for 7 days after the cutover (section 8 step 7): the mark is cleared, the sealed budget's jobs
 * go, and the old code runs on the old tables, which nothing touched since the freeze (each link's cursor there
 * is its cutover cursor). What the log took since is not carried over. The caller queues the daily jobs again.
 */
export async function cutoverBack(d: Pick<CutoverDeps, 'db' | 'now' | 'markNow'>): Promise<CutoverAnswer> {
  const m = await marks(d.db, d.markNow);
  if (!m.sealed) return { ok: false, why: 'This budget is not sealed.' };
  const at = await note(d.db, 'cutover_at');
  if (at === null || d.now - at > WAY_BACK_MS) return { ok: false, why: 'The way back is closed.' };
  await d.db.batch([
    d.db.prepare(`DELETE FROM job WHERE kind IN (?1, ?2)`).bind(SEALED_FETCH, SEALED_BACKSTOP),
    d.db.prepare(`DELETE FROM run_stage`),
    d.db.prepare(`DELETE FROM store_mark`),
  ]);
  return { ok: true };
}
