// The inbox (store migration 0003; docs/privacy.md 5.5, phase 4): the server keeps each bank update as it was
// fetched, so that a device can file it too (local/file-run.ts) and the two results can be compared. Server only:
// the table is a store table, and only the sync job and the inbox route call this.
import type { Db } from '@ledgerline/db/sql';
import type { RunPackage } from '../local/file-run.js';
import type { BankState } from '../sync/process.js';

/** The most page text one inbox answer carries. */
export const INBOX_MAX_CHARS = 1_000_000;

/** How long a filed update stays in the inbox. Its pages stay in `raw_page` in any case. */
export const INBOX_KEEP_MS = 14 * 86_400_000;

/**
 * The server begins to file a fetched update: its pages and the budget's data version now. Called at each step
 * that may be the first; only the first call writes.
 */
export async function inboxOpen(db: Db, runId: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO inbox_run (fetch_seq, run_id, connection_id, fetched_at, pages, base_version, created_at)
       SELECT r.fetch_seq, r.id, r.connection_id, r.fetched_at,
         coalesce((SELECT json_group_array(json(x.page)) FROM (
           SELECT json_object('key', p.raw_key, 'nextCursor', p.next_cursor, 'hasMore', p.has_more, 'sha256', p.sha256) AS page
           FROM sync_page p WHERE p.sync_run_id = r.id ORDER BY p.page) x), '[]'),
         (SELECT data_version FROM budget WHERE id = r.budget_id), ?2
       FROM sync_run r WHERE r.id = ?1 AND r.fetch_seq > 0 AND r.fetched_at IS NOT NULL`,
    )
    .bind(runId, now)
    .run();
}

/** The server has filed the update: what the bank said at its end, and the data version now. */
export async function inboxClose(db: Db, runId: string, bank: BankState | null, now: number): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE inbox_run SET run_id = ?1, bank = ?2,
           end_version = (SELECT b.data_version FROM budget b JOIN sync_run r ON r.budget_id = b.id WHERE r.id = ?1)
         WHERE fetch_seq = (SELECT fetch_seq FROM sync_run WHERE id = ?1) AND end_version IS NULL`,
      )
      .bind(runId, bank ? JSON.stringify(bank) : null),
    db.prepare(`DELETE FROM inbox_run WHERE created_at < ?1`).bind(now - INBOX_KEEP_MS),
  ]);
}

/** One update of the inbox, whole: what local/file-run.ts files, with the data versions around the server's filing. */
export interface InboxRun extends RunPackage {
  baseVersion: number;
  endVersion: number;
}

/**
 * The next update after `after` that the server has finished filing, or null. Updates come in order, with none
 * left out: one the server is still filing holds back the ones after it.
 */
export async function inboxNext(db: Db, after: number): Promise<InboxRun | null> {
  const r = await db
    .prepare(`SELECT * FROM inbox_run WHERE fetch_seq > ?1 ORDER BY fetch_seq LIMIT 1`)
    .bind(after)
    .first<{
      fetch_seq: number;
      run_id: string;
      connection_id: string;
      fetched_at: number;
      pages: string;
      bank: string | null;
      base_version: number;
      end_version: number | null;
    }>();
  if (!r || r.end_version === null) return null;
  const named = JSON.parse(r.pages) as {
    key: string;
    nextCursor: string | null;
    hasMore: number;
    sha256: string;
  }[];
  const pages: RunPackage['pages'] = [];
  let size = 0;
  for (const p of named) {
    const raw = await db
      .prepare(`SELECT body FROM raw_page WHERE key = ?1`)
      .bind(p.key)
      .first<{ body: string }>();
    // A page that is gone can't be filed: the update is not offered, nor any after it.
    if (!raw) return null;
    // A very large update (a new bank's first import) is not offered: one answer must stay small.
    size += raw.body.length;
    if (size > INBOX_MAX_CHARS) return null;
    pages.push({
      key: p.key,
      body: raw.body,
      nextCursor: p.nextCursor,
      hasMore: p.hasMore === 1,
      sha256: p.sha256,
    });
  }
  return {
    runId: r.run_id,
    connectionId: r.connection_id,
    fetchedAt: r.fetched_at,
    fetchSeq: r.fetch_seq,
    bank: r.bank ? (JSON.parse(r.bank) as BankState) : null,
    pages,
    baseVersion: r.base_version,
    endVersion: r.end_version,
  };
}

/** The place of the newest update the server has finished filing (0: none). */
export async function inboxLatest(db: Db): Promise<number> {
  const r = await db
    .prepare(`SELECT coalesce(max(fetch_seq), 0) AS n FROM inbox_run WHERE end_version IS NOT NULL`)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** A daily scan the server ran: all a device needs to run the same one (daily-scan.ts). */
export interface InboxScan {
  n: number;
  /** The scan's planned time. */
  at: number;
  baseVersion: number;
  endVersion: number;
}

/** What comes next for a device that has taken updates up to `afterRun` and scans up to `afterScan`. */
export type InboxEvent = { run: InboxRun } | { scan: InboxScan } | null;

/** Notes a scan the server just ran, with the data version before and after it. */
export async function inboxScanned(
  db: Db,
  at: number,
  base: number,
  end: number,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT INTO inbox_scan (at, base_version, end_version, created_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(at, base, end, now),
    db.prepare(`DELETE FROM inbox_scan WHERE created_at < ?1`).bind(now - INBOX_KEEP_MS),
  ]);
}

/**
 * The next bank update or daily scan, in the order the server did them. The data versions give the order: a
 * scan moves the version and an update doesn't, so an update that began at or before a scan's `base_version` came
 * before that scan.
 */
export async function inboxNextEvent(db: Db, afterRun: number, afterScan: number): Promise<InboxEvent> {
  const s = await db
    .prepare(`SELECT n, at, base_version, end_version FROM inbox_scan WHERE n > ?1 ORDER BY n LIMIT 1`)
    .bind(afterScan)
    .first<{ n: number; at: number; base_version: number; end_version: number }>();
  const next = await db
    .prepare(
      `SELECT base_version, end_version FROM inbox_run WHERE fetch_seq > ?1 ORDER BY fetch_seq LIMIT 1`,
    )
    .bind(afterRun)
    .first<{ base_version: number; end_version: number | null }>();
  const scan: InboxScan | null = s
    ? { n: s.n, at: s.at, baseVersion: s.base_version, endVersion: s.end_version }
    : null;
  if (next && (!scan || next.base_version <= scan.baseVersion)) {
    const run = await inboxNext(db, afterRun);
    return run ? { run } : null;
  }
  return scan ? { scan } : null;
}

/** The newest scan the server noted (0: none). */
export async function inboxLatestScan(db: Db): Promise<number> {
  const r = await db.prepare(`SELECT coalesce(max(n), 0) AS n FROM inbox_scan`).first<{ n: number }>();
  return r?.n ?? 0;
}
