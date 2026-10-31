import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env, RecomputeParams } from '../env.js';
import { recompute } from './recompute.js';
import { clock } from '../http/clock.js';

const STEP = {
  retries: { limit: 3, delay: '5 seconds' as const, backoff: 'exponential' as const },
  timeout: '2 minutes' as const,
};

/** Continues a long recompute 6 months per step (decisions.md D-22). */
export class RecomputeWorkflow extends WorkflowEntrypoint<Env, RecomputeParams> {
  override async run(event: WorkflowEvent<RecomputeParams>, step: WorkflowStep): Promise<unknown> {
    for (let i = 0; i < 60; i++) {
      const r = await step.do(`chunk-${i}`, STEP, () =>
        recompute(this.env.DB, event.payload.budgetId, clock(this.env)),
      );
      if (r.done || !r.ok) return { done: r.done, chunks: i + 1 };
    }
    return { done: false };
  }
}
