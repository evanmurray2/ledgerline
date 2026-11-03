// Bank sync as an alarm job (docs/multi-user.md 6.1, 6.3): the phases, tables, leases and fences of the Sync spec's
// run lifecycle, one small step per alarm. Each call of the handler does exactly one of:
// begin, fetch one page, restart, apply one chunk, process one batch, finalize, release (or hand off).
// A lost lease or an unrecoverable error ends the run (release the lease as failed); any other
// error is thrown so the runner retries the step with backoff.
import { ProviderError, type BankDataProvider } from '@ledgerline/bank-provider';
import type { Env } from '../env.js';
import { CHUNK, LeaseLost, applyPage, beginRun, fetchPage, restartFetch } from '../sync/steps.js';
import { MAX_HANDOFFS, moveLease, releaseFailed, releaseSuccess, renew } from '../sync/lease.js';
import { finalizeConnection, healPending, processPending } from '../sync/process.js';
import { sleepUntilUtcMidnight } from '../sync/breaker.js';
import { MONTHS_PER_CHUNK, recompute } from '../budget/recompute.js';
import type { Handler, Job, StepResult } from './jobs.js';

export const MAX_PAGES = 1000;
const MAX_PROCESS_STEPS = 400;

export interface SyncState {
  phase: 'begin' | 'fetch' | 'restart' | 'apply' | 'process' | 'heal' | 'finalize' | 'release';
  /** Lease holder: this job's id. */
  holder: string;
  trigger: string;
  handoffFrom?: string;
  handoffDepth?: number;
  /** The sync_run row (the holder's own, or an adopted predecessor's). */
  runId?: string;
  restart?: number;
  startCursor?: string | null;
  cursor?: string | null;
  i?: number;
  pages?: number;
  chunk?: number;
  k?: number;
}

export interface SyncDeps {
  /** The object's env with DB set to its adapter. */
  env: Env;
  budgetId: string;
  provider: () => BankDataProvider;
  token: (connectionId: string) => Promise<string>;
  pageSize: number;
  /** 'pause' when the account is past 70% of a daily limit (sync/breaker.ts). */
  budgetState: () => Promise<'normal' | 'pause'>;
  enqueue: (
    kind: string,
    o: { id?: string; connectionId?: string | null; state?: unknown; runAt: number },
  ) => Promise<string>;
}

class Fatal extends Error {}

/**
 * Plaid errors only the person can fix, by signing in to the bank again (Link update mode). The connection is
 * marked login_required, so the app asks for a repair and the 4-hour backstop stops retrying it.
 */
export const NEEDS_SIGN_IN = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_CREDENTIALS',
  'INVALID_MFA',
  'INVALID_UPDATED_USERNAME',
  'ITEM_LOCKED',
  'USER_SETUP_REQUIRED',
  'USER_INPUT_TIMEOUT',
  'MFA_NOT_SUPPORTED',
  'NO_ACCOUNTS',
  'ACCESS_NOT_GRANTED',
]);

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30);
}

export function syncHandler(deps: SyncDeps): Handler {
  return async (job: Job, now: number): Promise<StepResult> => {
    const s = job.state as SyncState;
    const connectionId = job.connectionId!;
    try {
      return await step(deps, connectionId, s, now);
    } catch (e) {
      if (e instanceof LeaseLost || e instanceof Fatal) {
        await failSync(deps, connectionId, s, e.message || e.name);
        return { done: true };
      }
      // An error Plaid says a retry won't fix ends the run now instead of retrying for an hour.
      if (e instanceof ProviderError && !e.retryable) {
        await failSync(deps, connectionId, s, e.code);
        if (NEEDS_SIGN_IN.has(e.code))
          await deps.env.DB.prepare(
            `UPDATE connection SET status = 'login_required', updated_at = ?2 WHERE id = ?1 AND removed_at IS NULL`,
          )
            .bind(connectionId, Date.now())
            .run();
        return { done: true };
      }
      throw e;
    }
  };
}

/** Release as failed: free the lease (asking for a new sync) and record the error. */
export async function failSync(
  deps: SyncDeps,
  connectionId: string,
  s: SyncState,
  error: string,
): Promise<void> {
  const db = deps.env.DB;
  const now = Date.now();
  await releaseFailed(db, connectionId, s.holder);
  await db.batch([
    db
      .prepare(
        `UPDATE sync_run SET phase = 'failed', error_code = coalesce(error_code, ?2), finished_at = ?3, updated_at = ?3
         WHERE id = ?1 AND phase NOT IN ('done', 'failed')`,
      )
      .bind(s.runId ?? s.holder, error.slice(0, 120), now),
    db
      .prepare(`UPDATE connection SET last_attempt_at = ?2, error_code = ?3 WHERE id = ?1`)
      .bind(connectionId, now, error.slice(0, 60)),
  ]);
}

async function step(deps: SyncDeps, connectionId: string, s: SyncState, now: number): Promise<StepResult> {
  const { env, budgetId } = deps;
  const db = env.DB;
  const ctx = () => ({ db, connectionId, budgetId, holder: s.holder, now: Date.now() });
  const next = (state: SyncState, runAt = now): StepResult => ({ state, runAt });
  const pauseIfNeeded = async (): Promise<StepResult | null> => {
    if ((await deps.budgetState()) !== 'pause') return null;
    await sleepUntilUtcMidnight(env, connectionId, s.holder);
    return next(s, nextUtcMidnight(now));
  };

  switch (s.phase) {
    case 'begin': {
      // A hand-off job waits until the previous run has moved the lease to it.
      if (s.handoffFrom && !(await renew(db, connectionId, s.holder, Date.now())))
        throw new Error('lease not yet handed over');
      const rs = await beginRun(ctx(), s.trigger);
      if (rs.phase === 'fetching')
        return next({
          ...s,
          phase: 'fetch',
          runId: rs.runId,
          restart: rs.restartCount,
          startCursor: rs.startCursor,
          cursor: rs.startCursor,
          i: 0,
        });
      const i = rs.appliedThrough + 1;
      const chunk = Math.floor(rs.appliedEvents / CHUNK.apply);
      return next({
        ...s,
        runId: rs.runId,
        pages: rs.pagesFetched,
        i,
        chunk,
        phase: i < rs.pagesFetched ? 'apply' : 'process',
        k: 0,
      });
    }
    case 'fetch': {
      const paused = await pauseIfNeeded();
      if (paused) return paused;
      const token = await deps.token(connectionId);
      const r = await fetchPage(
        ctx(),
        deps.provider(),
        token,
        s.runId!,
        s.restart ?? 0,
        s.i ?? 0,
        s.cursor ?? null,
        deps.pageSize,
      );
      if (r.kind === 'mutation') return next({ ...s, phase: 'restart' });
      const i = (s.i ?? 0) + 1;
      if (!r.hasMore)
        return next({ ...s, phase: i > 0 ? 'apply' : 'process', pages: i, i: 0, chunk: 0, k: 0 });
      if (i >= MAX_PAGES) throw new Fatal('too many pages');
      return next({ ...s, cursor: r.nextCursor, i });
    }
    case 'restart': {
      const rr = await restartFetch(ctx(), s.runId!);
      if (rr.failed) throw new Fatal('TOO_MANY_RESTARTS');
      return next({ ...s, phase: 'fetch', restart: rr.restartCount, cursor: s.startCursor ?? null, i: 0 });
    }
    case 'apply': {
      const paused = await pauseIfNeeded();
      if (paused) return paused;
      const i = s.i ?? 0;
      const r = await applyPage(ctx(), deps.provider(), s.runId!, i, s.chunk ?? 0);
      const ni = r.pageDone ? i + 1 : i;
      const nc = r.pageDone ? 0 : (s.chunk ?? 0) + 1;
      if (ni >= (s.pages ?? 0)) return next({ ...s, phase: 'process', i: ni, chunk: 0, k: 0 });
      return next({ ...s, i: ni, chunk: nc });
    }
    case 'process': {
      // Watermark-driven, independent of which run applied the events (F3).
      const r = await processPending(env, budgetId);
      const k = (s.k ?? 0) + 1;
      if (r.caughtUp || k > MAX_PROCESS_STEPS) return next({ ...s, phase: 'heal' });
      return next({ ...s, k });
    }
    case 'heal': {
      // Pending rows a posted row should have claimed, whether or not the bank sent news about them (D-47).
      await healPending(env, budgetId, connectionId, now).catch(() => ({ changed: false }));
      return next({ ...s, phase: 'finalize' });
    }
    case 'finalize': {
      await finalizeConnection(env, ctx(), s.runId!, { recompute: false });
      await deps.enqueue('recompute', { id: 'recompute', state: {}, runAt: now });
      return next({ ...s, phase: 'release' });
    }
    case 'release': {
      if (await releaseSuccess(db, connectionId, s.holder)) return { done: true };
      // A sync was requested mid-run: hand the lease to a new run.
      const depth = (s.handoffDepth ?? 0) + 1;
      if (depth > MAX_HANDOFFS) {
        await releaseFailed(db, connectionId, s.holder);
        return { done: true };
      }
      const id = `${s.holder.slice(0, 20)}-h${depth}-${crypto.randomUUID().slice(0, 8)}`;
      await deps.enqueue('sync', {
        id,
        connectionId,
        state: { phase: 'begin', holder: id, trigger: 'handoff', handoffFrom: s.holder, handoffDepth: depth },
        runAt: now,
      });
      await moveLease(db, connectionId, s.holder, id, Date.now());
      return { done: true };
    }
  }
}

/** Recompute as a job: MONTHS_PER_CHUNK per step until caught up. */
export const STORE_MONTHS_PER_STEP = MONTHS_PER_CHUNK;

export function recomputeHandler(db: D1Database, budgetId: string): Handler {
  return async (_job, now) => {
    const r = await recompute(db, budgetId, now, { maxMonths: STORE_MONTHS_PER_STEP });
    return r.done || !r.ok ? { done: true } : { state: {}, runAt: now };
  };
}
