// The device's side of a new budget's start (D-102; the server's side is seal/start.ts). The device holds the
// budget's new keys and its first entry (made in the app, keys/budget.ts, after a passkey prompt and the typed
// recovery key). It then:
//   1. makes the budget's own row in an empty copy, standing at the first entry, with no bank update filed yet;
//   2. seals its first snapshot, and sends the first entry and the snapshot;
//   3. asks the server to seal the budget, and reads the snapshot back.
// If a step before the seal fails, the copy is emptied again and nothing the server stored is in use: the next
// start begins again from the top.
import { startChain, toHex, type BudgetKeys, type Bytes, type Entry } from '@ledgerline/seal';
import { LOG_SCHEMA_VERSION } from '../seal/log-versions.js';
import { SYNC_FORMAT } from '../sync-tables.js';
import { DeviceLog } from './device-log.js';
import { dumpChunks, tableHashes, type SnapshotTransport } from './device-snapshot.js';
import type { LocalEngine } from './engine.js';
import { LogSession } from './log-session.js';
import { FILED_KEY } from './sealed-filing.js';

type Answer = { ok: boolean; why?: string };

/** How the device reaches the start's routes (seal/start-routes.ts). */
export interface StartTransport {
  begin(s: {
    genesis: Uint8Array;
    header: Uint8Array;
    signature: Uint8Array;
    manifest: Uint8Array;
    chunks: number;
  }): Promise<Answer>;
  chunk(id: string, k: number, bytes: Uint8Array): Promise<Answer>;
  seal(): Promise<Answer>;
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
  encode: (e: Entry) => Uint8Array;
  start: StartTransport;
  /** The sealed budget's snapshot routes, for the read-back after the seal. */
  snapshots: Pick<SnapshotTransport, 'manifest' | 'chunk'>;
}

export type StartResult = { ok: true; log: DeviceLog } | { ok: false; why: string };

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function startOnDevice(engine: LocalEngine, d: StartDeps): Promise<StartResult> {
  if (d.keys.version !== 1 || d.genesis.header.number !== 1 || d.genesis.header.budgetId !== d.budgetId)
    return { ok: false, why: 'The first entry is not this budget’s.' };
  const fail = async (why: string): Promise<StartResult> => {
    await engine.clear();
    return { ok: false, why };
  };
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
    await engine.apply(
      { format: SYNC_FORMAT, epoch: 'log', serverTime: now, through: 1, more: false, cursor: null, rows: [] },
      now,
    );
    await engine.db.batch([
      // The budget's own row, as the server made it on first use before D-102.
      engine.db
        .prepare(`INSERT INTO budget (id, name, created_at, updated_at) VALUES (?1, 'My budget', ?2, ?2)`)
        .bind(d.budgetId, now),
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
    for (const [i, c] of sealed.chunks.entries()) {
      const put = await d.start.chunk(d.snapshotId, i + 1, c);
      if (!put.ok) return await fail(put.why ?? 'The server did not take the snapshot.');
    }
    const done = await d.start.seal();
    if (!done.ok) return await fail(done.why ?? 'The server did not lock the budget.');

    // ---- sealed. The device's place is kept, and the snapshot is read back.
    await engine.note(LogSession.PLACE, log.save());
    const manifest = await d.snapshots.manifest(d.snapshotId);
    if (!manifest) return { ok: false, why: 'The server did not keep the first snapshot.' };
    const opened = await log.openManifest({ ...sealed, manifest: manifest as Bytes }, 1);
    if (toHex(opened.header.entryHash) !== toHex(d.genesis.hash))
      return { ok: false, why: 'The server did not keep the first snapshot.' };
    for (const [i, p] of plain.entries()) {
      const stored = await d.snapshots.chunk(d.snapshotId, i + 1);
      if (!stored || !same(await log.openChunk(opened.manifest, i + 1, stored), p))
        return { ok: false, why: 'The server did not keep the first snapshot.' };
    }
    return { ok: true, log };
  } catch (x) {
    await engine.clear();
    throw x;
  }
}
