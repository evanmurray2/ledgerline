// A device files one bank update (docs/privacy.md 5.4): what the server's sync job does after the fetch, with the
// server's own steps, on the device's copy. The update comes as a package: the pages the bank sent, whole, with
// the update's number and time (D-86 A1, A2). Everything it writes carries that time, and the ids of new rows
// come from their content, so a device and the server that file the same update end with the same rows
// (test/file-run.test.ts).
import type { BankDataProvider } from '@ledgerline/bank-provider';
import type { Env } from '../env.js';
import { acquire } from '../sync/lease.js';
import { endOfUpdate, healPending, processPending, type BankState } from '../sync/process.js';
import { applyPage, beginRun } from '../sync/steps.js';

/** One bank update, as fetched: nothing here is worked out. */
export interface RunPackage {
  runId: string;
  connectionId: string;
  /** When the server finished fetching it: the time of everything it causes (A1). */
  fetchedAt: number;
  /** Its place among the budget's updates (A2). */
  fetchSeq: number;
  /** Each page as stored by the fetch: its name in the bank log (`key`), its text and its checksum. */
  /**
   * What the bank said at the end of the update (balances, card statements), or null when the server couldn't ask.
   * A device can't ask the bank, so this comes with the update.
   */
  bank: BankState | null;
  pages: { key: string; body: string; nextCursor: string | null; hasMore: boolean; sha256: string }[];
}

/** Guards against a package that never ends. */
const MAX_STEPS = 10_000;

export async function fileRun(
  env: Env,
  budgetId: string,
  pkg: RunPackage,
  /** Reads a page (`parsePage`): the bank's format, no network. */
  provider: BankDataProvider,
): Promise<{ events: number }> {
  const db = env.DB;
  const at = pkg.fetchedAt;
  const { runId, connectionId } = pkg;
  if (!(await acquire(db, connectionId, runId, at))) throw new Error('another update is being filed');
  const ctx = { db, connectionId, budgetId, holder: runId, now: at };
  await beginRun(ctx, 'device');
  // The pages, staged as the fetch step stages them.
  await db.batch([
    ...pkg.pages.flatMap((p, i) => {
      const key = p.key;
      // The page's size as the fetch step counts it: bytes, not characters.
      const bytes = new TextEncoder().encode(p.body).length;
      return [
        db
          .prepare(
            `INSERT OR IGNORE INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(key, budgetId, p.body, p.sha256, bytes, at),
        db
          .prepare(
            `INSERT OR IGNORE INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at)
             VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(runId, i, budgetId, key, p.sha256, bytes, p.nextCursor, p.hasMore ? 1 : 0, at),
      ];
    }),
    db
      .prepare(`UPDATE sync_run SET pages_fetched = ?2, fetched_at = ?3, fetch_seq = ?4 WHERE id = ?1`)
      .bind(runId, pkg.pages.length, at, pkg.fetchSeq),
  ]);
  let steps = 0;
  const step = () => {
    if (++steps > MAX_STEPS) throw new Error('the update did not finish');
  };
  for (let i = 0; i < pkg.pages.length; i++)
    for (let chunk = 0; ; chunk++) {
      step();
      if ((await applyPage(ctx, provider, runId, i, chunk)).pageDone) break;
    }
  let events = 0;
  for (;;) {
    step();
    const r = await processPending(env, budgetId, at);
    events += r.processed;
    if (r.caughtUp) break;
  }
  // Pending rows a posted row should have claimed, whether or not the bank sent news about them (D-47), counted
  // from the update's time as on the server.
  await healPending(env, budgetId, connectionId, at);
  // The end of the update: balances, card snapshots and the bank difference, from what the bank said.
  await endOfUpdate(db, { budgetId, connectionId }, at, pkg.bank);
  await db.batch([
    db
      .prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE id = ?1`)
      .bind(connectionId),
    db.prepare(`UPDATE sync_run SET phase = 'done', finished_at = ?2 WHERE id = ?1`).bind(runId, at),
  ]);
  return { events };
}
