import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env, SyncParams } from '../env.js';
import { MAX_HANDOFFS, moveLease, releaseFailed, releaseSuccess, renew } from './lease.js';
import {
  APPLY_CHUNK,
  applyPage,
  beginRun,
  fetchPage,
  LeaseLost,
  restartFetch,
  type ApplyResult,
  type FetchResult,
  type StepContext,
} from './steps.js';
import { connectionToken, makeProvider, pageSize } from './provider.js';
import { processPending, finalizeConnection } from './process.js';
import { writeBudgetState, sleepUntilUtcMidnight } from './breaker.js';

/** Sync spec: 2-minute timeout and 3 retries per step, so a step's worst case stays far below the 90-minute TTL. */
const STEP = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
  timeout: '2 minutes' as const,
};
const MAX_PAGES = 1000;

export class SyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  override async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep): Promise<unknown> {
    const p = event.payload;
    const env = this.env;
    const ctx = (alsoAccept?: string): StepContext => ({
      db: env.DB,
      connectionId: p.connectionId,
      budgetId: p.budgetId,
      holder: p.runId,
      now: Date.now(),
      ...(alsoAccept ? { alsoAccept } : {}),
    });
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof LeaseLost) throw new NonRetryableError('lease lost');
        throw e;
      }
    };

    try {
      // A hand-off instance retries until the previous run has moved the lease to it.
      const state = await step.do('begin', STEP, () =>
        guard(async () => {
          if (p.handoffFrom && !(await renew(env.DB, p.connectionId, p.runId, Date.now()))) {
            throw new Error('lease not yet handed over');
          }
          return beginRun(ctx(), p.trigger);
        }),
      );

      // Fetch every page before applying any (Plaid's restart rule needs the run's first cursor). Each step first
      // checks the account-wide write budget; when it is spent, the run keeps its lease and sleeps to 00:00 UTC.
      const pauseUntilMidnight = async (name: string) => {
        await step.do(`${name}-extend`, STEP, () =>
          guard(() => sleepUntilUtcMidnight(env, p.connectionId, p.runId)),
        );
        await step.sleepUntil(`${name}-sleep`, nextUtcMidnight());
      };
      let pages = state.pagesFetched;
      if (state.phase === 'fetching') {
        let restart = state.restartCount;
        let cursor = state.startCursor;
        let i = 0;
        for (let attempt = 0; ;) {
          const name = `fetch-${restart}-${i}-${attempt}`;
          const r = await step.do(name, STEP, () =>
            guard(async (): Promise<FetchResult | { kind: 'pause' }> => {
              if ((await writeBudgetState(env)) === 'pause') return { kind: 'pause' };
              const token = await connectionToken(env, p.connectionId);
              return fetchPage(
                ctx(),
                makeProvider(env),
                token,
                state.runId,
                restart,
                i,
                cursor,
                pageSize(env),
              );
            }),
          );
          if (r.kind === 'pause') {
            await pauseUntilMidnight(name);
            attempt++;
            continue;
          }
          if (r.kind === 'mutation') {
            const rr = await step.do(`restart-${restart}`, STEP, () =>
              guard(() => restartFetch(ctx(), state.runId)),
            );
            if (rr.failed) throw new NonRetryableError('TOO_MANY_RESTARTS');
            restart = rr.restartCount;
            cursor = state.startCursor;
            i = 0;
            continue;
          }
          cursor = r.nextCursor;
          i++;
          if (!r.hasMore) break;
          if (i >= MAX_PAGES) throw new NonRetryableError('too many pages');
        }
        pages = i;
      }

      // Apply staged pages in order, each in chunks of APPLY_CHUNK events, one batch per step.
      for (let i = state.appliedThrough + 1; i < pages; i++) {
        let chunk = i === state.appliedThrough + 1 ? Math.floor(state.appliedEvents / APPLY_CHUNK) : 0;
        for (let attempt = 0; ;) {
          const name = `apply-${i}-${chunk}-${attempt}`;
          const r = await step.do(name, STEP, () =>
            guard(async (): Promise<ApplyResult | { kind: 'pause' }> => {
              if ((await writeBudgetState(env)) === 'pause') return { kind: 'pause' };
              return applyPage(ctx(), makeProvider(env), state.runId, i, chunk);
            }),
          );
          if ('kind' in r) {
            await pauseUntilMidnight(name);
            attempt++;
            continue;
          }
          if (r.pageDone) break;
          chunk++;
        }
      }

      // Post-apply work driven by the watermark, independent of which run applied the events (F3).
      for (let k = 0; ; k++) {
        const r = await step.do(`process-${k}`, STEP, () => processPending(env, p.budgetId));
        if (r.caughtUp) break;
        if (k > 200) break; // the cron and the daily job continue from the watermark
      }
      await step.do('finalize', STEP, () => guard(() => finalizeConnection(env, ctx(), state.runId)));

      // Release, or hand off when a request arrived mid-run.
      const released = await step.do('release', STEP, () => releaseSuccess(env.DB, p.connectionId, p.runId));
      if (!released) {
        const depth = (p.handoffDepth ?? 0) + 1;
        if (depth > MAX_HANDOFFS) {
          await step.do('release-cap', STEP, () => releaseFailed(env.DB, p.connectionId, p.runId));
          return { ok: true, handoff: 'capped' };
        }
        const next = await step.do('handoff-create', STEP, async () => {
          const id = `${p.runId.slice(0, 20)}-h${depth}-${crypto.randomUUID().slice(0, 8)}`;
          try {
            await env.SYNC.create({
              id,
              params: { ...p, runId: id, handoffFrom: p.runId, handoffDepth: depth, trigger: 'handoff' },
            });
          } catch (e) {
            if (!/already exists/i.test(String(e))) throw e;
          }
          return id;
        });
        await step.do('handoff-move', STEP, async () => {
          await moveLease(env.DB, p.connectionId, p.runId, next, Date.now());
        });
        return { ok: true, handoff: next };
      }
      return { ok: true, pages };
    } catch (e) {
      await step.do('release-failed', STEP, async () => {
        await releaseFailed(env.DB, p.connectionId, p.runId);
        await env.DB.prepare(
          `UPDATE sync_run SET phase = 'failed', error_code = coalesce(error_code, ?2), finished_at = ?3, updated_at = ?3
           WHERE id = ?1 AND phase NOT IN ('done', 'failed')`,
        )
          .bind(p.runId, String(e instanceof Error ? e.message : e).slice(0, 120), Date.now())
          .run();
        await env.DB.prepare(`UPDATE connection SET last_attempt_at = ?2, error_code = ?3 WHERE id = ?1`)
          .bind(p.connectionId, Date.now(), String(e instanceof Error ? e.message : e).slice(0, 60))
          .run();
      });
      throw e;
    }
  }
}

function nextUtcMidnight(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30));
}
