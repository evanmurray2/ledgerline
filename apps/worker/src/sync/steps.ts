// Sync run lifecycle (Sync spec: Run lifecycle). Each exported function is the body of one sync job step, so the
// measuring harness can time exactly what a step does. Steps return small JSON (ids, cursors, counts), never pages.
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  MUTATION_DURING_PAGINATION,
  ProviderError,
  scanSyncTailBytes,
  type BankDataProvider,
} from '@ledgerline/bank-provider';
import { sha256Hex } from '@ledgerline/bank-provider';
import { leaseFence, conditionFence, isFenceAbort, renew, MAX_FETCH_RESTARTS } from './lease.js';

export class LeaseLost extends Error {
  constructor() {
    super('sync lease lost');
    this.name = 'LeaseLost';
  }
}

export interface RunState {
  /** The sync_run row this instance works on (its own id unless it adopted a predecessor's staged pages). */
  runId: string;
  phase: 'fetching' | 'applying' | 'finalizing' | 'done' | 'failed';
  startCursor: string | null;
  pagesFetched: number;
  appliedThrough: number;
  appliedEvents: number;
  restartCount: number;
  /** Every page of the update is stored (D-86 A2): it is applied from where it stands, never fetched again. */
  fetched: boolean;
}

interface Ctx {
  db: Db;
  connectionId: string;
  budgetId: string;
  holder: string;
  now: number;
  alsoAccept?: string;
}

async function mustRenew(c: Ctx): Promise<void> {
  if (!(await renew(c.db, c.connectionId, c.holder, c.now, c.alsoAccept))) throw new LeaseLost();
}

/** Step "begin": create this run, or adopt a predecessor that died while applying (F1: adopt, never delete). */
export async function beginRun(c: Ctx, trigger: string): Promise<RunState> {
  await mustRenew(c);
  const [own, prev, conn] = await c.db.batch([
    c.db.prepare(`SELECT * FROM sync_run WHERE id = ?1`).bind(c.holder),
    c.db
      .prepare(
        `SELECT * FROM sync_run WHERE connection_id = ?1 AND id != ?2 AND phase IN ('fetching', 'applying', 'finalizing')
         ORDER BY started_at DESC LIMIT 1`,
      )
      .bind(c.connectionId, c.holder),
    c.db.prepare(`SELECT cursor FROM connection WHERE id = ?1`).bind(c.connectionId),
  ]);
  const ownRow = own?.results[0] as SyncRunRow | undefined;
  if (ownRow) return toState(ownRow);
  const cursor = ((conn?.results[0] as { cursor: string | null } | undefined)?.cursor ?? null) as
    string | null;
  const prevRow = prev?.results[0] as SyncRunRow | undefined;
  const stmts: Stmt[] = [leaseFence(c.db, c.connectionId, c.holder, c.now)];
  // A run whose every page is stored is fetched: its phase stays 'fetching' until its first page is applied.
  const prevFetched = !!prevRow && prevRow.fetch_seq !== null && prevRow.fetch_seq > 0;
  if (prevRow && (prevRow.phase === 'applying' || prevRow.phase === 'finalizing' || prevFetched)) {
    // Adopt: move the not-yet-applied staged pages to this run and continue from applied_through. A fetched update
    // is never fetched again (D-86 A2): it keeps its place and its time, and what it brought stays what the bank sent
    // then.
    stmts.push(
      c.db
        .prepare(
          `INSERT INTO sync_run (id, budget_id, connection_id, phase, run_start_cursor, restart_count, pages_fetched,
             applied_through, applied_events, next_cursor, trigger, started_at, created_at, updated_at, fetched_at)
           SELECT ?1, budget_id, connection_id, phase, run_start_cursor, restart_count, pages_fetched, applied_through,
             applied_events, next_cursor, ?2, ?3, ?3, ?3, fetched_at FROM sync_run WHERE id = ?4`,
        )
        .bind(c.holder, `adopt:${trigger}`, c.now, prevRow.id),
      // The same bank update under a new id: it keeps its time and its place (D-86 A1, A2). The place is unique, so
      // the old row gives it up first, and keeps it as a negative number.
      c.db
        .prepare(`UPDATE sync_run SET fetch_seq = -fetch_seq WHERE id = ?1 AND fetch_seq > 0`)
        .bind(prevRow.id),
      c.db
        .prepare(
          `UPDATE sync_run SET fetch_seq = (SELECT -fetch_seq FROM sync_run WHERE id = ?2 AND fetch_seq < 0) WHERE id = ?1`,
        )
        .bind(c.holder, prevRow.id),
      c.db
        .prepare(`UPDATE sync_page SET sync_run_id = ?1 WHERE sync_run_id = ?2 AND page > ?3`)
        .bind(c.holder, prevRow.id, prevRow.applied_through),
      c.db
        .prepare(
          `UPDATE sync_run SET phase = 'failed', error_code = 'ADOPTED', finished_at = ?2, updated_at = ?2 WHERE id = ?1`,
        )
        .bind(prevRow.id, c.now),
    );
    await c.db.batch(stmts);
    return {
      runId: c.holder,
      phase: prevRow.phase,
      startCursor: prevRow.run_start_cursor,
      pagesFetched: prevRow.pages_fetched,
      appliedThrough: prevRow.applied_through,
      appliedEvents: prevRow.applied_events,
      restartCount: prevRow.restart_count,
      fetched: true,
    };
  }
  if (prevRow && prevRow.phase === 'fetching') {
    // Not fetched to the end, so nothing was applied and the connection cursor has not moved. Drop its pages and
    // start over.
    stmts.push(
      c.db.prepare(`DELETE FROM sync_page WHERE sync_run_id = ?1`).bind(prevRow.id),
      c.db
        .prepare(
          `UPDATE sync_run SET phase = 'failed', error_code = 'ABANDONED', finished_at = ?2, updated_at = ?2 WHERE id = ?1`,
        )
        .bind(prevRow.id, c.now),
    );
  }
  stmts.push(
    c.db
      .prepare(
        `INSERT OR IGNORE INTO sync_run (id, budget_id, connection_id, phase, run_start_cursor, trigger, started_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'fetching', ?4, ?5, ?6, ?6, ?6)`,
      )
      .bind(c.holder, c.budgetId, c.connectionId, cursor, trigger, c.now),
  );
  await c.db.batch(stmts);
  return {
    runId: c.holder,
    phase: 'fetching',
    startCursor: cursor,
    pagesFetched: 0,
    appliedThrough: -1,
    appliedEvents: 0,
    restartCount: 0,
    fetched: false,
  };
}

interface SyncRunRow {
  id: string;
  phase: RunState['phase'];
  run_start_cursor: string | null;
  pages_fetched: number;
  applied_through: number;
  applied_events: number;
  restart_count: number;
  fetch_seq: number | null;
}

function toState(r: SyncRunRow): RunState {
  return {
    runId: r.id,
    phase: r.phase,
    startCursor: r.run_start_cursor,
    pagesFetched: r.pages_fetched,
    appliedThrough: r.applied_through,
    appliedEvents: r.applied_events,
    restartCount: r.restart_count,
    fetched: r.fetch_seq !== null && r.fetch_seq > 0,
  };
}

export function rawPageKey(
  budgetId: string,
  connectionId: string,
  runId: string,
  restart: number,
  page: number,
): string {
  // The suffix makes every attempt's key unique, so a retried fetch step never collides with an earlier attempt.
  const attempt = crypto.randomUUID().slice(0, 8);
  return `raw/${budgetId}/${connectionId}/${runId}/${restart}-${String(page).padStart(4, '0')}-${attempt}`;
}

export type FetchResult =
  { kind: 'page'; hasMore: boolean; nextCursor: string; bytes: number } | { kind: 'mutation' };

/** Step "fetch-{restart}-{i}": one /transactions/sync call, staged as one sync_page row. */
export async function fetchPage(
  c: Ctx,
  provider: BankDataProvider,
  accessToken: string,
  runId: string,
  restart: number,
  page: number,
  cursor: string | null,
  count: number,
): Promise<FetchResult> {
  await mustRenew(c);
  let staged;
  try {
    staged = await provider.fetchSyncPage(
      { id: c.connectionId, accessToken, providerItemId: null },
      cursor,
      count,
    );
  } catch (e) {
    if (e instanceof ProviderError && e.code === MUTATION_DURING_PAGINATION) return { kind: 'mutation' };
    throw e;
  }
  // The body is stored once in raw_page as Plaid sent it, never parsed here, and without a checksum: hashing a
  // 200 KB page costs over 1 ms of CPU and SQLite already protects what it stores (decisions.md D-26). The page row
  // and its body are written in the same fenced batch.
  const bytes = staged.body;
  const text = new TextDecoder().decode(bytes);
  const sha = 'none';
  const key = rawPageKey(c.budgetId, c.connectionId, runId, restart, page);
  await c.db.batch([
    leaseFence(c.db, c.connectionId, c.holder, c.now),
    c.db
      .prepare(
        `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(key, c.budgetId, text, sha, bytes.length, c.now),
    c.db
      .prepare(
        `INSERT OR REPLACE INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        runId,
        page,
        c.budgetId,
        restart,
        key,
        sha,
        bytes.length,
        staged.nextCursor,
        staged.hasMore ? 1 : 0,
        c.now,
      ),
    c.db
      .prepare(`UPDATE sync_run SET pages_fetched = ?2, next_cursor = ?3, updated_at = ?4 WHERE id = ?1`)
      .bind(runId, page + 1, staged.nextCursor, c.now),
    // The last page: the update is fetched. Its time and its place among the budget's updates are set once (D-86 A1,
    // A2); a step that runs again keeps them.
    ...(staged.hasMore
      ? []
      : [
          c.db
            .prepare(
              `UPDATE sync_run SET fetched_at = coalesce(fetched_at, ?2),
                 fetch_seq = coalesce(fetch_seq, (SELECT coalesce(max(abs(fetch_seq)), 0) + 1 FROM sync_run WHERE budget_id = ?3))
               WHERE id = ?1`,
            )
            .bind(runId, c.now, c.budgetId),
        ]),
  ]);
  return { kind: 'page', hasMore: staged.hasMore, nextCursor: staged.nextCursor, bytes: staged.body.length };
}

/** On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: drop this run's pages and restart from run_start_cursor. */
export async function restartFetch(
  c: Ctx,
  runId: string,
): Promise<{ restartCount: number; failed: boolean }> {
  await mustRenew(c);
  const rows = await c.db.batch([
    leaseFence(c.db, c.connectionId, c.holder, c.now),
    c.db.prepare(`DELETE FROM sync_page WHERE sync_run_id = ?1`).bind(runId),
    c.db
      .prepare(
        `UPDATE sync_run SET restart_count = restart_count + 1, pages_fetched = 0, updated_at = ?2,
           phase = CASE WHEN restart_count + 1 > ?3 THEN 'failed' ELSE phase END,
           error_code = CASE WHEN restart_count + 1 > ?3 THEN 'TOO_MANY_RESTARTS' ELSE error_code END
         WHERE id = ?1 RETURNING restart_count, phase`,
      )
      .bind(runId, c.now, MAX_FETCH_RESTARTS),
  ]);
  const r = rows[2]?.results[0] as { restart_count: number; phase: string };
  return { restartCount: r.restart_count, failed: r.phase === 'failed' };
}

/** Columns per bank_event row and bank_txn row; statements are chunked to stay within 100 bound parameters. */
const EVENT_PARAMS = 10;
const EVENTS_PER_STMT = Math.floor(100 / EVENT_PARAMS);

/**
 * Events per apply and processing step (one alarm step each). A page (one Plaid call) is applied in chunks of this
 * size to stay within 10 ms of CPU with SQLite in-process (decisions.md D-37; docs/measurements.md, phase 0).
 */
export const APPLY_CHUNK = 25;
export const CHUNK = { apply: APPLY_CHUNK, process: 25 };

export interface ApplyResult {
  applied: boolean;
  /** Events written by this step. */
  events: number;
  /** True when this step finished the page. */
  pageDone: boolean;
  /** True when this step finished the run's last page (the cursor moved). */
  last: boolean;
  rowsWritten: number;
  statements: number;
}

interface PageRow {
  raw_key: string;
  sha256: string;
  bytes: number;
  next_cursor: string;
  has_more: number;
}

/** Step "apply-{i}-{j}": one atomic batch that writes chunk j of staged page i (events and projection). */
export async function applyPage(
  c: Ctx,
  provider: BankDataProvider,
  runId: string,
  page: number,
  chunk: number,
): Promise<ApplyResult> {
  await mustRenew(c);
  const [pg, run] = await c.db.batch([
    c.db
      .prepare(
        `SELECT p.raw_key, p.sha256, p.bytes, p.next_cursor, p.has_more, r.body
         FROM sync_page p JOIN raw_page r ON r.key = p.raw_key WHERE p.sync_run_id = ?1 AND p.page = ?2`,
      )
      .bind(runId, page),
    c.db
      .prepare(`SELECT applied_through, applied_events, pages_fetched FROM sync_run WHERE id = ?1`)
      .bind(runId),
  ]);
  const runRow = run?.results[0] as
    { applied_through: number; applied_events: number; pages_fetched: number } | undefined;
  if (!runRow) throw new Error('sync_run missing');
  const done = (pageDone: boolean): ApplyResult => ({
    applied: false,
    events: 0,
    pageDone,
    last: false,
    rowsWritten: 0,
    statements: 0,
  });
  if (runRow.applied_through >= page) return done(true);
  if (runRow.applied_through === page - 1 && runRow.applied_events > chunk * CHUNK.apply) return done(false);
  const pageRow = pg?.results[0] as (PageRow & { body: string }) | undefined;
  if (!pageRow) throw new Error(`staged page ${page} missing`);
  const body = pageRow.body;
  const lastPage = pageRow.has_more === 0 && page === runRow.pages_fetched - 1;
  const plan = await planApply(c.db, c, runId, page, chunk, lastPage, pageRow, provider, body);
  try {
    const res = await c.db.batch(plan.stmts);
    const rowsWritten = res.reduce((a, r) => a + r.rowsWritten, 0);
    return {
      applied: true,
      events: plan.events,
      pageDone: plan.pageDone,
      last: plan.pageDone && lastPage,
      rowsWritten,
      statements: plan.stmts.length,
    };
  } catch (e) {
    if (!isFenceAbort(e)) throw e;
    // Either the lease is gone or this chunk was applied by an earlier attempt of this step.
    const r = await c.db
      .prepare(`SELECT applied_through, applied_events FROM sync_run WHERE id = ?1`)
      .bind(runId)
      .first<{ applied_through: number; applied_events: number }>();
    if (
      r &&
      (r.applied_through >= page ||
        (r.applied_through === page - 1 && r.applied_events > chunk * CHUNK.apply))
    ) {
      return done(r.applied_through >= page);
    }
    throw new LeaseLost();
  }
}

type Preparer = Pick<Db, 'prepare'>;

/**
 * The time of a bank update (D-86 A1): when its fetch finished. A row's arrival (bank_txn.created_at, which D-67
 * reads) and its removal carry this time, not the clock of whichever apply step ran, so they don't move when a step
 * is retried or waits. A run with no such time (from before it was recorded) uses the step's clock, ?3, as before.
 * In statements bound (?1 run id, ..., ?3 the step's clock).
 */
// Every time the apply step writes into the budget's rows and the bank log is the update's time, also a row's
// `updated_at` and a log row's `created_at`: a device
// that files the same update (local/file-run.ts) must write the same rows, and its steps run at another moment.
const RUN_TIME = `coalesce((SELECT fetched_at FROM sync_run WHERE id = ?1), ?3)`;

/**
 * The apply step's compute: parse and normalize the page, hash each payload, and build the one batch that applies
 * it. Separate from I/O so the go/no-go harness can time exactly this work.
 */
export async function planApply(
  db: Preparer,
  c: Omit<Ctx, 'db' | 'raw'>,
  runId: string,
  page: number,
  chunk: number,
  lastPage: boolean,
  pageRow: PageRow,
  provider: Pick<BankDataProvider, 'parsePage'>,
  body: string,
): Promise<{ stmts: Stmt[]; events: number; pageDone: boolean }> {
  const parsed = provider.parsePage(body);
  const from = chunk * CHUNK.apply;
  const to = Math.min(parsed.events.length, from + CHUNK.apply);
  const pageDone = to >= parsed.events.length;
  const stmts: Stmt[] = [
    leaseFence(db as Db, c.connectionId, c.holder, c.now),
    // Chunks apply once per run and in order: a retried step whose batch already committed aborts here.
    conditionFence(
      db as Db,
      `SELECT applied_through = ?1 AND applied_events = ?2 FROM sync_run WHERE id = ?3`,
      page - 1,
      from,
      runId,
    ),
  ];

  const evs = parsed.events.slice(from, to);
  const payloads = evs.map((e) => JSON.stringify(e.payload));
  const hashes = await Promise.all(payloads.map((p) => sha256Hex(p)));

  // apply_seq = bank_event.id: the counter row is read inside the same transaction, so concurrent batches
  // (other connections) can never interleave or reuse a sequence number.
  for (let i = 0; i < evs.length; i += EVENTS_PER_STMT) {
    const n = Math.min(EVENTS_PER_STMT, evs.length - i);
    const vals: string[] = [];
    const params: unknown[] = [];
    for (let k = 0; k < n; k++) {
      const rel = i + k;
      const e = evs[rel]!;
      const pos = from + rel;
      const b = params.length;
      vals.push(
        `((SELECT seq FROM apply_counter) + ${rel + 1}, ?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4}, ${pos}, (SELECT seq FROM apply_counter) + ${rel + 1}, ?${b + 5}, ?${b + 6}, ?${b + 7}, ?${b + 8}, ?${b + 9}, ?${b + 10}, coalesce((SELECT fetched_at FROM sync_run WHERE id = ?${b + 3}), ${c.now}))`,
      );
      params.push(
        c.budgetId,
        c.connectionId,
        runId,
        page,
        e.kind,
        e.providerTxnId,
        e.providerAccountId,
        payloads[rel],
        `${pageRow.raw_key}#${e.rawPath}`,
        hashes[rel],
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO bank_event (id, budget_id, connection_id, sync_run_id, page, position, apply_seq, kind, provider_txn_id,
             provider_account_id, payload, raw_ref, sha256, created_at) VALUES ${vals.join(',')}`,
        )
        .bind(...params),
    );
  }

  // Projection, built in SQL from the events just inserted (in page order), so the transactions are parsed once.
  stmts.push(
    db
      .prepare(
        `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, authorized_date,
           pending, pending_provider_txn_id, raw_name, merchant_name, merchant_entity_id, provider_category, payment_channel,
           plaid_name, txn_key, removed_at, first_apply_seq, last_apply_seq, created_at, updated_at)
         SELECT provider_txn_id, budget_id, connection_id, provider_account_id,
           json_extract(payload, '$.amount'), json_extract(payload, '$.date'), json_extract(payload, '$.authorizedDate'),
           json_extract(payload, '$.pending'), json_extract(payload, '$.pendingProviderTxnId'), json_extract(payload, '$.rawName'),
           json_extract(payload, '$.merchantName'), json_extract(payload, '$.merchantEntityId'),
           json_extract(payload, '$.providerCategory'), json_extract(payload, '$.paymentChannel'),
           json_extract(payload, '$.plaidName'), 'p:' || provider_txn_id, NULL, id, id, ${RUN_TIME}, ${RUN_TIME}
         FROM bank_event WHERE sync_run_id = ?1 AND page = ?2 AND position >= ?4 AND position < ?5 AND kind != 'removed' ORDER BY id
         ON CONFLICT (provider_txn_id) DO UPDATE SET
           amount = excluded.amount, date = excluded.date, authorized_date = excluded.authorized_date,
           pending = excluded.pending, pending_provider_txn_id = excluded.pending_provider_txn_id,
           raw_name = excluded.raw_name, merchant_name = excluded.merchant_name,
           merchant_entity_id = excluded.merchant_entity_id, provider_category = excluded.provider_category,
           payment_channel = excluded.payment_channel, plaid_name = excluded.plaid_name, removed_at = NULL,
           last_apply_seq = excluded.last_apply_seq, updated_at = excluded.updated_at`,
      )
      .bind(runId, page, c.now, from, to),
  );
  // A new row for a closed account opens it again, with its card payment category (D-73).
  if (evs.some((e) => e.kind === 'added')) {
    const closedHere = `SELECT a.id FROM account a WHERE a.closed_at IS NOT NULL AND a.provider_account_id IN (
        SELECT provider_account_id FROM bank_event WHERE sync_run_id = ?1 AND page = ?2 AND position >= ?4 AND position < ?5 AND kind = 'added')`;
    stmts.push(
      db
        .prepare(
          `UPDATE category SET archived_at = NULL, updated_at = ${RUN_TIME}
           WHERE kind = 'cc_payment' AND archived_at IS NOT NULL AND card_account_id IN (${closedHere})`,
        )
        .bind(runId, page, c.now, from, to),
      db
        .prepare(`UPDATE account SET closed_at = NULL, updated_at = ${RUN_TIME} WHERE id IN (${closedHere})`)
        .bind(runId, page, c.now, from, to),
    );
  }
  if (evs.some((e) => e.kind === 'removed')) {
    stmts.push(
      db
        .prepare(
          `UPDATE bank_txn SET removed_at = ${RUN_TIME}, updated_at = ${RUN_TIME},
             last_apply_seq = (SELECT max(e.id) FROM bank_event e WHERE e.sync_run_id = ?1 AND e.page = ?2 AND e.kind = 'removed'
                               AND e.position >= ?4 AND e.position < ?5 AND e.provider_txn_id = bank_txn.provider_txn_id)
           WHERE provider_txn_id IN (SELECT provider_txn_id FROM bank_event WHERE sync_run_id = ?1 AND page = ?2
                                     AND position >= ?4 AND position < ?5 AND kind = 'removed')`,
        )
        .bind(runId, page, c.now, from, to),
    );
  }

  stmts.push(db.prepare(`UPDATE apply_counter SET seq = seq + ?1 WHERE id = 1`).bind(evs.length));
  if (pageDone) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bank_page (sync_run_id, page, budget_id, connection_id, raw_key, sha256, bytes, events, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, coalesce((SELECT fetched_at FROM sync_run WHERE id = ?1), ?9))`,
        )
        .bind(
          runId,
          page,
          c.budgetId,
          c.connectionId,
          pageRow.raw_key,
          pageRow.sha256,
          pageRow.bytes,
          parsed.events.length,
          c.now,
        ),
      db
        .prepare(
          `UPDATE sync_run SET applied_through = ?2, applied_events = 0, phase = ?3, updated_at = ?4 WHERE id = ?1`,
        )
        .bind(runId, page, lastPage ? 'finalizing' : 'applying', c.now),
    );
    if (lastPage) {
      // The cursor moves only once every page has been applied (F3).
      stmts.push(
        db
          .prepare(`UPDATE connection SET cursor = ?2, updated_at = ?3 WHERE id = ?1`)
          .bind(c.connectionId, pageRow.next_cursor, c.now),
      );
    }
  } else {
    stmts.push(
      db
        .prepare(`UPDATE sync_run SET applied_events = ?2, phase = 'applying', updated_at = ?3 WHERE id = ?1`)
        .bind(runId, to, c.now),
    );
  }
  return { stmts, events: evs.length, pageDone };
}

/** The fetch step's compute on a received body: read the continuation fields from its tail. */
export function planStage(bytes: Uint8Array): { nextCursor: string; hasMore: boolean } {
  return scanSyncTailBytes(bytes);
}

export { type Ctx as StepContext };
