// The device's side of a new budget's start (D-102; the server's side is seal/start.ts). The device holds the
// budget's new keys and its first entry (made in the app, keys/budget.ts, after a passkey prompt and the typed
// recovery key). It then:
//   1. makes the budget's own row in an empty copy, standing at the first entry, with no bank update filed yet;
//   2. seals its first snapshot, and sends the first entry and the snapshot;
//   3. asks the server to seal the budget, and reads the snapshot back.
// If a step before the seal fails, the copy is emptied again and nothing the server stored is in use: the next
// start begins again from the top. Once sealed, the budget is locked whatever comes after: the copy and its place
// in the log are kept, and a read-back that fails (no answer, or not the bytes sent) is tried again; if it still
// fails, the same state is written once more as a new snapshot (`rewriteId`) and read back, so a second device can
// join even if the server lost the first one. If that fails too, the start ends well all the same and says so
// (`snapshotRead: false`): this device opens the budget from its kept place, and writes its next snapshot when one
// is due.
import { startChain, toHex, type BudgetKeys, type Bytes, type Entry } from '@ledgerline/seal';
import { LOG_SCHEMA_VERSION } from '../seal/log-versions.js';
import { DeviceLog } from './device-log.js';
import { dumpChunks, tableHashes, writeSnapshot, type SnapshotTransport } from './device-snapshot.js';
import type { LocalEngine } from './engine.js';
import { LogSession } from './log-session.js';
import { FILED_KEY } from './sealed-filing.js';

type Answer = { ok: boolean; why?: string };

/**
 * How the device reaches the start's routes (seal/start-routes.ts). `begin` answers with the start's id; the chunks
 * and the seal name it, and the server refuses them once another `begin` came after it.
 */
export interface StartTransport {
  begin(s: {
    genesis: Uint8Array;
    header: Uint8Array;
    signature: Uint8Array;
    manifest: Uint8Array;
    chunks: number;
  }): Promise<Answer & { startId?: string }>;
  chunk(startId: string, id: string, k: number, bytes: Uint8Array): Promise<Answer>;
  seal(startId: string): Promise<Answer>;
}

export interface StartDeps {
  /** The budget's keys, version 1, and the first entry they signed. */
  keys: BudgetKeys;
  genesis: Entry;
  budgetId: string;
  deviceId: string;
  clock: () => number;
  /** A new id for the first snapshot (a ULID). */
  snapshotId: string;
  /** A second new id, for the same state written again when the first snapshot does not read back. */
  rewriteId: string;
  /**
   * The budget's time zone (IANA): the device's own, from Intl, when not given. One the device can't use (not a
   * zone Intl knows) falls back to America/Los_Angeles, the server's default before D-102.
   */
  timeZone?: string;
  encode: (e: Entry) => Uint8Array;
  start: StartTransport;
  /** The sealed budget's snapshot routes, for the read-back after the seal and the write again. */
  snapshots: Pick<SnapshotTransport, 'manifest' | 'chunk' | 'begin' | 'put'>;
}

export type StartResult = { ok: true; log: DeviceLog; snapshotRead: boolean } | { ok: false; why: string };

/** How many times the first snapshot is read back after the seal. */
const READ_BACK_TRIES = 3;

/** The zone a new budget gets: the one asked for, else the device's, if Intl knows it; else the old default. */
export function budgetZone(asked?: string): string {
  const zone = asked ?? deviceZone();
  try {
    if (zone) {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    }
  } catch {
    // Not a zone this device knows.
  }
  return 'America/Los_Angeles';
}

function deviceZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function startOnDevice(engine: LocalEngine, d: StartDeps): Promise<StartResult> {
  if (d.keys.version !== 1 || d.genesis.header.number !== 1 || d.genesis.header.budgetId !== d.budgetId)
    return { ok: false, why: 'The first entry is not this budget’s.' };
  const fail = async (why: string): Promise<StartResult> => {
    await engine.clear();
    return { ok: false, why };
  };
  let sealedNow = false;
  try {
    await engine.clear();
    const now = d.clock();
    const log = new DeviceLog(
      d.keys,
      await startChain(d.genesis, { now, schemaVersion: LOG_SCHEMA_VERSION }, d.budgetId),
      d.deviceId,
      d.clock,
    );
    // The copy stands at the log's first entry.
    await engine.applyLogRows([], 1);
    await engine.db.batch([
      // The budget's own row, as the server made it on first use before D-102, in this device's time zone.
      engine.db
        .prepare(
          `INSERT INTO budget (id, name, time_zone, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?3, ?3)`,
        )
        .bind(d.budgetId, budgetZone(d.timeZone), now),
      // No bank update was filed yet.
      engine.db
        .prepare(`INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)`)
        .bind(
          d.budgetId,
          FILED_KEY,
          JSON.stringify({ v: 1, run: 0, hash: '0'.repeat(64), time: 0, inbox: 0, seqBase: 0 }),
          now,
        ),
    ]);
    const plain = await dumpChunks(engine.db);
    const sealed = await log.sealSnapshot(d.snapshotId, await tableHashes(engine.db), plain);

    const begun = await d.start.begin({
      genesis: d.encode(d.genesis),
      header: sealed.header,
      signature: sealed.signature,
      manifest: sealed.manifest,
      chunks: sealed.chunks.length,
    });
    if (!begun.ok) return await fail(begun.why ?? 'The server did not take the first entry.');
    const startId = begun.startId;
    if (!startId) return await fail('The server did not take the first entry.');
    for (const [i, c] of sealed.chunks.entries()) {
      const put = await d.start.chunk(startId, d.snapshotId, i + 1, c);
      if (!put.ok) return await fail(put.why ?? 'The server did not take the snapshot.');
    }
    const done = await d.start.seal(startId);
    if (!done.ok) return await fail(done.why ?? 'The server did not lock the budget.');
    sealedNow = true;

    // ---- sealed. The device's place is kept, and the snapshot is read back.
    await engine.note(LogSession.PLACE, log.save());
    let read = false;
    for (let i = 0; i < READ_BACK_TRIES && !read; i++)
      read = await readBack(log, d, sealed, plain).catch(() => false);
    // The server may have lost it: the same state again, as a new snapshot that is read back as it is written.
    if (!read)
      read = await writeSnapshot(engine, log, d.snapshots as SnapshotTransport, d.rewriteId).then(
        (w) => w.written,
        () => false,
      );
    return { ok: true, log, snapshotRead: read };
  } catch (x) {
    // Before the seal nothing is in use; after it, the copy is the budget's and stays.
    if (!sealedNow) await engine.clear();
    throw x;
  }
}

/** Whether the server holds the first snapshot whole: its manifest and every chunk open to what was sealed. */
async function readBack(
  log: DeviceLog,
  d: StartDeps,
  sealed: { header: Bytes; signature: Bytes },
  plain: Uint8Array[],
): Promise<boolean> {
  const manifest = await d.snapshots.manifest(d.snapshotId);
  if (!manifest) return false;
  const opened = await log.openManifest({ ...sealed, manifest: manifest as Bytes }, 1);
  if (toHex(opened.header.entryHash) !== toHex(d.genesis.hash)) return false;
  for (const [i, p] of plain.entries()) {
    const stored = await d.snapshots.chunk(d.snapshotId, i + 1);
    if (!stored || !same(await log.openChunk(opened.manifest, i + 1, stored), p)) return false;
  }
  return true;
}
