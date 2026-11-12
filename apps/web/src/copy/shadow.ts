// The shadow run on this device (docs/privacy.md phase 4; apps/worker/src/local/shadow.ts). When a sync says the
// server has filed bank updates this device hasn't seen, the device takes them from the inbox, files them itself
// on a scratch copy while its real copy takes the server's rows as always, and tells the server what the
// comparison found: table and column names and counts, never a row's content. The real copy is never touched by
// it, and a failure here never stops a sync.
import type { EngineHost, InboxRun, ShadowReport, SyncPage } from './host';

/** The last update of the inbox this device has looked at (kept with the copy). */
const SEQ = 'shadow_seq';
/** The most updates one shadow run files: more than this waited (weeks away), and they are skipped. */
const MAX_RUNS = 8;

type Get = (path: string) => Promise<{ run: InboxRun | null; latest: number }>;
type Post = (path: string, body: unknown) => Promise<unknown>;

/**
 * Before a sync page is written into the copy: starts a shadow run when the page says newer bank updates were
 * filed. Gives the place of the last update it will file (finish with `shadowFinish` once the page is in the
 * copy), or null when no run started.
 */
export async function shadowBefore(
  host: EngineHost,
  page: SyncPage,
  get: Get,
  post: Post,
): Promise<number | null> {
  try {
    // Only a complete page of changes says where the inbox is, and only then is the copy about to be current.
    if (page.cursor || page.more || page.inbox === undefined) return null;
    const saved = await host.get(SEQ);
    const seq = saved === null ? NaN : Number(saved);
    // Whatever happens below, these updates are looked at once.
    if (saved === null || page.inbox !== seq) await host.put(SEQ, String(page.inbox));
    // The first time, and after the inbox started over: nothing to compare with.
    if (!Number.isSafeInteger(seq) || page.inbox <= seq) return null;
    const runs: InboxRun[] = [];
    for (let after = seq; after < page.inbox && runs.length < MAX_RUNS;) {
      const r = await get(`/api/sync/inbox?after=${after}`);
      if (!r.run) break;
      runs.push(r.run);
      after = r.run.fetchSeq;
    }
    if (!runs.length || runs[runs.length - 1]!.fetchSeq !== page.inbox) {
      report(post, { runs: 0, compared: false, why: 'incomplete', differences: [] });
      return null;
    }
    const refused = await host.shadowBegin(runs);
    if (refused) {
      report(post, refused);
      return null;
    }
    return page.inbox;
  } catch {
    return null;
  }
}

/** After the page is in the copy: files the updates on the scratch copy, one a step, compares, and reports. */
export async function shadowFinish(host: EngineHost, upTo: number, post: Post): Promise<void> {
  try {
    while (await host.shadowStep());
    // A later sync brought a newer bank update into the copy meanwhile: the scratch copy doesn't have it, so the
    // comparison would say nothing.
    const moved = Number(await host.get(SEQ)) !== upTo;
    const r = await host.shadowEnd();
    if (r) report(post, moved ? { runs: r.runs, compared: false, why: 'incomplete', differences: [] } : r);
  } catch {
    // The scratch copy is gone with the engine; the next bank update gets its own run.
  }
}

function report(post: Post, r: ShadowReport): void {
  void post('/api/sync/shadow', { ...r, differences: r.differences.slice(0, 200) }).catch(() => undefined);
}
