// The phone's side of the cutover (docs/privacy.md section 8 step 6; the server's side is seal/cutover.ts). The
// phone holds the budget's new keys and its first entry (made in the app, keys/budget.ts, after a fresh passkey
// prompt and the typed recovery key). It then:
//   1. brings its copy up to date and has no edit waiting;
//   2. asks the server to freeze the budget, and compares the server's hash of every table with its own copy:
//      the copy must be the budget, row for row, before it becomes the budget;
//   3. notes in its copy where filing starts, and seals its first snapshot, standing at the first entry;
//   4. sends the first entry and the snapshot, and asks the server to seal the budget;
//   5. reads the snapshot back from the sealed budget's own routes and opens it.
// If a step before the seal fails, the server's freeze ends by itself and the budget is as it was; the phone's
// copy, which was changed in step 3, is thrown away and downloaded again. If the read-back fails, the budget is
// sealed and the caller takes the way back.
import { startChain, toHex, type BudgetKeys, type Bytes, type Entry } from '@ledgerline/seal';
import type { FreezeAnswer } from '../seal/cutover.js';
import { LOG_SCHEMA_VERSION } from '../seal/log-versions.js';
import { SYNC_FORMAT } from '../sync-tables.js';
import { DeviceLog } from './device-log.js';
import {
  differingTables,
  dumpChunks,
  MOVE_TABLES,
  tableHashes,
  type SnapshotTransport,
} from './device-snapshot.js';
import type { LocalEngine } from './engine.js';
import { LogSession } from './log-session.js';
import { FILED_KEY, FILED_LINK } from './sealed-filing.js';

type Answer = { ok: boolean; why?: string };

/** How the phone reaches the cutover's routes (seal/cutover-routes.ts). */
export interface CutoverTransport {
  freeze(): Promise<FreezeAnswer>;
  begin(s: {
    genesis: Uint8Array;
    header: Uint8Array;
    signature: Uint8Array;
    manifest: Uint8Array;
    chunks: number;
    tables: { name: string; hash: string }[];
  }): Promise<Answer>;
  chunk(id: string, k: number, bytes: Uint8Array): Promise<Answer>;
  seal(): Promise<Answer>;
}

export interface CutoverDeps {
  /** The budget's keys, version 1, and the first entry they signed. */
  keys: BudgetKeys;
  genesis: Entry;
  budgetId: string;
  deviceId: string;
  clock: () => number;
  /** A new id for the first snapshot (a ULID). */
  snapshotId: string;
  encode: (e: Entry) => Uint8Array;
  /** Brings the copy up to date with the server: the synced tables and the rest (the undo record). */
  sync: () => Promise<void>;
  cutover: CutoverTransport;
  /** The sealed budget's snapshot routes, for the read-back after the seal. */
  snapshots: Pick<SnapshotTransport, 'manifest' | 'chunk'>;
}

export type CutoverResult =
  | { ok: true; log: DeviceLog }
  | {
      ok: false;
      /** Why not, in words for the person. */
      why: string;
      /** The tables in which the copy and the server differ, when that is why. */
      tables?: string[];
      /** The budget is sealed all the same: only the read-back failed. The caller takes the way back. */
      sealed?: boolean;
    };

const fromHex = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function cutoverOnDevice(engine: LocalEngine, d: CutoverDeps): Promise<CutoverResult> {
  if (d.keys.version !== 1 || d.genesis.header.number !== 1 || d.genesis.header.budgetId !== d.budgetId)
    return { ok: false, why: 'The first entry is not this budget’s.' };
  await d.sync();
  if ((await engine.queue()).length)
    return { ok: false, why: 'Changes made on this device wait to be sent.' };

  // ---- the budget stands still, and the copy is the budget
  const frozen = await d.cutover.freeze();
  if (!frozen.ok) return { ok: false, why: frozen.why[0] ?? 'The budget can’t be moved now.' };
  const theirs = frozen.tables.map((t) => ({ name: t.name, hash: fromHex(t.hash) }));
  let mine = await tableHashes(engine.db, undefined, MOVE_TABLES);
  let differ = differingTables(mine, theirs);
  if (differ.length) {
    // Something reached the server just before the freeze: read it (reads go on), and compare once more.
    await d.sync();
    mine = await tableHashes(engine.db, undefined, MOVE_TABLES);
    differ = differingTables(mine, theirs);
  }
  if (differ.length || (await engine.queue()).length)
    return { ok: false, why: 'This device’s copy is not the same as the server’s.', tables: differ };

  // ---- from here the copy is changed: on a failure it is thrown away
  const fail = async (why: string): Promise<CutoverResult> => {
    await engine.clear();
    return { ok: false, why };
  };
  try {
    const now = d.clock();
    const log = new DeviceLog(
      d.keys,
      await startChain(d.genesis, { now, schemaVersion: LOG_SCHEMA_VERSION }, d.budgetId),
      d.deviceId,
      d.clock,
    );
    const st = await engine.state();
    // The copy stands at the log's first entry.
    await engine.apply(
      {
        format: st.format ?? SYNC_FORMAT,
        epoch: st.epoch ?? 'log',
        serverTime: now + st.offset,
        through: 1,
        more: false,
        cursor: null,
        rows: [],
      },
      now,
    );
    // Where filing starts: after the server's own last update, at each link's cutover cursor.
    const seed = (key: string, value: string) =>
      engine.db
        .prepare(
          `INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(d.budgetId, key, value, now);
    await engine.db.batch([
      seed(
        FILED_KEY,
        JSON.stringify({ v: 1, run: 0, hash: '0'.repeat(64), time: 0, inbox: 0, seqBase: frozen.seqBase }),
      ),
      ...frozen.links.map((l) => seed(`${FILED_LINK}${l.linkId}`, l.cursorHash)),
    ]);
    const plain = await dumpChunks(engine.db);
    const sealed = await log.sealSnapshot(d.snapshotId, await tableHashes(engine.db), plain);

    // ---- the server takes the first entry and the snapshot, and seals
    const begun = await d.cutover.begin({
      genesis: d.encode(d.genesis),
      header: sealed.header,
      signature: sealed.signature,
      manifest: sealed.manifest,
      chunks: sealed.chunks.length,
      // The copy's hashes from before it was changed for the move: the server compares them with its own.
      tables: mine.map((t) => ({ name: t.name, hash: toHex(t.hash) })),
    });
    if (!begun.ok) return await fail(begun.why ?? 'The server did not take the first entry.');
    for (const [i, c] of sealed.chunks.entries()) {
      const put = await d.cutover.chunk(d.snapshotId, i + 1, c);
      if (!put.ok) return await fail(put.why ?? 'The server did not take the snapshot.');
    }
    const done = await d.cutover.seal();
    if (!done.ok) return await fail(done.why ?? 'The server did not seal the budget.');

    // ---- sealed. The device's place is kept, and the snapshot is read back and opened.
    await engine.note(LogSession.PLACE, log.save());
    try {
      const manifest = await d.snapshots.manifest(d.snapshotId);
      if (!manifest) throw new Error('no manifest');
      const opened = await log.openManifest({ ...sealed, manifest: manifest as Bytes }, 1);
      if (toHex(opened.header.entryHash) !== toHex(d.genesis.hash)) throw new Error('another entry');
      for (const [i, p] of plain.entries()) {
        const stored = await d.snapshots.chunk(d.snapshotId, i + 1);
        if (!stored || !same(await log.openChunk(opened.manifest, i + 1, stored), p))
          throw new Error('a chunk');
      }
    } catch {
      return {
        ok: false,
        why: 'The server did not keep the first snapshot whole. Take the way back.',
        sealed: true,
      };
    }
    return { ok: true, log };
  } catch (x) {
    await engine.clear();
    throw x;
  }
}
