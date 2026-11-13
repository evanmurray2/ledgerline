// The run being fetched, under its own stamp (docs/privacy-keys.md 9), and the bank link as the fetch may use it.
// Split from runs.ts; the steps that move a run are in run-steps.ts.
import type { Stmt } from '@ledgerline/db/sql';
import { decryptToken } from '@ledgerline/platform';
import {
  checkLinkMac,
  concat,
  fromHex,
  hmac,
  hmacVerify,
  isUlid,
  label,
  str,
  toHex,
  u16,
  u32,
  u64,
  u8,
} from '@ledgerline/seal';
import { conditionFence, isFenceAbort } from '../sync/lease.js';
import { BadStamp, hexOr, RunStopped, unb64, type RunDeps } from './runs.js';

export interface Stage {
  linkId: string;
  run: number;
  restart: number;
  /** Restarts the bank asked for; these have a limit. */
  bankRestarts: number;
  inboxVersion: number;
  n: number;
  startCursor: string;
  cursor: string;
  hasMore: boolean;
  /** The link's first run: it holds the link's description and no transactions (9.3 check 4). */
  describes: boolean;
  pages: number;
  added: number;
  modified: number;
  removed: number;
  /** Hex: zeros, then H(pagesHash || what || H(sealed page)) for each page stored. */
  pagesHash: string;
  startedAt: number;
}

interface StageRow {
  link_id: string;
  run: number;
  restart: number;
  bank_restarts: number;
  inbox_version: number;
  n: number;
  start_cursor: string;
  cursor: string;
  has_more: number;
  describes: number;
  pages: number;
  added: number;
  modified: number;
  removed: number;
  pages_hash: string;
  started_at: number;
  mac: string;
}

const STAGE_LABEL = 'ledgerline/v1/mac/stage';

export function stageInput(budgetId: string, st: Stage): Uint8Array<ArrayBuffer> {
  return concat(
    label(STAGE_LABEL),
    str(budgetId),
    str(st.linkId),
    u64(st.run),
    u32(st.restart),
    u32(st.bankRestarts),
    u32(st.inboxVersion),
    u32(st.n),
    str(st.startCursor),
    str(st.cursor),
    u8(st.hasMore ? 1 : 0),
    u8(st.describes ? 1 : 0),
    u16(st.pages),
    u32(st.added),
    u32(st.modified),
    u32(st.removed),
    fromHex(st.pagesHash),
    u64(st.startedAt),
  );
}

/** The statement that writes the stage, whole, with its stamp. */
export async function stageStmt(d: RunDeps, st: Stage): Promise<Stmt> {
  const k = await d.keys.keysFor(st.n);
  const mac = toHex(await hmac(k.mac, stageInput(d.budgetId, st)));
  return d.db
    .prepare(
      `INSERT OR REPLACE INTO run_stage (id, link_id, run, restart, bank_restarts, inbox_version, n, start_cursor, cursor,
         has_more, describes, pages, added, modified, removed, pages_hash, started_at, mac)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    )
    .bind(
      st.linkId,
      st.run,
      st.restart,
      st.bankRestarts,
      st.inboxVersion,
      st.n,
      st.startCursor,
      st.cursor,
      st.hasMore ? 1 : 0,
      st.describes ? 1 : 0,
      st.pages,
      st.added,
      st.modified,
      st.removed,
      st.pagesHash,
      st.startedAt,
      mac,
    );
}

/** The stage as it is stored, with whether its stamp is good. Null: no run is being fetched. */
export async function readStage(d: RunDeps): Promise<{ st: Stage; mac: string; good: boolean } | null> {
  const r = await d.db.prepare(`SELECT * FROM run_stage WHERE id = 1`).first<StageRow>();
  if (!r) return null;
  const st: Stage = {
    linkId: r.link_id,
    run: r.run,
    restart: r.restart,
    bankRestarts: r.bank_restarts,
    inboxVersion: r.inbox_version,
    n: r.n,
    startCursor: r.start_cursor,
    cursor: r.cursor,
    hasMore: r.has_more === 1,
    describes: r.describes === 1,
    pages: r.pages,
    added: r.added,
    modified: r.modified,
    removed: r.removed,
    pagesHash: r.pages_hash,
    startedAt: r.started_at,
  };
  let good = false;
  try {
    const k = await d.keys.keysFor(st.n);
    good = await hmacVerify(k.mac, stageInput(d.budgetId, st), hexOr(r.mac));
  } catch {
    // A row whose values can't be stamped, or whose key the Worker doesn't hold, has no good stamp.
    good = false;
  }
  return { st, mac: String(r.mac), good };
}

/** The run being fetched, as the Worker left it; null when there is none. For the job and the tests. */
export async function stageOf(d: RunDeps): Promise<Stage | null> {
  const s = await readStage(d);
  if (s && !s.good) throw new BadStamp('run stage');
  return s?.st ?? null;
}

/** The run a job began: its steps act on that run only, never on one that took its place. */
export interface OwnRun {
  linkId: string;
  startedAt: number;
}
export const own = (st: Stage, only: OwnRun | undefined): boolean =>
  !only || (st.linkId === only.linkId && st.startedAt === only.startedAt);

/** The stage a step goes on from: there, with a good stamp, and the one its job began. */
export async function openStage(d: RunDeps, only?: OwnRun): Promise<{ st: Stage; mac: string }> {
  const s = await readStage(d);
  if (!s) throw new RunStopped('no run');
  if (!s.good) throw new BadStamp('run stage');
  if (!own(s.st, only)) throw new RunStopped('another run took its place');
  return s;
}

/** True only while the stage is still the one a step read: any other step, or a new run, changes its stamp. */
export const stageFence = (d: RunDeps, mac: string): Stmt =>
  conditionFence(d.db, `SELECT mac = ?1 FROM run_stage WHERE id = 1`, mac);

export const stopped = (x: unknown): never => {
  if (!isFenceAbort(x)) throw x;
  throw new RunStopped('another step moved the run');
};

/** The bank link as the fetch may use it: its stamp is good. */
export async function stampedLink(
  d: RunDeps,
  linkId: string,
): Promise<{ connectionId: string; itemId: string; tokenEnc: string; keyVersion: number }> {
  const l = await d.db
    .prepare(
      `SELECT connection_id, budget_id, provider_item_id, access_token_enc, key_version, mac FROM bank_link WHERE id = ?1`,
    )
    .bind(linkId)
    .first<{
      connection_id: string;
      budget_id: string;
      provider_item_id: string | null;
      access_token_enc: string | null;
      key_version: number | null;
      mac: string | null;
    }>();
  if (!l || !l.mac || !l.provider_item_id || !l.access_token_enc || l.key_version === null)
    throw new BadStamp('link');
  if (l.budget_id !== d.budgetId || !isUlid(linkId)) throw new BadStamp('link');
  let ok = false;
  try {
    const k = await d.keys.keysFor(l.key_version);
    ok = await checkLinkMac(
      k,
      d.budgetId,
      linkId,
      l.provider_item_id,
      unb64(l.access_token_enc),
      unb64(l.mac),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new BadStamp('link');
  return {
    connectionId: l.connection_id,
    itemId: l.provider_item_id,
    tokenEnc: l.access_token_enc,
    keyVersion: l.key_version,
  };
}

/** What a bank call for a link needs: the link checked against its stamp, and its token opened. */
export async function linkForBank(
  d: RunDeps,
  linkId: string,
): Promise<{ id: string; accessToken: string; providerItemId: string }> {
  const l = await stampedLink(d, linkId);
  return {
    id: l.connectionId,
    accessToken: await decryptToken(d.ring, l.tokenEnc, l.keyVersion, l.connectionId),
    providerItemId: l.itemId,
  };
}
