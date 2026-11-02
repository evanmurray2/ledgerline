// Bank sync as an alarm job (docs/multi-user.md 6.1), inside a real Durable Object. The same handler run against
// D1 and against the adapter must produce identical rows: moving the data changes nothing about what a sync writes.
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { generate } from '../../../tools/plaid-mock/data.mjs';
import { SqlD1 } from '../src/store/adapter.js';
import { JobRunner } from '../src/store/jobs.js';
import {
  nextUtcMidnight,
  recomputeHandler,
  syncHandler,
  type SyncDeps,
  type SyncState,
} from '../src/store/sync-job.js';
import { CHUNK } from '../src/sync/steps.js';
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

const saved = { ...CHUNK };
beforeAll(() => {
  CHUNK.apply = 25;
  CHUNK.process = 25;
});
afterAll(() => Object.assign(CHUNK, saved));

async function seed(db: D1Database, B: string, C: string): Promise<void> {
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

function deps(db: D1Database, B: string, over: Partial<SyncDeps> = {}, queue: unknown[] = []): SyncDeps {
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

async function acquireFor(db: D1Database, C: string, holder: string): Promise<void> {
  const { acquire } = await import('../src/sync/lease.js');
  expect(await acquire(db, C, holder, Date.now())).toBe(true);
}

const start = (holder: string): SyncState => ({ phase: 'begin', holder, trigger: 'test' });

/** Drives the handler step by step without a runner (works on D1 too). */
async function drive(d: SyncDeps, C: string, holder: string): Promise<number> {
  const h = syncHandler(d);
  let state: unknown = start(holder);
  for (let n = 1; n < 2000; n++) {
    const r = await h(
      { id: holder, kind: 'sync', connectionId: C, state, attempts: 1, recurring: false },
      T + n,
    );
    if ('done' in r) return n;
    state = r.state;
  }
  throw new Error('sync did not finish');
}

const HASH_SQL = {
  txns: `SELECT group_concat(provider_txn_id || ':' || amount || ':' || date || ':' || txn_key, ',') AS h
         FROM (SELECT * FROM bank_txn ORDER BY provider_txn_id)`,
  lines: `SELECT count(*) || ':' || coalesce(sum(amount), 0) AS h FROM budget_line`,
};

describe('sync job', () => {
  it('writes exactly the same rows on D1 and on the adapter', async () => {
    const D1 = e.DB;
    await seed(D1, 'b_job_d1', 'con_job_d1');
    await acquireFor(D1, 'con_job_d1', 'run-d1');
    await drive(deps(D1, 'b_job_d1'), 'con_job_d1', 'run-d1');
    const onD1 = {
      txns: await D1.prepare(
        HASH_SQL.txns.replace('FROM bank_txn', `FROM bank_txn WHERE budget_id = 'b_job_d1'`),
      ).first('h'),
      lines: await D1.prepare(HASH_SQL.lines + ` WHERE budget_id = 'b_job_d1'`).first('h'),
    };
    const inStore = await runInDurableObject(
      e.BUDGET.get(e.BUDGET.idFromName('sync-parity')),
      async (_o, st) => {
        const db = new SqlD1(st.storage) as unknown as D1Database;
        await seed(db, 'b_job_d1', 'con_job_d1');
        await acquireFor(db, 'con_job_d1', 'run-d1');
        await drive(deps(db, 'b_job_d1'), 'con_job_d1', 'run-d1');
        return {
          txns: await db.prepare(HASH_SQL.txns).first('h'),
          lines: await db.prepare(HASH_SQL.lines).first('h'),
        };
      },
    );
    expect(String(onD1.txns).split(',')).toHaveLength(TOTAL);
    expect(onD1.lines).not.toBe('0:0'); // budget lines were built, so they are really compared
    expect(inStore).toEqual(onD1);
  });

  it('runs to completion through the alarm runner: rows applied, run done, lease released, recompute queued and run', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-runner')), async (_o, st) => {
      const db = new SqlD1(st.storage) as unknown as D1Database;
      await seed(db, 'b1', 'c1');
      await acquireFor(db, 'c1', 'sync:1');
      let runner!: JobRunner;
      const d = deps(db, 'b1', {
        enqueue: (kind, o) => runner.enqueue(kind, o, Date.now()),
      });
      runner = new JobRunner(st.storage, { sync: syncHandler(d), recompute: recomputeHandler(db, 'b1') });
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

  it('pauses until 00:00 UTC when the account is near its daily limit, keeping the lease', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-pause')), async (_o, st) => {
      const db = new SqlD1(st.storage) as unknown as D1Database;
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
      const db = new SqlD1(st.storage) as unknown as D1Database;
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

  it('a sync requested mid-run hands the lease to a new sync job', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('sync-handoff')), async (_o, st) => {
      const db = new SqlD1(st.storage) as unknown as D1Database;
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
