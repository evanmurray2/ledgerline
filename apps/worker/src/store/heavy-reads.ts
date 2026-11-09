// A log line for each store call that reads many rows (docs/build-plan.md: 327,000 and 413,000 BudgetStore rows in one
// hour on Nov 4 and Nov 5, with no line in Workers Logs to say what read them). It counts what the app's own SQL
// interface read (store/adapter.ts); the job queue's few raw statements aren't counted.
import type { DbStats } from '@ledgerline/db/sql';

/** A phone's full download is about 2,300 rows; ten times that from one call is worth a line. */
export const HEAVY_READ_ROWS = 20_000;

export interface ReadMark {
  rowsRead: number;
  rowsWritten: number;
  at: number;
}

export function markReads(stats: DbStats): ReadMark {
  return { rowsRead: stats.rowsRead, rowsWritten: stats.rowsWritten, at: Date.now() };
}

/**
 * Logs `heavy_read` when the call since `mark` read HEAVY_READ_ROWS or more. `what` names the call: a route
 * ("GET /api/activity"), a job kind ("job:daily_scan") or an RPC ("rpc:ensureJobs"). Returns the line, for tests.
 */
export function noteHeavyRead(
  stats: DbStats,
  mark: ReadMark,
  what: string,
  budgetId: string | null,
): Record<string, unknown> | null {
  // resetStats() in between: count from zero.
  const read = stats.rowsRead >= mark.rowsRead ? stats.rowsRead - mark.rowsRead : stats.rowsRead;
  if (read < HEAVY_READ_ROWS) return null;
  const written =
    stats.rowsWritten >= mark.rowsWritten ? stats.rowsWritten - mark.rowsWritten : stats.rowsWritten;
  const line = { event: 'heavy_read', what, budget: budgetId, read, written, ms: Date.now() - mark.at };
  console.log(JSON.stringify(line));
  return line;
}

/** A route without its query string or ids, so lines group by route. */
export function routeName(request: Request): string {
  const path = new URL(request.url).pathname
    .split('/')
    .map((p) => (/\d/.test(p) && p.length > 8 ? ':id' : p))
    .join('/');
  return `${request.method} ${path}`;
}
