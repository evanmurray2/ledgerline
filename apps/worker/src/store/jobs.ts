// The alarm job runner (docs/multi-user.md 6.1). Each alarm runs ONE step of the earliest due job:
//   1. commit attempts + 1 and set a watchdog alarm (now + 5 min) BEFORE the step runs, so a step killed by a CPU
//      overrun, a deploy or an isolate reset still counts as an attempt and is run again;
//   2. run the step (sized for ~2–4 ms of CPU);
//   3. save the new state (or delete a finished job) and reset attempts, in one transaction;
//   4. set the next alarm, synchronously, for the earliest due job.
// A step that throws backs off (10 s, 30 s, 2 min, 10 min, 1 h); after MAX_ATTEMPTS the job is marked failed and
// onFailed runs (sync jobs release their lease there). Steps must be idempotent.

export type StepResult = { done: true } | { state: unknown; runAt: number };

export interface Job<S = unknown> {
  id: string;
  kind: string;
  connectionId: string | null;
  state: S;
  attempts: number;
  recurring: boolean;
}

export type Handler = (job: Job, now: number) => Promise<StepResult>;

/** Adds a job to the store's queue (JobRunner.enqueue, at the store's clock). */
export type Enqueue = (kind: string, o: EnqueueOptions) => Promise<string>;

/** The next time it is hour:minute UTC, after `now`. */
export function nextUtc(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  if (t <= now) t += 86_400_000;
  return t;
}

/** Just after the next UTC midnight, when Cloudflare's daily limits reset. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30);
}

export const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000];
export const MAX_ATTEMPTS = 6;
export const WATCHDOG_MS = 5 * 60_000;

interface Row {
  id: string;
  kind: string;
  connection_id: string | null;
  state: string;
  run_at: number;
  attempts: number;
  recurring: number;
}

export interface EnqueueOptions {
  id?: string;
  connectionId?: string | null;
  state?: unknown;
  runAt: number;
  recurring?: boolean;
}

export type RunOutcome =
  | { ran: false; next: number | null }
  | {
      ran: true;
      id: string;
      kind: string;
      result: 'stepped' | 'done' | 'retry' | 'failed';
      next: number | null;
    };

export class JobRunner {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly handlers: Record<string, Handler>,
    private readonly onFailed: (job: Job, error: string) => Promise<void> = async () => {},
  ) {}

  /**
   * Adds a job. With an explicit id it is idempotent: a pending job with that id is left as it is. A job with that
   * id that failed for good is started again from the new state, so one bad day (Plaid down, the daily allowance
   * used up) can't stop a fixed-id job such as `recompute` or `register_link:<id>` for ever.
   */
  async enqueue(kind: string, o: EnqueueOptions, now: number): Promise<string> {
    const id = o.id ?? `${kind}:${now.toString(36)}:${crypto.randomUUID().slice(0, 8)}`;
    this.storage.sql.exec(
      `INSERT INTO job (id, kind, connection_id, state, run_at, recurring, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, connection_id = excluded.connection_id,
         state = excluded.state, run_at = excluded.run_at, recurring = excluded.recurring, attempts = 0,
         failed_at = NULL, last_error = NULL, updated_at = excluded.updated_at
       WHERE job.failed_at IS NOT NULL`,
      id,
      kind,
      o.connectionId ?? null,
      JSON.stringify(o.state ?? {}),
      o.runAt,
      o.recurring ? 1 : 0,
      now,
      now,
    );
    await this.scheduleNext(now);
    return id;
  }

  /** Runs one step of the earliest due job. Called from alarm(). */
  async runNext(now: number): Promise<RunOutcome> {
    const row = this.storage.sql
      .exec(
        `SELECT id, kind, connection_id, state, run_at, attempts, recurring FROM job
         WHERE failed_at IS NULL AND run_at <= ? ORDER BY run_at, id LIMIT 1`,
        now,
      )
      .toArray()[0] as unknown as Row | undefined;
    if (!row) return { ran: false, next: await this.scheduleNext(now) };
    const job: Job = {
      id: row.id,
      kind: row.kind,
      connectionId: row.connection_id,
      state: JSON.parse(row.state) as unknown,
      attempts: row.attempts,
      recurring: row.recurring === 1,
    };
    // A job whose steps keep getting killed never reaches the catch below; its committed attempts stop it here.
    if (row.attempts >= MAX_ATTEMPTS) {
      await this.fail(job, 'killed repeatedly (attempts committed before the step)', now);
      return { ran: true, id: job.id, kind: job.kind, result: 'failed', next: await this.scheduleNext(now) };
    }
    // 1. Commit the attempt and a watchdog alarm before running anything.
    this.storage.sql.exec(`UPDATE job SET attempts = attempts + 1, updated_at = ? WHERE id = ?`, now, job.id);
    await this.storage.setAlarm(now + WATCHDOG_MS);
    await this.storage.sync();
    const handler = this.handlers[job.kind];
    let result: StepResult;
    try {
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      result = await handler({ ...job, attempts: job.attempts + 1 }, now);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e).slice(0, 300);
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await this.fail(job, msg, now);
        return {
          ran: true,
          id: job.id,
          kind: job.kind,
          result: 'failed',
          next: await this.scheduleNext(now),
        };
      }
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      this.storage.sql.exec(
        `UPDATE job SET run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        now + delay,
        msg,
        now,
        job.id,
      );
      return { ran: true, id: job.id, kind: job.kind, result: 'retry', next: await this.scheduleNext(now) };
    }
    // 3. Save the result.
    if ('done' in result) {
      this.storage.sql.exec(`DELETE FROM job WHERE id = ?`, job.id);
    } else {
      this.storage.sql.exec(
        `UPDATE job SET state = ?, run_at = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
        JSON.stringify(result.state ?? {}),
        result.runAt,
        now,
        job.id,
      );
    }
    return {
      ran: true,
      id: job.id,
      kind: job.kind,
      result: 'done' in result ? 'done' : 'stepped',
      next: await this.scheduleNext(now),
    };
  }

  /** 4. Points the alarm at the earliest due job, or clears it when there is none. Returns that time. */
  async scheduleNext(now: number): Promise<number | null> {
    const r = this.storage.sql
      .exec(`SELECT min(run_at) AS t FROM job WHERE failed_at IS NULL`)
      .toArray()[0] as { t: number | null } | undefined;
    const t = r?.t ?? null;
    if (t === null) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(t, now));
    return t;
  }

  list(): Array<{
    id: string;
    kind: string;
    run_at: number;
    attempts: number;
    failed_at: number | null;
    last_error: string | null;
  }> {
    return this.storage.sql
      .exec(`SELECT id, kind, run_at, attempts, failed_at, last_error FROM job ORDER BY run_at, id`)
      .toArray() as never;
  }

  private async fail(job: Job, error: string, now: number): Promise<void> {
    if (job.recurring) {
      // Recurring rows are never retired: report the failure and try again in an hour.
      this.storage.sql.exec(
        `UPDATE job SET attempts = 0, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        now + 3_600_000,
        error.slice(0, 300),
        now,
        job.id,
      );
      await this.onFailed(job, error);
      return;
    }
    this.storage.sql.exec(
      `UPDATE job SET failed_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      now,
      error.slice(0, 300),
      now,
      job.id,
    );
    await this.onFailed(job, error);
  }
}
