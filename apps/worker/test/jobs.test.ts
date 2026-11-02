// The alarm job runner (docs/multi-user.md 6.1), run inside a real Durable Object.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, JobRunner, MAX_ATTEMPTS, WATCHDOG_MS, type Handler } from '../src/store/jobs.js';
import type { BudgetStore } from '../src/store/budget-store.js';

const e = env as unknown as { BUDGET: DurableObjectNamespace<BudgetStore> };
const T = 1_800_000_000_000;
const fresh = () => e.BUDGET.get(e.BUDGET.idFromName(`jobs-${Math.random()}`));

async function inObject<R>(fn: (s: DurableObjectStorage) => Promise<R>): Promise<R> {
  return runInDurableObject(fresh(), async (_o, state) => fn(state.storage));
}

describe('job runner', () => {
  it('runs one step per call and keeps state between steps until the job is done', async () => {
    await inObject(async (storage) => {
      const count: Handler = async (job, now) => {
        const n = (job.state as { n: number }).n + 1;
        return n >= 3 ? { done: true } : { state: { n }, runAt: now + 1000 };
      };
      const r = new JobRunner(storage, { count });
      await r.enqueue('count', { id: 'j1', state: { n: 0 }, runAt: T }, T);
      expect(await storage.getAlarm()).toBe(T);
      expect(await r.runNext(T)).toMatchObject({ ran: true, result: 'stepped', next: T + 1000 });
      expect(await r.runNext(T + 500)).toMatchObject({ ran: false });
      expect(await r.runNext(T + 1000)).toMatchObject({ result: 'stepped' });
      expect(await r.runNext(T + 2000)).toMatchObject({ result: 'done', next: null });
      expect(r.list()).toEqual([]);
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it('commits the attempt and a watchdog alarm before the step runs', async () => {
    await inObject(async (storage) => {
      let seen: { attempts: number; alarm: number | null } | null = null;
      const look: Handler = async () => {
        const row = storage.sql.exec(`SELECT attempts FROM job WHERE id = 'j'`).one();
        seen = { attempts: Number(row.attempts), alarm: await storage.getAlarm() };
        return { done: true };
      };
      const r = new JobRunner(storage, { look });
      await r.enqueue('look', { id: 'j', runAt: T }, T);
      await r.runNext(T);
      expect(seen).toEqual({ attempts: 1, alarm: T + WATCHDOG_MS });
    });
  });

  it('backs off after a failing step and marks the job failed after the last attempt', async () => {
    await inObject(async (storage) => {
      const failed: string[] = [];
      const boom: Handler = async () => {
        throw new Error('plaid 500');
      };
      const r = new JobRunner(storage, { boom }, async (job, err) => {
        failed.push(`${job.id}: ${err}`);
      });
      await r.enqueue('boom', { id: 'b', runAt: T }, T);
      let now = T;
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        const o = await r.runNext(now);
        expect(o).toMatchObject({
          result: 'retry',
          next: now + BACKOFF_MS[Math.min(i - 1, BACKOFF_MS.length - 1)]!,
        });
        now = (o as { next: number }).next;
      }
      expect(await r.runNext(now)).toMatchObject({ result: 'failed' });
      expect(failed).toEqual(['b: plaid 500']);
      expect(r.list()[0]).toMatchObject({ id: 'b', failed_at: now, last_error: 'plaid 500' });
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it('a step that is killed every time still ends as failed, from the committed attempts', async () => {
    await inObject(async (storage) => {
      const r = new JobRunner(storage, { never: async () => ({ done: true }) });
      await r.enqueue('never', { id: 'k', runAt: T }, T);
      // A killed step leaves only its committed attempt behind; the watchdog alarm brings it back.
      storage.sql.exec(`UPDATE job SET attempts = ? WHERE id = 'k'`, MAX_ATTEMPTS);
      expect(await r.runNext(T)).toMatchObject({ result: 'failed' });
    });
  });

  it('a failing recurring job is never retired: it reports and tries again in an hour', async () => {
    await inObject(async (storage) => {
      const reports: string[] = [];
      const r = new JobRunner(
        storage,
        {
          tick: async () => {
            throw new Error('down');
          },
        },
        async (job) => {
          reports.push(job.id);
        },
      );
      await r.enqueue('tick', { id: 'recurring:tick', runAt: T, recurring: true }, T);
      storage.sql.exec(`UPDATE job SET attempts = ? WHERE id = 'recurring:tick'`, MAX_ATTEMPTS - 1);
      await r.runNext(T);
      expect(reports).toEqual(['recurring:tick']);
      expect(r.list()[0]).toMatchObject({ failed_at: null, attempts: 0, run_at: T + 3_600_000 });
    });
  });

  it('enqueue with an id is idempotent', async () => {
    await inObject(async (storage) => {
      const r = new JobRunner(storage, {});
      await r.enqueue('x', { id: 'same', runAt: T, state: { a: 1 } }, T);
      await r.enqueue('x', { id: 'same', runAt: T + 5, state: { a: 2 } }, T);
      expect(r.list()).toHaveLength(1);
      expect(storage.sql.exec(`SELECT state FROM job`).one().state).toBe('{"a":1}');
    });
  });

  it('enqueueing a job that failed for good starts it again', async () => {
    await inObject(async (storage) => {
      let fail = true;
      const flaky: Handler = async () => {
        if (fail) throw new Error('daily allowance used up');
        return { done: true };
      };
      const r = new JobRunner(storage, { flaky });
      await r.enqueue('flaky', { id: 'recompute', runAt: T }, T);
      let now = T;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const o = await r.runNext(now);
        now = (o as { next: number | null }).next ?? now;
      }
      expect(r.list()[0]).toMatchObject({ id: 'recompute', failed_at: expect.any(Number) });
      fail = false;
      await r.enqueue('flaky', { id: 'recompute', runAt: now, state: { again: 1 } }, now);
      expect(r.list()[0]).toMatchObject({ failed_at: null, attempts: 0, last_error: null });
      expect(await storage.getAlarm()).toBe(now);
      expect(await r.runNext(now)).toMatchObject({ result: 'done' });
      expect(r.list()).toEqual([]);
    });
  });
});
