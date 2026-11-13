// Bank runs of a sealed budget (docs/privacy.md 5.5; docs/privacy-keys.md 9; store migration 0006). The fetch
// step seals each page to the budget's inbox key the moment it arrives, and signs the run when it is whole. The
// server keeps no readable page, in the database or between steps: a page is fetched and sealed in one step.
//
// Everything the Worker reads back from the database to decide where bank data goes, or what it signs, is under
// one of its stamps, since someone may have written to the database: the inbox key (`keyMac`), the bank link
// (`linkMac`), the budget's whole run state (`runsMac`), and the run being fetched (the stage's own stamp, which
// also covers a running hash of its pages). A bad stamp stops the fetch (`BadStamp`); it never seals to an
// unstamped key or signs what it did not fetch. The one thing with no stamp is the log's state, which says which
// inbox version is in force: a changed one can only point at an older stamped key, never older than the last
// signed run's, and a device refuses such a run (9.3 check 3).
//
// The run being fetched and its stamp are in run-stage.ts, the job's steps in run-steps.ts; this file keeps the
// Worker's keys, the stamps on keys, the run state and what a device reads. Each exported step is one job step, safe
// to run again.
import type { Db, Stmt } from '@ledgerline/db/sql';
import { tokenKeyBytes, type TokenKeyring } from '@ledgerline/platform';
import {
  checkKeyMac,
  checkRunsMac,
  cursorHash,
  fromHex,
  KEY_KIND,
  keyMac,
  readRunManifest,
  runsMac,
  serverKeys,
  sha256,
  toHex,
  type ChainState,
  type RunState,
  type ServerKeys,
} from '@ledgerline/seal';
import { conditionFence } from '../sync/lease.js';
import { publicOf, type LogPublic } from './log-store.js';

/** A value the Worker must have stamped has no good stamp: the database was changed from outside, or lost a row. */
export class BadStamp extends Error {
  constructor(readonly what: 'inbox key' | 'link' | 'run state' | 'run stage') {
    super(`bad stamp: ${what}`);
  }
}

/** The run can't go on as it is (another step moved it, or the bank restarted it too often). */
export class RunStopped extends Error {}

/** The Worker's keys by key number, from the keyring that encrypts bank tokens (9.1). */
export interface WorkerKeys {
  current: number;
  /** Rejects for a key number the keyring doesn't hold. */
  keysFor(n: number): Promise<ServerKeys>;
}

export function workerKeys(ring: TokenKeyring): WorkerKeys {
  const made = new Map<number, Promise<ServerKeys>>();
  return {
    current: ring.current,
    keysFor(n) {
      let k = made.get(n);
      if (!k) {
        const secret = ring.keys[n];
        if (secret === undefined) return Promise.reject(new Error(`no Worker key ${n}`));
        k = tokenKeyBytes(secret).then(async (raw) => {
          try {
            return await serverKeys(raw, n);
          } finally {
            raw.fill(0);
          }
        });
        made.set(n, k);
      }
      return k;
    },
  };
}

export interface RunDeps {
  db: Db;
  budgetId: string;
  /** Opens a link's bank token. */
  ring: TokenKeyring;
  keys: WorkerKeys;
}

/** `keys`: the Worker's keys from this keyring, kept by the caller so a step doesn't derive them again. */
export const runDeps = (
  db: Db,
  budgetId: string,
  ring: TokenKeyring,
  keys: WorkerKeys = workerKeys(ring),
): RunDeps => ({
  db,
  budgetId,
  ring,
  keys,
});

export const ZERO_HASH = '0'.repeat(64);
export const bytesOf = (v: unknown): Uint8Array<ArrayBuffer> =>
  v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(v as ArrayBuffer);
/** Hex from the database: text that is no hex is no bytes, and fails whatever check comes next. */
export const hexOr = (s: unknown): Uint8Array<ArrayBuffer> => {
  try {
    return fromHex(String(s));
  } catch {
    return new Uint8Array(0);
  }
};

// ---- the stamps on keys

/**
 * The stamps for the keys in force after a stored write, when the write changed them: the first entry's signing
 * and inbox keys, and those of a key change. `before` is the chain before the write (null for the first entry).
 * The log store adds these statements to the step that stores the write, so the keys in force always have their
 * stamps. The first entry also starts the budget's run state, at no run. The write passed the log's rules, so
 * its keys replace whatever a row held.
 */
export async function keyStampStmts(
  d: RunDeps,
  before: ChainState | null,
  after: ChainState,
  now: number,
): Promise<Stmt[]> {
  const a = after.public;
  const sign = !before || before.public.keyVersion !== a.keyVersion;
  const inbox = !before || before.public.inboxVersion !== a.inboxVersion;
  // Most writes bring no key: they cost no key derivation.
  if (!sign && !inbox) return [];
  const k = await d.keys.keysFor(d.keys.current);
  const out: Stmt[] = [];
  const stamp = async (kind: 1 | 2, version: number, pub: Uint8Array) => {
    const mac = await keyMac(k, d.budgetId, version, kind, pub);
    out.push(
      d.db
        .prepare(
          `INSERT INTO key_stamp (kind, version, pub, mac, n, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (kind, version) DO UPDATE SET pub = excluded.pub, mac = excluded.mac, n = excluded.n`,
        )
        .bind(kind, version, toHex(pub), toHex(mac), k.n, now),
    );
  };
  if (sign) await stamp(KEY_KIND.sign, a.keyVersion, a.signPub);
  if (inbox) await stamp(KEY_KIND.inbox, a.inboxVersion, a.inboxPub);
  if (!before) {
    const mac = toHex(
      await runsMac(k, d.budgetId, await runStateOf({ run: 0, hash: ZERO_HASH, time: 0 }, [])),
    );
    out.push(
      d.db
        .prepare(
          `INSERT INTO run_state (id, run, last_manifest_hash, last_run_time, mac, n, updated_at)
           VALUES (1, 0, ?1, 0, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET run = 0, last_manifest_hash = excluded.last_manifest_hash,
             last_run_time = 0, mac = excluded.mac, n = excluded.n, updated_at = excluded.updated_at`,
        )
        .bind(ZERO_HASH, mac, k.n, now),
    );
  }
  return out;
}

/**
 * The cutover of a budget that already has bank links (section 8 step 6): each link starts at its cutover
 * cursor, with no run yet. Only for a budget whose runs have not started; the run state gets its stamp anew.
 */
export async function startLinks(d: RunDeps, cursors: Cursors, now: number): Promise<void> {
  const { s } = await standing(d);
  if (s.run !== 0) throw new RunStopped('runs have started');
  const k = await d.keys.keysFor(d.keys.current);
  const mac = toHex(await runsMac(k, d.budgetId, await runStateOf(s, cursors)));
  await d.db.batch([
    conditionFence(
      d.db,
      `SELECT (SELECT run FROM run_state WHERE id = 1) = 0 AND NOT EXISTS (SELECT 1 FROM run_stage)`,
    ),
    d.db.prepare(`DELETE FROM link_cursor`),
    ...cursors.map((c) =>
      d.db
        .prepare(`INSERT INTO link_cursor (link_id, cursor, updated_at) VALUES (?1, ?2, ?3)`)
        .bind(c.linkId, c.cursor, now),
    ),
    d.db.prepare(`UPDATE run_state SET mac = ?1, n = ?2, updated_at = ?3 WHERE id = 1`).bind(mac, k.n, now),
  ]);
}

/** A key the Worker stamped, by kind and version; throws when the row is missing or its stamp is bad. */
export async function stampedKey(d: RunDeps, kind: 1 | 2, version: number): Promise<Uint8Array<ArrayBuffer>> {
  const r = await d.db
    .prepare(`SELECT pub, mac, n FROM key_stamp WHERE kind = ?1 AND version = ?2`)
    .bind(kind, version)
    .first<{ pub: string; mac: string; n: number }>();
  if (!r) throw new BadStamp('inbox key');
  const pub = hexOr(r.pub);
  const k = await d.keys.keysFor(r.n).catch(() => null);
  if (!k || !(await checkKeyMac(k, d.budgetId, version, kind, pub, hexOr(r.mac))))
    throw new BadStamp('inbox key');
  return pub;
}

/**
 * What the log has in force: its last entry's number, the inbox version, and for each replaced version the last
 * run that may be sealed to it. The log's state has no stamp (see the top of this file).
 */
export async function inForce(
  db: Db,
): Promise<{ number: number; inboxVersion: number; retiredAt: Map<number, number> }> {
  const r = await db
    .prepare(`SELECT number, state FROM log_state WHERE id = 1`)
    .first<{ number: number; state: string }>();
  if (!r) throw new BadStamp('inbox key');
  let p: LogPublic | null;
  try {
    p = publicOf(r.state);
  } catch {
    p = null;
  }
  if (p?.inboxVersion === undefined || !p.retiredAt) throw new BadStamp('inbox key');
  return { number: r.number, inboxVersion: p.inboxVersion, retiredAt: p.retiredAt };
}

// ---- the run state

export interface Standing {
  run: number;
  /** Hex. */
  hash: string;
  time: number;
}
export type Cursors = { linkId: string; cursor: string }[];

/** Cursor hashes worked out in this step, by cursor: a step that hashes a cursor twice hashes it once. */
export type CursorHashes = Map<string, Uint8Array<ArrayBuffer>>;

/** H(cursor), from `known` when this step worked it out before. */
export async function cursorHashOf(cursor: string, known?: CursorHashes): Promise<Uint8Array<ArrayBuffer>> {
  let h = known?.get(cursor);
  if (!h) {
    h = await cursorHash(cursor);
    known?.set(cursor, h);
  }
  return h;
}

export async function runStateOf(s: Standing, cursors: Cursors, known?: CursorHashes): Promise<RunState> {
  const links = [];
  for (const c of cursors) links.push({ linkId: c.linkId, cursorHash: await cursorHashOf(c.cursor, known) });
  return { run: s.run, lastManifestHash: hexOr(s.hash), lastRunTime: s.time, links };
}

/**
 * The budget's run state, checked against its stamp, with the inbox version of the last run: its manifest is the
 * one the stamped state names by hash. No run goes back to an older inbox key than the run before.
 */
export async function standing(
  d: RunDeps,
  known?: CursorHashes,
): Promise<{ s: Standing; cursors: Cursors; lastInbox: number }> {
  const r = await d.db
    .prepare(`SELECT run, last_manifest_hash, last_run_time, mac, n FROM run_state WHERE id = 1`)
    .first<{ run: number; last_manifest_hash: string; last_run_time: number; mac: string; n: number }>();
  if (!r) throw new BadStamp('run state');
  const rows = await d.db
    .prepare(`SELECT link_id, cursor FROM link_cursor ORDER BY link_id`)
    .all<{ link_id: string; cursor: string }>();
  const cursors = rows.results.map((x) => ({ linkId: x.link_id, cursor: x.cursor }));
  const s = { run: r.run, hash: r.last_manifest_hash, time: r.last_run_time };
  const k = await d.keys.keysFor(r.n).catch(() => null);
  if (!k || !(await checkRunsMac(k, d.budgetId, await runStateOf(s, cursors, known), hexOr(r.mac))))
    throw new BadStamp('run state');
  if (s.run === 0) return { s, cursors, lastInbox: 0 };
  const last = await d.db
    .prepare(`SELECT manifest FROM sealed_run WHERE run = ?1`)
    .bind(s.run)
    .first<{ manifest: unknown }>();
  if (!last) throw new BadStamp('run state');
  const manifest = bytesOf(last.manifest);
  if (toHex(await sha256(manifest)) !== s.hash) throw new BadStamp('run state');
  return { s, cursors, lastInbox: readRunManifest(manifest).inboxVersion };
}

// ---- what the log store and a device read

/** The highest run that is complete (0: none). The server's own count for its write rules, so it needs no stamp. */
export async function lastCompleteRun(db: Db): Promise<number> {
  return (await db.prepare(`SELECT run FROM run_state WHERE id = 1`).first<{ run: number }>())?.run ?? 0;
}

/** H(receipt) of runs `from` to `to`, in order; null when one is missing. */
export async function receiptHashes(db: Db, from: number, to: number): Promise<Uint8Array[] | null> {
  if (!(from >= 1) || to < from || to - from >= 256) return null;
  const rows = await db
    .prepare(`SELECT run, receipt_hash FROM sealed_run WHERE run >= ?1 AND run <= ?2 ORDER BY run`)
    .bind(from, to)
    .all<{ run: number; receipt_hash: string }>();
  if (rows.results.length !== to - from + 1) return null;
  const out = rows.results.map((r) => hexOr(r.receipt_hash));
  return out.every((h) => h.length === 32) ? out : null;
}

/** Complete runs after `after`, in order: each manifest with its signature and its number of pages. */
export async function runsAfter(
  db: Db,
  after: number,
  limit: number,
): Promise<{ run: number; manifest: Uint8Array; signature: Uint8Array; pages: number }[]> {
  const rows = await db
    .prepare(`SELECT run, manifest, signature, pages FROM sealed_run WHERE run > ?1 ORDER BY run LIMIT ?2`)
    .bind(after, limit)
    .all<{ run: number; manifest: unknown; signature: unknown; pages: number }>();
  return rows.results.map((r) => ({
    run: r.run,
    manifest: bytesOf(r.manifest),
    signature: bytesOf(r.signature),
    pages: r.pages,
  }));
}

/** One sealed page of a complete run; null when there is none (a run still being fetched has none to give). */
export async function sealedPageOf(db: Db, run: number, page: number): Promise<Uint8Array | null> {
  const r = await db
    .prepare(
      `SELECT p.bytes FROM sealed_page p JOIN sealed_run r ON r.run = p.run WHERE p.run = ?1 AND p.page = ?2`,
    )
    .bind(run, page)
    .first<{ bytes: unknown }>();
  return r ? bytesOf(r.bytes) : null;
}
