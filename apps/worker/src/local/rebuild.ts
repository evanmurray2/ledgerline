// A copy made again from the budget's newest trusted snapshot, by itself (docs/privacy.md 5.3): when the entries
// this device needs next are gone from the server (`BelowFloor`: a checked snapshot covers them), or when the copy
// can't be used as it is (`CopyAhead`, `FilingInterrupted`). The new copy is made in an empty database, as for a
// device that joins: the snapshot is opened, then the log is read on from there. What this device saw before must
// be on that log: its place, its own last entries, the last entry of each other device (`DeviceLog.saw`,
// `remember`), the last public entry and checkpoint. A log that doesn't pass through them is another history
// (`LogFork`); the old copy is then left as it was, and the new one thrown away.
//
// What the new copy needs of the old one is read first (`readStale`), so the old database can be closed before the
// new one is built and the two never sit side by side (local/web-entry.ts keeps the old one's bytes, compressed,
// until the new one is whole).
//
// The waiting edits are kept: each is run again on the new copy (one that no longer passes is counted as lost).
// Filed bank runs that waited are not kept; the device files them again. This device's bank log that the log
// doesn't hold yet (runs it filed before bank entries carried their bank log, D-103) is a record only, and it is
// kept: its rows go into the new copy and are shared again.
import type { Entry } from '@ledgerline/seal';
import { BelowFloor, DeviceLog, LogFork } from './device-log.js';
import { openSnapshot, type SnapshotTransport } from './device-snapshot.js';
import { BANK_LOG_TABLES, FilingInterrupted, type LocalEngine, type QueuedEdit } from './engine.js';
import { LogSession, SHARE_PATH, type LogTransport } from './log-session.js';
import { CopyAhead } from './sealed-filing.js';

/** The causes that make a copy again from a snapshot; anything else (a fork included) is not one. */
export function needsRebuild(x: unknown): boolean {
  return x instanceof BelowFloor || x instanceof CopyAhead || x instanceof FilingInterrupted;
}

/**
 * Runs `fn`; when it finds the copy can't go on as it is (`needsRebuild`: below the log's floor, ahead of it, or
 * stopped in a filing), the copy is made again (`rebuild`), the app is told before and after, and `fn` runs once
 * more on the new copy. Anything else, a fork included, is thrown as it is.
 */
export async function afterRebuild<T>(
  fn: () => Promise<T>,
  rebuild: () => Promise<unknown>,
  tell: (event: 'rebuilding' | 'rebuilt') => void,
): Promise<T> {
  try {
    return await fn();
  } catch (x) {
    if (!needsRebuild(x)) throw x;
    tell('rebuilding');
    await rebuild();
    tell('rebuilt');
    return fn();
  }
}

/**
 * A snapshot check (`checkSnapshot`, in a scratch copy) whose entries after the snapshot it builds on are gone (a
 * newer checked snapshot covers them): there is nothing this device can check, which is no fault of its own copy.
 */
export async function unlessGone<T>(
  check: () => Promise<T | { checked: false; why: 'no older snapshot' }>,
): Promise<T | { checked: false; why: 'no older snapshot' }> {
  try {
    return await check();
  } catch (x) {
    if (x instanceof BelowFloor) return { checked: false, why: 'no older snapshot' };
    throw x;
  }
}

/** The most pages of the log read after the snapshot in one rebuild (a page is up to 100 entries). */
const MAX_PAGES = 1000;

/** What a rebuild keeps of the old copy: its waiting edits, and its bank log that is not in the log yet. */
export interface StaleCopy {
  edits: Omit<QueuedEdit, 'undo' | 'through' | 'rows'>[];
  /** By table, the rows of the sealed runs this copy filed and has not shared. */
  bankLog: { table: string; rows: Record<string, unknown>[] }[];
}

const runOf = (syncRunId: unknown): number => Number(String(syncRunId).slice('sealed:'.length));

/**
 * Reads what a rebuild keeps of a copy (only reads it). Its bank log not yet shared: every sealed run's, while the
 * copy has not noted its bank log as shared; else the runs of the shares still waiting in its queue.
 */
export async function readStale(stale: LocalEngine): Promise<StaleCopy> {
  const queue = await stale.queue();
  const edits = queue
    .filter((e) => !e.bank && e.path !== SHARE_PATH)
    .map(({ undo: _undo, through: _through, rows: _rows, ...e }) => e);
  let unshared: ((run: number) => boolean) | null = null;
  if (!(await stale.noted(LogSession.BANK_LOG_SHARED))) unshared = () => true;
  else {
    const ranges = queue
      .filter((e) => e.path === SHARE_PATH)
      .map((e) => e.body as { from: number; to: number });
    if (ranges.length) unshared = (run) => ranges.some((r) => run >= r.from && run <= r.to);
  }
  const bankLog: StaleCopy['bankLog'] = [];
  if (unshared)
    for (const table of BANK_LOG_TABLES) {
      const rows = (
        await stale.db
          .prepare(`SELECT * FROM ${table} WHERE sync_run_id LIKE 'sealed:%' ORDER BY sync_run_id`)
          .all<Record<string, unknown>>()
      ).results.filter((r) => unshared(runOf(r.sync_run_id)));
      if (rows.length) bankLog.push({ table, rows });
    }
  return { edits, bankLog };
}

/**
 * Puts the old copy's bank log of the runs the new copy has none of into the new copy, as it was. A row whose
 * key the new copy holds already is left out (the log's own rows win). Gives the runs put in.
 */
async function keepBankLog(fresh: LocalEngine, bankLog: StaleCopy['bankLog']): Promise<number[]> {
  const held = new Set(
    (
      await fresh.db
        .prepare(`SELECT DISTINCT sync_run_id FROM bank_event WHERE sync_run_id LIKE 'sealed:%'`)
        .all<{ sync_run_id: string }>()
    ).results.map((r) => r.sync_run_id),
  );
  const runs = new Set<number>();
  const stmts = [];
  for (const { table, rows } of bankLog)
    for (const r of rows) {
      if (held.has(String(r.sync_run_id))) continue;
      runs.add(runOf(r.sync_run_id));
      const cols = Object.keys(r);
      stmts.push(
        fresh.db
          .prepare(
            `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`,
          )
          .bind(...cols.map((c) => r[c])),
      );
    }
  for (let i = 0; i < stmts.length; i += 500) await fresh.db.batch(stmts.slice(i, i + 500));
  return [...runs].sort((a, b) => a - b);
}

/**
 * Makes the copy again in `fresh` (an empty copy) from the newest trusted snapshot, with what `readStale` kept of
 * the old copy (at its place `old`), and gives the device's new place in the log, with how many waiting edits are
 * kept and how many no longer passed (`lost`).
 */
export async function rebuildFrom(
  fresh: LocalEngine,
  stale: StaleCopy,
  t: SnapshotTransport & LogTransport,
  old: DeviceLog,
  d: { clock: () => number; encode: (e: Entry) => Uint8Array },
): Promise<{ log: DeviceLog; kept: number; lost: number }> {
  const saw = old.saw();
  const at = old.place();
  const checkpoint = at.checkpoints.filter((c) => c.number % 1000 === 0 && c.number <= at.number).pop();
  const log = await openSnapshot(fresh, t, {
    keys: old.keysHeld(),
    budgetId: old.budgetId,
    deviceId: old.deviceId,
    clock: d.clock,
    remembered: at.lastPublic,
    ...(checkpoint ? { checkpoint } : {}),
  });
  // A snapshot at or past the old place must hold every entry this device saw: each device's counter at least
  // what it was here.
  if (log.number >= at.number) {
    const counters = new Map(log.place().counters.map((c) => [c.deviceId, c.counter]));
    for (const [device, n] of saw.counters)
      if ((counters.get(device) ?? 0) < n) throw new LogFork(`the snapshot leaves out entries of ${device}`);
  }
  log.remember(saw);
  // The waiting edits run again on the new copy, oldest first, with their own ids and times; then the log is read
  // on to its end, under them (an edit the log holds already leaves the queue as sent). It must reach the old
  // place and pass through what was seen.
  let lost = 0;
  for (const e of stale.edits) {
    const r = await fresh.enqueue(e).catch(() => null);
    if (!r || r.response.status >= 300) lost++;
  }
  const session = new LogSession(fresh, log, t, d.encode);
  for (let n = 0; ; n++) {
    if (n > MAX_PAGES) throw new Error('the log did not end');
    const r = await session.pull();
    lost += r.lost;
    if (r.entries === 0) break;
  }
  if (log.number < at.number || log.mustReach > log.number)
    throw new LogFork('the log ends before what this device saw', true);
  const kept = (await fresh.queue()).length;
  // The copy holds the log's bank log, and this device's own that the log doesn't hold yet, which is shared again.
  const runs = await keepBankLog(fresh, stale.bankLog);
  if (runs.length) await session.shareRuns(d.clock(), runs);
  await fresh.note(LogSession.BANK_LOG_SHARED, '1');
  await fresh.note(LogSession.PLACE, log.save());
  return { log, kept, lost };
}

/** `readStale` then `rebuildFrom`, with the old copy open beside the new one (tests, and a copy with room). */
export async function rebuildCopy(
  fresh: LocalEngine,
  stale: LocalEngine,
  t: SnapshotTransport & LogTransport,
  old: DeviceLog,
  d: { clock: () => number; encode: (e: Entry) => Uint8Array },
): Promise<{ log: DeviceLog; kept: number; lost: number }> {
  return rebuildFrom(fresh, await readStale(stale), t, old, d);
}
