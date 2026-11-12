// The shadow run on this device (docs/privacy.md phase 4; apps/worker/src/local/shadow.ts). When a sync says the
// server has filed bank updates this device hasn't seen, the device makes a scratch copy of the budget just
// before the server's rows arrive, and afterwards, in the background, takes those updates from the inbox, files
// them itself on the scratch copy, compares it with the real copy, and tells the server what it found: table and
// column names and counts, never a row's content. The real copy is never touched by it, nothing here waits on the
// network before a sync is applied, and a failure here never stops a sync.
import type { EngineHost, InboxRun, ShadowReport, SyncPage } from './host';

/** The last update of the inbox this device has looked at (kept with the copy), or a word when it can't tell. */
const SEQ = 'shadow_seq';
/** The server was filing when this device last synced: the copy may hold part of an update. */
const FILING = 'filing';
/** The most updates one shadow run files. More than this waited (a night with many banks): they are skipped. */
export const MAX_RUNS = 4;

type Get = (path: string) => Promise<{ run: InboxRun | null; latest: number }>;
type Post = (path: string, body: unknown) => Promise<unknown>;

/** A shadow run that has its scratch copy and waits for the sync to finish. */
export interface Started {
  token: number;
  /** The updates after `from`, up to `to`, are the ones to file. */
  from: number;
  to: number;
}

/**
 * Before a sync page is written into the copy. Starts a shadow run (the scratch copy only: no network) when the
 * page is a whole sync by itself and says that newer bank updates were filed since this device last looked.
 */
export async function shadowBefore(
  host: EngineHost,
  page: SyncPage,
  /** This page is the first of its sync. A sync of several pages has rows in the copy before its last page. */
  first: boolean,
  post: Post,
): Promise<Started | null> {
  try {
    if (page.cursor || page.inbox === undefined) return null;
    const saved = await host.get(SEQ);
    const seq = saved === null ? NaN : Number(saved);
    // The server is in the middle of an update: this page, and the copy after it, may hold part of it. The next
    // time the inbox moves, the device only notes where it is.
    if (page.filing) {
      if (saved !== FILING) await host.put(SEQ, FILING);
      return null;
    }
    if (page.more) return null;
    // Whatever happens below, these updates are looked at once.
    if (saved === null || page.inbox !== seq) await host.put(SEQ, String(page.inbox));
    // The first time, after a download, and after a sync that met the server filing: nothing to compare with.
    if (!Number.isSafeInteger(seq) || page.inbox <= seq) return null;
    if (!first || page.inbox - seq > MAX_RUNS) {
      report(post, { runs: 0, compared: false, why: 'incomplete', differences: [] });
      return null;
    }
    const token = await host.shadowFork();
    return token === null ? null : { token, from: seq, to: page.inbox };
  } catch {
    return null;
  }
}

/**
 * After the sync is in the copy, in the background: takes the updates from the inbox, files them on the scratch
 * copy one a step, compares, and reports.
 */
export async function shadowFinish(host: EngineHost, s: Started, get: Get, post: Post): Promise<void> {
  try {
    const runs: InboxRun[] = [];
    for (let after = s.from; after < s.to;) {
      const r = await get(`/api/sync/inbox?after=${after}`);
      if (!r.run) break;
      runs.push(r.run);
      after = r.run.fetchSeq;
    }
    const complete = runs.length > 0 && runs[runs.length - 1]!.fetchSeq === s.to;
    const refused = complete ? await host.shadowBegin(s.token, runs) : null;
    if (complete && !refused) while (await host.shadowStep(s.token));
    // A later sync brought a newer bank update into the copy meanwhile, or met the server filing one: the scratch
    // copy doesn't have it, so the comparison would say nothing.
    const moved = (await host.get(SEQ)) !== String(s.to);
    const found = await host.shadowEnd(s.token);
    if (refused) report(post, refused);
    else if (!complete || moved || !found)
      report(post, { runs: found?.runs ?? 0, compared: false, why: 'incomplete', differences: [] });
    else report(post, found);
  } catch {
    // The scratch copy is freed by the next run; the next bank update gets its own.
  }
}

function report(post: Post, r: ShadowReport): void {
  void post('/api/sync/shadow', { ...r, differences: r.differences.slice(0, 200) }).catch(() => undefined);
}
