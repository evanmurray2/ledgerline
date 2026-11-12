// A device files the bank runs of a sealed budget (docs/privacy.md 5.4 and 5.5; docs/privacy-keys.md 9.3). The
// server hands over runs it can't read: sealed pages under a manifest the Worker signed. The device checks each
// run (`openRun`: the signature, the chain of runs, the inbox key, the link's cursor, every page), turns it into
// the package `fileRun` files, and notes in its copy where filing stands, so that the next device to file
// checks the next run against the same state.
//
// Where filing stands is kept in the copy's `setting` table (it travels to other devices in the bank entry's
// rows, like everything else filing writes):
//   `filed`                 JSON { v: 1, run, hash, time, inbox, seqBase }: the last run filed, the hash and time
//                           of its manifest, its inbox version, and the place among the budget's updates
//                           (`sync_run.fetch_seq`, D-86 A2) of the last update the server itself filed
//   `filed_link:<link id>`  the hash of that link's cursor after its last filed run (hex)
// The cutover writes both for a budget that already exists (section 8 step 6).
import type { BankDataProvider, ProviderAccount, ProviderLiability } from '@ledgerline/bank-provider';
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
import type { Env } from '../env.js';
import { fileRun, type RunPackage } from './file-run.js';
import { alignCounter } from './shadow.js';

export const FILED_KEY = 'filed';
export const FILED_LINK = 'filed_link:';

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
  provider: BankDataProvider,
): Promise<void> {
  const db = env.DB;
  const m = filed.manifest;
  const before = await filedOf(db, budgetId);
  if (m.run !== before.run + 1) throw new UnsupportedRun('not the next run');
  // A link's first run describes a new link (its accounts): the app can't add a bank to a sealed budget yet.
  if (filed.pages.some((p) => p.what === 3)) throw new UnsupportedRun('a new bank link');
  const conn = await db
    .prepare(`SELECT id FROM connection WHERE id IN (?1, ?2) AND removed_at IS NULL`)
    .bind(`con_${m.linkId}`, m.linkId)
    .first<{ id: string }>();
  if (!conn) throw new UnsupportedRun('a bank link this copy does not know');

  const runId = `sealed:${m.run}`;
  const pages: RunPackage['pages'] = [];
  let accounts: ProviderAccount[] | null = null;
  let liabilities: ProviderLiability[] = [];
  for (const [i, p] of filed.pages.entries()) {
    if (p.what === 0) {
      const body = text(p.payload);
      const read = provider.parsePage(body);
      pages.push({
        // Named from the run and the page, never at random: every device names it the same.
        key: `raw/${budgetId}/${conn.id}/${runId}/${m.restart}-${String(i).padStart(4, '0')}-sealed`,
        body,
        nextCursor: read.nextCursor,
        hasMore: read.hasMore,
        sha256: 'none',
      });
    } else if (p.what === 1) accounts = JSON.parse(text(p.payload)) as ProviderAccount[];
    else if (p.what === 2) liabilities = JSON.parse(text(p.payload)) as ProviderLiability[];
  }
  await alignCounter(db, budgetId);
  await fileRun(
    env,
    budgetId,
    {
      runId,
      connectionId: conn.id,
      fetchedAt: m.runTime,
      fetchSeq: before.seqBase + m.run,
      bank: accounts ? { accounts, liabilities } : null,
      pages,
    },
    provider,
  );
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
