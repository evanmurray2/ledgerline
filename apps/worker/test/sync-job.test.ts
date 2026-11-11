// Bank sync as an alarm job (docs/multi-user.md 6.1), inside a real Durable Object.
import type { Db } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { generate } from '../../../tools/plaid-mock/data.mjs';
import { workOut } from './work-out.js';
import { DurableDb } from '../src/store/adapter.js';
import { JobRunner } from '../src/store/jobs.js';
import {
  failSync,
  nextUtcMidnight,
  syncHandler,
  type SyncDeps,
  type SyncState,
} from '../src/store/sync-job.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import type { Env } from '../src/env.js';

const e = env as unknown as Env & { BUDGET: DurableObjectNamespace<BudgetStore> };
const T = Date.parse('2026-11-14T20:00:00Z');
const TOTAL = 300;
const PAGE = 100;
// Generated once: the generator's random sequence is shared, so every run must see the same transactions.
const DATA = generate(TOTAL, 1) as unknown[];

function pageBody(start: number): string {
  const added = DATA.slice(start, start + PAGE);
  const next = start + added.length;
  return JSON.stringify({
    accounts: [],
    added,
    has_more: next < TOTAL,
    modified: [],
    next_cursor: btoa(String(next)),
    removed: [],
    request_id: 'req_test',
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  });
}
const provider = new PlaidProvider({
  clientId: 'c',
  secret: 's',
  env: 'sandbox',
  fetch: async (_u, init) => {
    const body = JSON.parse(String(init?.body)) as { cursor?: string };
    return new Response(pageBody(body.cursor ? Number(atob(body.cursor)) : 0), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});

async function seed(db: Db, B: string, C: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES (?1, 'B', '2023-11', 0, 0)`,
      )
      .bind(B),
    db
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
         VALUES (?1, ?2, 'plaid', 'Sandbox', 0, 0, 0)`,
      )
      .bind(C, B),
    // The mock's accounts, so budget lines are built from the synced rows and compared too.
    ...[
      ['acc_checking', 'checking'],
      ['acc_savings', 'savings'],
      ['acc_credit', 'credit'],
    ].map(([pa, kind]) =>
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, created_at, updated_at)
           VALUES (?1 || ?2, ?2, ?1, ?1, ?3, '2023-11-01', 0, 0)`,
        )
        .bind(pa, B, kind),
    ),
  ]);
}

function deps(db: Db, B: string, over: Partial<SyncDeps> = {}, queue: unknown[] = []): SyncDeps {
  return {
    env: { ...e, DB: db },
    budgetId: B,
    provider: () => provider,
    token: async () => 'access-sandbox-x',
    pageSize: PAGE,
    budgetState: async () => 'normal',
    enqueue: async (kind, o) => {
      queue.push({ kind, ...o });
      return o.id ?? kind;
    },
    ...over,
  };
}

async function acquireFor(db: Db, C: string, holder: string): Promise<void> {
  const { acquire } = await import('../src/sync/lease.js');
  expect(await acquire(db, C, holder, Date.now())).toBe(true);
}

const start = (holder: string): SyncState => ({ phase: 'begin', holder, trigger: 'test' });

describe('sync job', () => {
  it('runs to completion through the alarm runner: rows applied, run done, lease released, recompute queued and run', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-runner')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'sync:1');
      // The sync job enqueues its follow-ups (recompute, hand-off) on the same runner.
      const runner: JobRunner = new JobRunner(st.storage, {
        sync: syncHandler(deps(db, 'b1', { enqueue: (kind, o) => runner.enqueue(kind, o, Date.now()) })),
        recompute: async () => ({ done: true }),
      });
      await runner.enqueue('sync', { id: 'sync:1', connectionId: 'c1', state: start('sync:1'), runAt: T }, T);
      let now = T;
      for (let n = 0; n < 2000 && runner.list().length; n++) {
        const o = await runner.runNext(now);
        if (o.ran && o.result === 'retry') throw new Error(`step failed: ${runner.list()[0]?.last_error}`);
        now += 1000;
      }
      expect(runner.list()).toEqual([]);
      expect(await db.prepare(`SELECT count(*) AS n FROM bank_txn`).first('n')).toBe(TOTAL);
      expect(await db.prepare(`SELECT phase FROM sync_run`).first('phase')).toBe('done');
      // The update's time and its place among the budget's updates, set when its last page was stored (D-86 A1, A2).
      const run = await db
        .prepare(`SELECT fetched_at, fetch_seq, started_at, finished_at FROM sync_run`)
        .first<{ fetched_at: number; fetch_seq: number; started_at: number; finished_at: number }>();
      expect(run!.fetch_seq).toBe(1);
      expect(run!.fetched_at).toBeGreaterThanOrEqual(run!.started_at);
      expect(run!.fetched_at).toBeLessThan(run!.finished_at);
      // Every row of the update arrived at one time: the moment its fetch finished, not the clock of each apply step.
      const arrived = (
        await db.prepare(`SELECT DISTINCT created_at FROM bank_txn`).all<{ created_at: number }>()
      ).results;
      expect(arrived).toEqual([{ created_at: run!.fetched_at }]);
      const conn = await db
        .prepare(`SELECT sync_lock, last_synced_at FROM connection`)
        .first<{ sync_lock: string | null; last_synced_at: number }>();
      expect(conn!.sync_lock).toBeNull();
      expect(conn!.last_synced_at).toBeGreaterThan(0);
      expect(
        await db.prepare(`SELECT summary_dirty_from FROM budget`).first('summary_dirty_from'),
      ).toBeNull();
    });
  });

  it('numbers the budget’s bank updates in the order their fetches finished, and an adopted run keeps its number', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-fetch-seq')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      const { beginRun } = await import('../src/sync/steps.js');
      const run = (id: string, phase: string, seq: number | null, at: number | null) =>
        db
          .prepare(
            `INSERT INTO sync_run (id, budget_id, connection_id, phase, pages_fetched, applied_through, started_at, created_at, updated_at, fetched_at, fetch_seq)
             VALUES (?1, 'b1', 'c1', ?2, 2, 0, ?3, ?3, ?3, ?4, ?5)`,
          )
          .bind(id, phase, T, at, seq)
          .run();
      // Two earlier updates, done; then one that was fetched to the end and died while it was being applied.
      await run('sync:a', 'done', 1, T + 1);
      await run('sync:b', 'done', 2, T + 2);
      await run('sync:c', 'applying', 3, T + 3);
      await acquireFor(db, 'c1', 'sync:d');
      const state = await beginRun(
        { db, connectionId: 'c1', budgetId: 'b1', holder: 'sync:d', now: T + 9000 },
        'manual',
      );
      expect(state.phase).toBe('applying');
      const rows = (
        await db
          .prepare(`SELECT id, phase, error_code, fetch_seq, fetched_at FROM sync_run ORDER BY id`)
          .all<{
            id: string;
            phase: string;
            error_code: string | null;
            fetch_seq: number;
            fetched_at: number;
          }>()
      ).results;
      expect(rows.find((r) => r.id === 'sync:c')).toMatchObject({
        phase: 'failed',
        error_code: 'ADOPTED',
        fetch_seq: -3,
      });
      // The same bank update under a new id: the time it was fetched and its place are the old run's.
      expect(rows.find((r) => r.id === 'sync:d')).toMatchObject({
        phase: 'applying',
        fetch_seq: 3,
        fetched_at: T + 3,
      });
      // The next update to finish fetching is number 4, not 3 again.
      const next = await db
        .prepare(`SELECT coalesce(max(abs(fetch_seq)), 0) + 1 AS n FROM sync_run WHERE budget_id = 'b1'`)
        .first('n');
      expect(next).toBe(4);
    });
  });

  it('files two banks’ updates one at a time, in the order their fetches finished (D-86 A2)', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-turns')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'big');
      await db
        .prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
           VALUES ('small', 'b1', 'plaid', 'Second bank', 0, 0, 0)`,
        )
        .run();
      // "big" has 3 pages; "small" has 1 page of other rows, so it finishes fetching first though it starts second.
      const small = (DATA.slice(0, 40) as { transaction_id: string }[]).map((t) => ({
        ...t,
        transaction_id: `${t.transaction_id}-small`,
      }));
      const two = new PlaidProvider({
        clientId: 'c',
        secret: 's',
        env: 'sandbox',
        fetch: async (_u, init) => {
          const body = JSON.parse(String(init?.body)) as { cursor?: string; access_token?: string };
          const text =
            body.access_token === 'token-small'
              ? JSON.stringify({
                  accounts: [],
                  added: small,
                  has_more: false,
                  modified: [],
                  next_cursor: 'end',
                  removed: [],
                  request_id: 'req_small',
                  transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
                })
              : pageBody(body.cursor ? Number(atob(body.cursor)) : 0);
          return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      await acquireFor(db, 'big', 'sync:big');
      await acquireFor(db, 'small', 'sync:small');
      const runner: JobRunner = new JobRunner(st.storage, {
        sync: syncHandler(
          deps(db, 'b1', {
            provider: () => two,
            token: async (c) => `token-${c}`,
            enqueue: (kind, o) => runner.enqueue(kind, o, Date.now()),
          }),
        ),
        recompute: async () => ({ done: true }),
      });
      await runner.enqueue(
        'sync',
        { id: 'sync:big', connectionId: 'big', state: start('sync:big'), runAt: T },
        T,
      );
      await runner.enqueue(
        'sync',
        { id: 'sync:small', connectionId: 'small', state: start('sync:small'), runAt: T },
        T,
      );
      let now = T;
      for (let n = 0; n < 4000 && runner.list().length; n++) {
        const o = await runner.runNext(now);
        if (o.ran && o.result === 'retry') throw new Error(`step failed: ${runner.list()[0]?.last_error}`);
        now += 500;
      }
      expect(runner.list()).toEqual([]);
      const runs = (
        await db
          .prepare(
            `SELECT r.id, r.phase, r.fetch_seq, min(e.id) AS first, max(e.id) AS last, count(e.id) AS events
             FROM sync_run r LEFT JOIN bank_event e ON e.sync_run_id = r.id GROUP BY r.id ORDER BY r.fetch_seq`,
          )
          .all<{
            id: string;
            phase: string;
            fetch_seq: number;
            first: number;
            last: number;
            events: number;
          }>()
      ).results;
      expect(runs.map((r) => [r.id, r.phase, r.fetch_seq, r.events])).toEqual([
        ['sync:small', 'done', 1, 40],
        ['sync:big', 'done', 2, TOTAL],
      ]);
      // Every event of the first update comes before every event of the second: no interleaving.
      expect(runs[0]!.last).toBeLessThan(runs[1]!.first);
      // Both leases are free, and every row is filed.
      expect(
        await db.prepare(`SELECT count(*) AS n FROM connection WHERE sync_lock IS NOT NULL`).first('n'),
      ).toBe(0);
      const filed = await db
        .prepare(
          `SELECT (SELECT processed_through FROM budget) AS through, (SELECT max(id) FROM bank_event) AS last`,
        )
        .first<{ through: number; last: number }>();
      expect(filed!.through).toBe(filed!.last);
    });
  });

  it('an update whose job is gone does not hold the others back', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-turn-stale')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await db
        .prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
           VALUES ('c2', 'b1', 'plaid', 'Second bank', 0, 0, 0)`,
        )
        .run();
      const { isMyTurn } = await import('../src/sync/turn.js');
      const run = (id: string, conn: string, phase: string, seq: number | null) =>
        db
          .prepare(
            `INSERT INTO sync_run (id, budget_id, connection_id, phase, started_at, created_at, updated_at, fetched_at, fetch_seq)
             VALUES (?1, 'b1', ?2, ?3, ?4, ?4, ?4, ?4, ?5)`,
          )
          .bind(id, conn, phase, T, seq)
          .run();
      await run('r1', 'c1', 'applying', 1);
      await run('r2', 'c2', 'fetching', 2);
      const lease = (conn: string, holder: string | null, expires: number) =>
        db
          .prepare(`UPDATE connection SET sync_lock = ?2, lock_expires = ?3 WHERE id = ?1`)
          .bind(conn, holder, expires)
          .run();
      await lease('c1', 'r1', T + 60_000);
      await lease('c2', 'r2', T + 60_000);
      // r1 finished fetching first and is alive: r2 waits, r1 goes.
      expect(await isMyTurn(db, 'b1', 'r1', T)).toBe(true);
      expect(await isMyTurn(db, 'b1', 'r2', T)).toBe(false);
      // r1's lease ran out, or went to another run: r2 goes.
      await lease('c1', 'r1', T - 1);
      expect(await isMyTurn(db, 'b1', 'r2', T)).toBe(true);
      await lease('c1', 'other', T + 60_000);
      expect(await isMyTurn(db, 'b1', 'r2', T)).toBe(true);
      // r1 done or failed: r2 goes.
      await lease('c1', 'r1', T + 60_000);
      for (const phase of ['done', 'failed']) {
        await db.prepare(`UPDATE sync_run SET phase = ?1 WHERE id = 'r1'`).bind(phase).run();
        expect(await isMyTurn(db, 'b1', 'r2', T)).toBe(true);
      }
      // A run with no place (from before the rule) never waits, and nothing waits for it.
      await db.prepare(`UPDATE sync_run SET phase = 'applying' WHERE id = 'r1'`).run();
      await run('r0', 'c1', 'applying', null);
      expect(await isMyTurn(db, 'b1', 'r0', T)).toBe(true);
      expect(await isMyTurn(db, 'b1', 'r1', T)).toBe(true);
    });
  });

  it('pauses until 00:00 UTC when the account is near its daily limit, keeping the lease', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-pause')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'p');
      const h = syncHandler(deps(db, 'b1', { budgetState: async () => 'pause' }));
      const job = { id: 'p', kind: 'sync', connectionId: 'c1', attempts: 1, recurring: false };
      const a = await h({ ...job, state: start('p') }, T);
      const b = await h({ ...job, state: (a as { state: unknown }).state }, T);
      expect(b).toMatchObject({ runAt: nextUtcMidnight(T), state: { phase: 'fetch' } });
      const lock = await db
        .prepare(`SELECT sync_lock, lock_expires FROM connection`)
        .first<{ sync_lock: string; lock_expires: number }>();
      expect(lock!.sync_lock).toBe('p');
      expect(lock!.lock_expires).toBeGreaterThan(nextUtcMidnight(Date.now()) - 60_000);
    });
  });

  it('a lost lease ends the run as failed and asks for a new sync', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-lost')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'l');
      const h = syncHandler(deps(db, 'b1'));
      const job = { id: 'l', kind: 'sync', connectionId: 'c1', attempts: 1, recurring: false };
      const a = await h({ ...job, state: start('l') }, T);
      await db.prepare(`UPDATE connection SET sync_lock = 'someone-else'`).run();
      expect(await h({ ...job, state: (a as { state: unknown }).state }, T)).toEqual({ done: true });
      expect(await db.prepare(`SELECT phase FROM sync_run`).first('phase')).toBe('failed');
    });
  });

  it('a bank that needs signing in again ends the run at once and is marked for repair', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-login')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'x');
      const expired = new PlaidProvider({
        clientId: 'c',
        secret: 's',
        env: 'sandbox',
        fetch: async () =>
          new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'sign in' }), {
            status: 400,
          }),
      });
      const h = syncHandler(deps(db, 'b1', { provider: () => expired }));
      const job = { id: 'x', kind: 'sync', connectionId: 'c1', attempts: 1, recurring: false };
      const a = await h({ ...job, state: start('x') }, T);
      expect(await h({ ...job, state: (a as { state: unknown }).state }, T)).toEqual({ done: true });
      const conn = await db
        .prepare(`SELECT status, error_code, sync_lock FROM connection`)
        .first<{ status: string; error_code: string; sync_lock: string | null }>();
      expect(conn).toEqual({ status: 'login_required', error_code: 'ITEM_LOGIN_REQUIRED', sync_lock: null });
      expect(await db.prepare(`SELECT phase FROM sync_run`).first('phase')).toBe('failed');
    });
  });

  it('a removed connection loses its lease, so its sync stops', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-removed')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'r');
      const h = syncHandler(deps(db, 'b1'));
      const job = { id: 'r', kind: 'sync', connectionId: 'c1', attempts: 1, recurring: false };
      const a = await h({ ...job, state: start('r') }, T);
      await db.prepare(`UPDATE connection SET removed_at = 1`).run();
      expect(await h({ ...job, state: (a as { state: unknown }).state }, T)).toEqual({ done: true });
      expect(await db.prepare(`SELECT count(*) AS n FROM bank_txn`).first('n')).toBe(0);
    });
  });

  it('a run that fails partway through applying, then runs again from the start, counts every row once', async () => {
    /** What the budget sees: bank rows, budget lines and month snapshots (no ids or times). */
    const fingerprint = async (db: Db) => {
      // The phone works out lines and months after it syncs (D-45).
      await workOut(db, 'b1', T);
      return JSON.stringify([
        (
          await db
            .prepare(
              `SELECT provider_txn_id, amount, date, pending, removed_at IS NULL AS live, txn_key FROM bank_txn ORDER BY 1`,
            )
            .all()
        ).results,
        (
          await db
            .prepare(
              `SELECT txn_key, line, month, date, kind, account_id, card, category_id, amount, ref FROM budget_line ORDER BY txn_key, line`,
            )
            .all()
        ).results,
        (await db.prepare(`SELECT month, state FROM month_snapshot ORDER BY month`).all()).results,
      ]);
    };
    const runAll = async (db: Db, st: DurableObjectState, holder: string) => {
      const runner: JobRunner = new JobRunner(st.storage, {
        sync: syncHandler(deps(db, 'b1', { enqueue: (kind, o) => runner.enqueue(kind, o, Date.now()) })),
        recompute: async () => ({ done: true }),
      });
      await runner.enqueue('sync', { id: holder, connectionId: 'c1', state: start(holder), runAt: T }, T);
      let now = T;
      for (let n = 0; n < 2000 && runner.list().length; n++) {
        const o = await runner.runNext(now);
        if (o.ran && o.result === 'retry') throw new Error(`step failed: ${runner.list()[0]?.last_error}`);
        now += 1000;
      }
      expect(runner.list()).toEqual([]);
    };

    const clean = await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName('sync-clean')),
      async (_o, st) => {
        const db = new DurableDb(st.storage);
        await seed(db, 'b1', 'c1');
        await acquireFor(db, 'c1', 'one');
        await runAll(db, st, 'one');
        return fingerprint(db);
      },
    );

    const replayed = await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName('sync-replay')),
      async (_o, st) => {
        const db = new DurableDb(st.storage);
        await seed(db, 'b1', 'c1');
        await acquireFor(db, 'c1', 'first');
        // The first run fetches every page and applies part of them, then fails for good.
        const d = deps(db, 'b1');
        const h = syncHandler(d);
        const job = { id: 'first', kind: 'sync', connectionId: 'c1', attempts: 1, recurring: false };
        let state: SyncState = start('first');
        let applied = 0;
        for (let n = 0; n < 50; n++) {
          if (state.phase === 'apply' && ++applied > 5) break;
          state = ((await h({ ...job, state }, T)) as { state: SyncState }).state;
        }
        expect(state.phase).toBe('apply');
        expect(Number(await db.prepare(`SELECT count(*) AS n FROM bank_event`).first('n'))).toBeGreaterThan(
          0,
        );
        await failSync(d, 'c1', state, 'test: killed');
        expect(await db.prepare(`SELECT phase FROM sync_run`).first('phase')).toBe('failed');
        // The next sync starts again from the stored cursor and applies every page again.
        await acquireFor(db, 'c1', 'second');
        await runAll(db, st, 'second');
        expect(Number(await db.prepare(`SELECT count(*) AS n FROM bank_event`).first('n'))).toBeGreaterThan(
          TOTAL,
        );
        return fingerprint(db);
      },
    );

    // Not vacuous: the budget has lines built from the synced rows.
    expect(clean).toContain('"kind":"');
    expect(replayed).toBe(clean);
  });

  it('a sync requested mid-run hands the lease to a new sync job', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-handoff')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'h');
      const queue: Array<{ kind: string; id?: string; state?: SyncState }> = [];
      const h = syncHandler(deps(db, 'b1', {}, queue));
      let state: unknown = start('h');
      for (let n = 0; n < 2000; n++) {
        if ((state as SyncState).phase === 'release')
          await db.prepare(`UPDATE connection SET resync_requested = 1`).run();
        const r = await h(
          { id: 'h', kind: 'sync', connectionId: 'c1', state, attempts: 1, recurring: false },
          T + n,
        );
        if ('done' in r) break;
        state = r.state;
      }
      const next = queue.find((q) => q.kind === 'sync');
      expect(next?.state).toMatchObject({ phase: 'begin', handoffFrom: 'h', handoffDepth: 1 });
      expect(await db.prepare(`SELECT sync_lock FROM connection`).first('sync_lock')).toBe(next!.id);
    });
  });
});
