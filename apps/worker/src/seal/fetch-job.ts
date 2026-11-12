// The fetch job of a sealed budget (docs/privacy.md 5.5): the steps of seal/runs.ts, one per alarm, for one bank
// link. Begin; for a link's first run, its description; else each page of transactions, then the bank's balances
// and card statements; then sign and complete. One link fetches at a time, so a job whose link must wait asks
// again shortly. A bad stamp ends the job and is logged: the database was changed from outside, and the Worker
// seals nothing on its word. Nothing queues this job before the cutover.
import { ProviderError, type BankDataProvider, type ProviderWebhookEvent } from '@ledgerline/bank-provider';
import { isUlid } from '@ledgerline/seal';
import type { Handler, Job, StepResult } from '../store/jobs.js';
import { NEEDS_SIGN_IN, nextUtcMidnight } from '../store/sync-job.js';
import {
  abandonSealedRun,
  BadStamp,
  beginSealedRun,
  completeSealedRun,
  fetchSealedPage,
  linkForBank,
  RunStopped,
  sealBankAnswer,
  sealLinkDescription,
  type RunDeps,
} from './runs.js';

export const SEALED_FETCH = 'sealed_fetch';
export const SEALED_BACKSTOP = 'sealed_backstop';
export const SEALED_BACKSTOP_ID = 'sealed_backstop';
export const sealedFetchId = (linkId: string): string => `${SEALED_FETCH}:${linkId}`;

const FOUR_HOURS = 4 * 3_600_000;
/** How long a link waits for another link's run, and how often it asks, before it leaves it to the backstop. */
const BUSY_WAIT_MS = 20_000;
const MAX_BUSY = 30;
/** Guards against a bank that never says "no more pages". */
const MAX_PAGES = 1000;
/** How often a job may begin again after another step moved its run. */
const MAX_BEGINS = 5;

export interface FetchState {
  phase: 'begin' | 'describe' | 'fetch' | 'balances' | 'liabilities' | 'complete';
  linkId: string;
  /** The run this job began. */
  run?: number;
  pages?: number;
  busy?: number;
  begins?: number;
  /** This run is the link's first, which describes it: its transactions are fetched right after. */
  first?: boolean;
}

export interface FetchDeps {
  runs: RunDeps;
  provider: () => BankDataProvider;
  pageSize: number;
  /** 'pause' when the account is past 70% of a daily limit (sync/breaker.ts). */
  budgetState: () => Promise<'normal' | 'pause'>;
}

type Enqueue = (
  kind: string,
  o: { id?: string; connectionId?: string | null; state?: unknown; runAt: number; recurring?: boolean },
) => Promise<string>;

/** Queues a fetch for one link. A fetch already queued for it stays as it is, and is asked to run once more. */
export async function queueSealedFetch(
  d: RunDeps,
  enqueue: Enqueue,
  linkId: string,
  now: number,
): Promise<void> {
  if (!isUlid(linkId)) return;
  await d.db.prepare(`UPDATE bank_link SET fetch_requested = 1 WHERE id = ?1`).bind(linkId).run();
  const state: FetchState = { phase: 'begin', linkId };
  await enqueue(SEALED_FETCH, { id: sealedFetchId(linkId), state, runAt: now });
}

/**
 * News from the bank about one of a sealed budget's links (a verified webhook): new data starts a fetch, a repair
 * makes the link fetch again, and an error marks it "needs repair". An Item this budget doesn't hold is ignored.
 */
export async function sealedWebhook(
  d: RunDeps,
  enqueue: Enqueue,
  ev: ProviderWebhookEvent,
  now: number,
): Promise<void> {
  if (!ev.providerItemId) return;
  const link = await d.db
    .prepare(`SELECT id FROM bank_link WHERE provider_item_id = ?1 AND mac IS NOT NULL`)
    .bind(ev.providerItemId)
    .first<{ id: string }>();
  if (!link) return;
  if (ev.type === 'item_error' || ev.type === 'pending_expiration') {
    await d.db
      .prepare(`UPDATE bank_link SET status = 'needs_repair', error_code = ?2 WHERE id = ?1`)
      .bind(link.id, ev.code.slice(0, 60))
      .run();
    return;
  }
  if (ev.type === 'login_repaired')
    await d.db
      .prepare(`UPDATE bank_link SET status = 'ok', error_code = NULL WHERE id = ?1`)
      .bind(link.id)
      .run();
  if (ev.type === 'sync_updates_available' || ev.type === 'login_repaired')
    await queueSealedFetch(d, enqueue, link.id, now);
}

/** Every 4 hours: each stamped link with no complete run in the last 4 hours, or with news waiting. */
export function sealedBackstopHandler(d: RunDeps, enqueue: Enqueue): Handler {
  return async (_job, now): Promise<StepResult> => {
    const due = await d.db
      .prepare(
        `SELECT id FROM bank_link WHERE mac IS NOT NULL AND provider = 'plaid' AND status = 'ok'
           AND (last_fetched_at IS NULL OR last_fetched_at < ?1 OR fetch_requested = 1) ORDER BY id`,
      )
      .bind(now - FOUR_HOURS)
      .all<{ id: string }>();
    for (const l of due.results) await queueSealedFetch(d, enqueue, l.id, now);
    return { state: {}, runAt: now + FOUR_HOURS };
  };
}

/** Ends the job: the run is given up, and the link notes why. */
async function give(d: RunDeps, linkId: string, error: string, now: number, repair = false): Promise<void> {
  await abandonSealedRun(d.db, linkId);
  await d.db
    .prepare(
      `UPDATE bank_link SET last_attempt_at = ?2, error_code = ?3, status = iif(?4 = 1, 'needs_repair', status)
       WHERE id = ?1`,
    )
    .bind(linkId, now, error.slice(0, 60), repair ? 1 : 0)
    .run();
}

/** The job failed for good (the runner gave up on a step): the run is given up, so other links can fetch. */
export async function failSealedFetch(d: RunDeps, job: Job, error: string): Promise<void> {
  const s = job.state as FetchState;
  if (typeof s?.linkId === 'string') await give(d, s.linkId, error, Date.now());
}

export function sealedFetchHandler(deps: FetchDeps): Handler {
  return async (job, now): Promise<StepResult> => {
    const s = job.state as FetchState;
    const d = deps.runs;
    try {
      return await step(deps, s, now);
    } catch (e) {
      if (e instanceof BadStamp) {
        // Loud, and with no secret: the link's own id and which stamp failed.
        console.log(JSON.stringify({ event: 'sealed_fetch_stopped', link: s.linkId, what: e.what }));
        await give(d, s.linkId, `bad_stamp:${e.what}`, now);
        return { done: true };
      }
      if (e instanceof RunStopped) {
        // Another step moved the run, or it was given up: begin again, a few times.
        const begins = (s.begins ?? 0) + 1;
        if (begins > MAX_BEGINS) {
          await give(d, s.linkId, 'run_stopped', now);
          return { done: true };
        }
        return { state: { phase: 'begin', linkId: s.linkId, begins } satisfies FetchState, runAt: now };
      }
      // An error the bank says a retry won't fix ends the run now.
      if (e instanceof ProviderError && !e.retryable) {
        await give(d, s.linkId, e.code, now, NEEDS_SIGN_IN.has(e.code));
        return { done: true };
      }
      throw e;
    }
  };
}

async function step(deps: FetchDeps, s: FetchState, now: number): Promise<StepResult> {
  const d = deps.runs;
  const next = (state: FetchState, runAt = now): StepResult => ({ state, runAt });
  // Past 70% of a daily limit, fetching waits for the next day. A run left open that long makes way (runs.ts),
  // and this job then begins again.
  if ((s.phase === 'begin' || s.phase === 'fetch') && (await deps.budgetState()) === 'pause')
    return next(s, nextUtcMidnight(now));

  switch (s.phase) {
    case 'begin': {
      const st = await beginSealedRun(d, s.linkId, now);
      if (st === 'busy') {
        const busy = (s.busy ?? 0) + 1;
        // The backstop asks again later: the request stays noted on the link.
        if (busy > MAX_BUSY) return { done: true };
        return next({ ...s, busy }, now + BUSY_WAIT_MS);
      }
      // The news this run fetches is asked for; news that comes from here on asks for another run.
      await d.db.prepare(`UPDATE bank_link SET fetch_requested = 0 WHERE id = ?1`).bind(s.linkId).run();
      return next({
        phase: st.describes ? 'describe' : st.hasMore ? 'fetch' : 'balances',
        linkId: s.linkId,
        run: st.run,
        pages: 0,
        begins: s.begins,
        first: st.describes,
      });
    }
    case 'describe': {
      const conn = await linkForBank(d, s.linkId);
      const accounts = await deps.provider().getAccounts(conn);
      const link = await d.db
        .prepare(`SELECT linked_at FROM bank_link WHERE id = ?1`)
        .bind(s.linkId)
        .first<{ linked_at: number }>();
      await sealLinkDescription(d, { linkId: s.linkId, linkedAt: link?.linked_at ?? null, accounts });
      return next({ ...s, phase: 'complete' });
    }
    case 'fetch': {
      const r = await fetchSealedPage(d, deps.provider(), deps.pageSize);
      if (r === 'restarted') return next({ ...s, pages: 0 });
      if (!r.more) return next({ ...s, phase: 'balances' });
      const pages = (s.pages ?? 0) + 1;
      if (pages >= MAX_PAGES) throw new ProviderError('TOO_MANY_PAGES', 'too many pages', false);
      return next({ ...s, pages });
    }
    case 'balances': {
      // A run whose bank can't be asked now is stored without its balances, and its manifest says so (5.5).
      const conn = await linkForBank(d, s.linkId);
      const accounts = await deps
        .provider()
        .getAccounts(conn)
        .catch(() => null);
      if (accounts)
        await sealBankAnswer(
          d,
          1,
          accounts.map((a) => ({
            providerAccountId: a.providerAccountId,
            currentBalance: a.currentBalance,
            availableBalance: a.availableBalance,
            creditLimit: a.creditLimit,
          })),
        );
      return next({ ...s, phase: 'liabilities' });
    }
    case 'liabilities': {
      const provider = deps.provider();
      if (provider.getLiabilities) {
        const conn = await linkForBank(d, s.linkId);
        const liabilities = await provider.getLiabilities(conn).catch(() => null);
        if (liabilities?.length) await sealBankAnswer(d, 2, liabilities);
      }
      return next({ ...s, phase: 'complete' });
    }
    case 'complete': {
      const r = await completeSealedRun(d, now, s.run);
      // A key change replaced the inbox key: the same run, fetched again and sealed to the key in force.
      if (r === 'restarted') return next({ ...s, phase: 'begin' });
      await d.db
        .prepare(
          `UPDATE bank_link SET last_fetched_at = ?2, last_attempt_at = ?2, error_code = NULL, status = 'ok' WHERE id = ?1`,
        )
        .bind(s.linkId, now)
        .run();
      return s.first ? next({ phase: 'begin', linkId: s.linkId }) : { done: true };
    }
  }
}
