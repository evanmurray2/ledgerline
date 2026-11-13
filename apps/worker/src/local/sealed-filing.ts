// A device files the bank runs of a sealed budget (docs/privacy.md 5.4 and 5.5; docs/privacy-keys.md 9.3). The
// server hands over runs it can't read: sealed pages under a manifest the Worker signed. The device checks each
// run (`openRun`: the signature, the chain of runs, the inbox key, the link's cursor, every page), turns it into
// the package `fileRun` files, and notes in its copy where filing stands, so that the next device to file
// checks the next run against the same state. A link's first run describes it (its bank and accounts): the device
// writes the link's connection and accounts from it.
//
// Where filing stands is kept in the copy's `setting` table (it travels to other devices in the bank entry's
// rows, like everything else filing writes):
//   `filed`                 JSON { v: 1, run, hash, time, inbox, seqBase }: the last run filed, the hash and time
//                           of its manifest, its inbox version, and the place among the budget's updates
//                           (`sync_run.fetch_seq`, D-86 A2) of the last update the server itself filed
//   `filed_link:<link id>`  the hash of that link's cursor after its last filed run (hex)
// The cutover writes both for a budget that already exists (section 8 step 6).
import type { ProviderAccount, ProviderLiability } from '@ledgerline/bank-provider';
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  afterRun,
  fromHex,
  openRun,
  toHex,
  type FiledRun,
  type FilingState,
  type SealedRun,
} from '@ledgerline/seal';
import { seededUlid } from '@ledgerline/platform';
import { Scoped } from '../db/scoped.js';
import type { Env } from '../env.js';
import { connectionStmts, linkedAccountStmts } from '../routes/settings/link-rows.js';
import { readLinkDescription } from '../seal/link-description.js';
import { fileRun, type PageReader, type RunPackage } from './file-run.js';

/**
 * Filing numbers each new bank event from the counter and processes the events past the budget's watermark. The
 * counter continues from the watermark, as on a server that has filed everything so far.
 */
async function alignCounter(db: Db, budgetId: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO apply_counter (id, seq) VALUES (1, 0)`),
    db
      .prepare(
        `UPDATE apply_counter SET seq = max(seq, coalesce((SELECT processed_through FROM budget WHERE id = ?1), 0)) WHERE id = 1`,
      )
      .bind(budgetId),
  ]);
}

export const FILED_KEY = 'filed';
export const FILED_LINK = 'filed_link:';

/**
 * The copy says more runs are filed than the log does, and holds no waiting entry for them: it has filed rows
 * that are in neither the queue nor the log. It can't be used as it is; it is made again from the log.
 */
export class CopyAhead extends Error {
  constructor() {
    super('this copy holds filed bank runs that are not in the log');
  }
}

/** A run this version of the app can't file. Nothing is skipped: the runs wait until a release files them. */
export class UnsupportedRun extends Error {}

interface Filed {
  v: 1;
  run: number;
  hash: string;
  time: number;
  inbox: number;
  seqBase: number;
}

const ZERO = '0'.repeat(64);

/** Where filing stands in this copy. A copy with no note has filed nothing. */
export async function filedOf(db: Db, budgetId: string): Promise<Filed> {
  const r = await db
    .prepare(`SELECT value FROM setting WHERE budget_id = ?1 AND key = ?2`)
    .bind(budgetId, FILED_KEY)
    .first<{ value: string }>();
  if (!r) return { v: 1, run: 0, hash: ZERO, time: 0, inbox: 0, seqBase: 0 };
  const f = JSON.parse(r.value) as Filed;
  if (f.v !== 1 || !Number.isSafeInteger(f.run) || !/^[0-9a-f]{64}$/.test(f.hash))
    throw new UnsupportedRun('filing state');
  return f;
}

/** What `openRun` checks the next run against: the copy's filing state, and the keys the log names. */
export async function filingState(
  db: Db,
  budgetId: string,
  o: Pick<FilingState, 'workerKeys' | 'inboxVersion' | 'retiredAt' | 'inbox' | 'now'>,
): Promise<FilingState> {
  const f = await filedOf(db, budgetId);
  const links = await db
    .prepare(`SELECT key, value FROM setting WHERE budget_id = ?1 AND key >= ?2 AND key < ?3`)
    .bind(budgetId, FILED_LINK, `${FILED_LINK}￿`)
    .all<{ key: string; value: string }>();
  return {
    budgetId,
    filedThrough: f.run,
    lastManifestHash: fromHex(f.hash),
    lastRunTime: f.time,
    lastInboxVersion: f.inbox,
    cursors: new Map(links.results.map((l) => [l.key.slice(FILED_LINK.length), fromHex(l.value)])),
    ...o,
  };
}

const put = (db: Db, budgetId: string, key: string, value: string, at: number): Stmt =>
  db
    .prepare(
      `INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(budgetId, key, value, at);

const text = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);

/**
 * Files one opened run on the copy and notes it as filed. `env.DB` is the copy. Everything carries the run's
 * time, and ids come from content, so every device that files this run writes the same rows.
 */
export async function fileOpened(
  env: Env,
  budgetId: string,
  filed: FiledRun,
  /** Reads a page (`parsePage`): the bank's format, no network. */
  provider: PageReader,
): Promise<void> {
  const db = env.DB;
  const m = filed.manifest;
  const before = await filedOf(db, budgetId);
  if (m.run !== before.run + 1) throw new UnsupportedRun('not the next run');
  const runId = `sealed:${m.run}`;
  // A link's first run describes a new link: its bank and its accounts, which the copy doesn't hold yet.
  const description = filed.pages.some((p) => p.what === 3);
  const conn = await db
    .prepare(`SELECT id FROM connection WHERE id IN (?1, ?2) AND removed_at IS NULL`)
    .bind(`con_${m.linkId}`, m.linkId)
    .first<{ id: string }>();
  if (description && conn) throw new UnsupportedRun('a new bank link this copy already has');
  if (!description && !conn) throw new UnsupportedRun('a bank link this copy does not know');
  // What an earlier filing of this run, or of a later one, left outside the rows an undo covers (the bank log,
  // the run's own rows, the link's lock) goes first: a run filed again is filed whole, as if for the first time.
  await resetFiling(db, budgetId, before.run);
  if (description) await fileDescription(db, budgetId, filed);
  else await fileUpdate(env, budgetId, filed, conn!.id, runId, before, provider);
  // Every record the Worker counted when it sealed the run is in the bank log now: a run is never noted as filed
  // with less.
  const logged = await db
    .prepare(`SELECT count(*) AS n FROM bank_event WHERE sync_run_id = ?1`)
    .bind(runId)
    .first<{ n: number }>();
  if ((logged?.n ?? 0) !== m.added + m.modified + m.removed) throw new Error('the run was not filed whole');
  const after: Filed = {
    v: 1,
    run: m.run,
    hash: toHex(filed.manifestHash),
    time: m.runTime,
    inbox: m.inboxVersion,
    seqBase: before.seqBase,
  };
  await db.batch([
    put(db, budgetId, FILED_KEY, JSON.stringify(after), m.runTime),
    put(db, budgetId, `${FILED_LINK}${m.linkId}`, toHex(m.cursorAfter), m.runTime),
  ]);
}

/** Files a run of transactions (and the bank's answers) for a link the copy holds, with the server's own steps. */
async function fileUpdate(
  env: Env,
  budgetId: string,
  filed: FiledRun,
  connectionId: string,
  runId: string,
  before: Filed,
  provider: PageReader,
): Promise<void> {
  const db = env.DB;
  const m = filed.manifest;
  const pages: RunPackage['pages'] = [];
  let accounts: ProviderAccount[] | null = null;
  let liabilities: ProviderLiability[] = [];
  for (const [i, p] of filed.pages.entries()) {
    if (p.what === 0) {
      const body = text(p.payload);
      const read = provider.parsePage(body);
      pages.push({
        // Named from the run and the page, never at random: every device names it the same.
        key: `raw/${budgetId}/${connectionId}/${runId}/${m.restart}-${String(i).padStart(4, '0')}-sealed`,
        body,
        nextCursor: read.nextCursor,
        hasMore: read.hasMore,
        sha256: 'none',
      });
    } else if (p.what === 1) accounts = list<ProviderAccount>(p.payload);
    else if (p.what === 2) liabilities = list<ProviderLiability>(p.payload);
  }
  await alignCounter(db, budgetId);
  await fileRun(
    env,
    budgetId,
    {
      runId,
      connectionId,
      fetchedAt: m.runTime,
      fetchSeq: before.seqBase + m.run,
      bank: accounts ? { accounts, liabilities } : null,
      pages,
    },
    provider,
  );
}

/**
 * Files a link's first run: the link's connection, its bank accounts and their setup (budget accounts, card payment
 * categories, starting balances at the bank's balance), written as the server's own exchange wrote them before the
 * budget was sealed (routes/settings/link-rows.ts), at the time the link was made. The person confirms or corrects
 * the starting balances afterwards, as before. Ids come from the link, so every device that files the run writes
 * the same rows.
 */
async function fileDescription(db: Db, budgetId: string, filed: FiledRun): Promise<void> {
  const m = filed.manifest;
  const page = filed.pages[0];
  if (filed.pages.length !== 1 || page?.what !== 3) throw new UnsupportedRun('a link description');
  const d = readLinkDescription(text(page.payload));
  if (!d || d.linkId !== m.linkId) throw new UnsupportedRun('a link description');
  const s = new Scoped(db, budgetId, 'bank');
  const connectionId = `con_${m.linkId}`;
  let n = 0;
  const id = () => seededUlid(d.linkedAt, `link:${m.linkId}`, n++);
  const accounts = await linkedAccountStmts(s, connectionId, d.accounts, d.linkedAt, id);
  await db.batch([
    ...connectionStmts(s, {
      id: connectionId,
      // As the server's exchange named a bank Plaid couldn't name.
      institution: d.institution ?? 'Bank',
      itemId: null,
      tokenEnc: null,
      keyVersion: null,
      linkedAt: d.linkedAt,
    }),
    ...accounts.stmts,
  ]);
}

/** A balances or card statements page: a list of objects. */
function list<T>(payload: Uint8Array): T[] {
  let v: unknown;
  try {
    v = JSON.parse(text(payload));
  } catch {
    throw new UnsupportedRun('a page that does not read');
  }
  if (!Array.isArray(v) || !v.every((x) => x && typeof x === 'object' && !Array.isArray(x)))
    throw new UnsupportedRun('a page that does not read');
  return v as T[];
}

/**
 * Takes out of the copy what filing a sealed run past `filed` left in tables no undo covers. The copy says runs
 * up to `filed` are filed; anything of a later sealed run is left from a filing that was taken back out (its
 * entry lost to another device's, or was refused) or that failed part-way.
 */
export async function resetFiling(db: Db, budgetId: string, filed: number): Promise<void> {
  const later = `sync_run_id LIKE 'sealed:%' AND CAST(substr(sync_run_id, 8) AS INTEGER) > ?1`;
  await db.batch([
    db.prepare(`DELETE FROM bank_event WHERE ${later}`).bind(filed),
    db.prepare(`DELETE FROM bank_page WHERE ${later}`).bind(filed),
    db.prepare(`DELETE FROM sync_page WHERE ${later}`).bind(filed),
    db
      .prepare(`DELETE FROM sync_run WHERE id LIKE 'sealed:%' AND CAST(substr(id, 8) AS INTEGER) > ?1`)
      .bind(filed),
    db.prepare(`UPDATE connection SET sync_lock = NULL, lock_expires = NULL WHERE sync_lock LIKE 'sealed:%'`),
    // New bank events are numbered from the budget's watermark again, as on a copy that never filed them.
    db.prepare(`INSERT OR IGNORE INTO apply_counter (id, seq) VALUES (1, 0)`),
    db
      .prepare(
        `UPDATE apply_counter SET seq = coalesce((SELECT processed_through FROM budget WHERE id = ?1), 0) WHERE id = 1`,
      )
      .bind(budgetId),
  ]);
}

/** Opens runs in order against the copy's filing state; gives each opened run. Throws `RunError` (packages/seal). */
export async function openRuns(state: FilingState, runs: readonly SealedRun[]): Promise<FiledRun[]> {
  const out: FiledRun[] = [];
  let s = state;
  for (const r of runs) {
    const filed = await openRun(s, r);
    out.push(filed);
    s = afterRun(s, filed);
  }
  return out;
}
