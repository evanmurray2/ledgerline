// A copy made again from the budget's newest trusted snapshot, by itself (docs/privacy.md 5.3): when the entries
// this device needs next are gone from the server (`BelowFloor`: a checked snapshot covers them), or when the copy
// can't be used as it is (`CopyAhead`, `FilingInterrupted`). The new copy is made in an empty database beside the
// old one, as for a device that joins: the snapshot is opened, then the log is read on from there. What this
// device saw before must be on that log: its place, its own last entries, the last entry of each other device
// (`DeviceLog.saw`, `remember`), the last public entry and checkpoint. A log that doesn't pass through them is
// another history (`LogFork`); the old copy is then left as it was, and the new one thrown away.
//
// The waiting edits are kept: each is run again on the new copy (one that no longer passes is counted as lost).
// Filed bank runs that waited are not kept; the device files them again.
import type { Entry } from '@ledgerline/seal';
import { BelowFloor, DeviceLog, LogFork } from './device-log.js';
import { openSnapshot, type SnapshotTransport } from './device-snapshot.js';
import { FilingInterrupted, type LocalEngine } from './engine.js';
import { LogSession, type LogTransport } from './log-session.js';
import { CopyAhead } from './sealed-filing.js';

/** The causes that make a copy again from a snapshot; anything else (a fork included) is not one. */
export function needsRebuild(x: unknown): boolean {
  return x instanceof BelowFloor || x instanceof CopyAhead || x instanceof FilingInterrupted;
}

/** The most pages of the log read after the snapshot in one rebuild (a page is up to 100 entries). */
const MAX_PAGES = 1000;

/**
 * Makes the copy again in `fresh` (an empty copy) from the newest trusted snapshot, with the waiting edits of
 * `stale` (the copy as it is, at its place `old`), and gives the device's new place in the log, with how many
 * waiting edits are kept and how many no longer passed (`lost`). `stale` is only read.
 */
export async function rebuildCopy(
  fresh: LocalEngine,
  stale: LocalEngine,
  t: SnapshotTransport & LogTransport,
  old: DeviceLog,
  d: { clock: () => number; encode: (e: Entry) => Uint8Array },
): Promise<{ log: DeviceLog; kept: number; lost: number }> {
  const edits = (await stale.queue())
    .filter((e) => !e.bank)
    .map(({ undo: _undo, through: _through, rows: _rows, ...e }) => e);
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
  for (const e of edits) {
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
  // The copy holds the log's bank log and nothing of its own.
  await fresh.note(LogSession.BANK_LOG_SHARED, '1');
  await fresh.note(LogSession.PLACE, log.save());
  return { log, kept: (await fresh.queue()).length, lost };
}
