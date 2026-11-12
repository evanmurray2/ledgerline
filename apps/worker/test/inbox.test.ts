// The inbox (store/inbox.ts; docs/privacy.md 5.5, phase 4): the server's real sync job keeps the update it filed;
// a device takes it from the inbox, files it itself (local/file-run.ts), and ends with the server's rows.
import { PlaidProvider } from '@ledgerline/bank-provider';
import type { Db } from '@ledgerline/db/sql';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generate } from '../../../tools/plaid-mock/data.mjs';
import type { Env } from '../src/env.js';
import { fileRun } from '../src/local/file-run.js';
import { copyDb, Shadow } from '../src/local/shadow.js';
import { DurableDb } from '../src/store/adapter.js';
import type { BudgetStore } from '../src/store/budget-store.js';
import { inboxLatest, inboxNext, type InboxRun } from '../src/store/inbox.js';
import { JobRunner } from '../src/store/jobs.js';
import { syncHandler, type SyncState } from '../src/store/sync-job.js';
import { acquire } from '../src/sync/lease.js';
import { SYNC_TABLES } from '../src/sync-tables.js';
import { storeDb } from './store-db.js';

const e = env as unknown as Env & { BUDGET: DurableObjectNamespace<BudgetStore> };
const T = Date.parse('2026-11-14T20:00:00Z');
const B = 'b1';
const C = 'c1';
const PAGE = 100;
/** What the mock bank holds: the job fetches whatever is past its cursor, PAGE rows a page. */
const DATA = generate(260, 1) as { transaction_id: string }[];
let upTo = 0;

const provider = new PlaidProvider({
  clientId: 'c',
  secret: 's',
  env: 'sandbox',
  fetch: async (url, init) => {
    const json = (o: unknown) =>
      new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/accounts/get'))
      return json({
        accounts: [
          {
            account_id: 'acc_checking',
            name: 'Checking',
            type: 'depository',
            subtype: 'checking',
            balances: { current: 1234.56 + upTo, available: 1200, limit: null, iso_currency_code: 'USD' },
          },
        ],
      });
    if (String(url).includes('/liabilities/get')) return json({ liabilities: { credit: [] } });
    const body = JSON.parse(String(init?.body)) as { cursor?: string };
    const start = body.cursor ? Number(atob(body.cursor)) : 0;
    const added = DATA.slice(start, Math.min(start + PAGE, upTo));
    const next = start + added.length;
    return json({
      accounts: [],
      added,
      modified: [],
      removed: [],
      has_more: next < upTo,
      next_cursor: btoa(String(next)),
      request_id: 'r',
    });
  },
});

async function seed(db: Db): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1', 'B', '2023-11', 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at) VALUES ('c1', 'b1', 'plaid', 'Sandbox', 0, 0, 0)`,
    ),
    ...[
      ['acc_checking', 'checking'],
      ['acc_savings', 'savings'],
      ['acc_credit', 'credit'],
    ].flatMap(([pa, kind]) => [
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, created_at, updated_at) VALUES (?1 || 'b1', 'b1', ?1, ?1, ?2, '2023-11-01', 0, 0)`,
        )
        .bind(pa, kind),
      db
        .prepare(
          `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, type, created_at, updated_at) VALUES ('pa_' || ?1, 'b1', 'c1', ?1, ?1, 'depository', 0, 0)`,
        )
        .bind(pa),
    ]),
  ]);
}

/** Server bookkeeping a device doesn't write: the fetch state of the link, and the budget's own clock columns. */
const NOT_FILED: Record<string, string[]> = {
  connection: [
    'cursor',
    'status',
    'last_synced_at',
    'last_attempt_at',
    'error_code',
    'sync_lock',
    'lock_expires',
    'updated_at',
    'resync_requested',
  ],
  budget: ['updated_at', 'rta', 'summary_version', 'summary_month', 'summary_dirty_from', 'data_version'],
};
async function rows(db: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of [
    ...SYNC_TABLES.map((x) => ({ name: x.name, pk: x.pk })),
    { name: 'bank_event', pk: ['id'] },
    { name: 'bank_page', pk: ['sync_run_id', 'page'] },
  ]) {
    const skip = new Set(NOT_FILED[t.name] ?? []);
    const r = await db
      .prepare(`SELECT * FROM ${t.name} ORDER BY ${t.pk.join(', ')}`)
      .all<Record<string, unknown>>();
    out[t.name] = r.results.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !skip.has(k))),
    );
  }
  return out;
}

/** One whole bank update through the server's job, as an alarm would run it. */
async function serverSync(db: Db, st: DurableObjectState, n: number): Promise<void> {
  const holder = `sync:${n}`;
  expect(await acquire(db, C, holder, Date.now())).toBe(true);
  const runner: JobRunner = new JobRunner(st.storage, {
    sync: syncHandler({
      env: { ...e, DB: db },
      budgetId: B,
      provider: () => provider,
      token: async () => 'access-sandbox-x',
      pageSize: PAGE,
      budgetState: async () => 'normal',
      enqueue: (kind, o) => runner.enqueue(kind, o, Date.now()),
    }),
    recompute: async () => ({ done: true }),
  });
  const state: SyncState = { phase: 'begin', holder, trigger: 'test' };
  await runner.enqueue('sync', { id: holder, connectionId: C, state, runAt: T }, T);
  let now = T + n * 3_600_000;
  for (let i = 0; i < 2000 && runner.list().length; i++) {
    const o = await runner.runNext(now);
    if (o.ran && o.result === 'retry') throw new Error(`step failed: ${runner.list()[0]?.last_error}`);
    now += 1000;
  }
  expect(runner.list()).toEqual([]);
}

describe('the inbox', () => {
  it('keeps each update the server filed, and a device that files them ends with the server’s rows', async () => {
    const after: Record<string, unknown[]>[] = [];
    const inbox: InboxRun[] = [];
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('inbox-server')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db);
      // Two updates: 150 rows over two pages, then 110 more.
      for (const [n, total] of [
        [1, 150],
        [2, 260],
      ] as const) {
        upTo = total;
        await serverSync(db, st, n);
        after.push(await rows(db));
      }
      expect(await inboxLatest(db)).toBe(2);
      for (let seq = 0; ;) {
        const run = await inboxNext(db, seq);
        if (!run) break;
        inbox.push(run);
        seq = run.fetchSeq;
      }
    });
    expect(inbox.map((r) => [r.fetchSeq, r.pages.length, r.bank?.accounts.length])).toEqual([
      [1, 2, 1],
      [2, 2, 1],
    ]);
    // Nothing but the update happened while the server filed it.
    expect(inbox.every((r) => r.baseVersion === r.endVersion)).toBe(true);

    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('inbox-device')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db);
      for (const [i, run] of inbox.entries()) {
        await fileRun({ ...e, DB: db }, B, run, provider);
        const mine = await rows(db);
        for (const table of Object.keys(mine))
          expect(mine[table], `${table} after update ${i + 1}`).toEqual(after[i]![table]);
      }
      expect((await db.prepare(`SELECT count(*) AS n FROM bank_txn`).first<{ n: number }>())!.n).toBe(260);
    });
  });

  it('holds back an update the server is still filing, and the ones after it', async () => {
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('inbox-open')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await db
        .prepare(
          `INSERT INTO inbox_run (fetch_seq, run_id, connection_id, fetched_at, pages, base_version, end_version, created_at)
           VALUES (1, 'r1', 'c1', 5, '[]', 0, 0, 5), (2, 'r2', 'c1', 6, '[]', 0, NULL, 6), (3, 'r3', 'c1', 7, '[]', 0, 0, 7)`,
        )
        .run();
      expect((await inboxNext(db, 0))?.fetchSeq).toBe(1);
      expect(await inboxNext(db, 1)).toBeNull();
    });
  });

  // The shadow run (local/shadow.ts): the device files the inbox on a scratch copy while its real copy takes the
  // server's rows as always; then the two are compared.
  it('a shadow run on a scratch copy finds no difference, and says when a comparison means nothing', async () => {
    const server = storeDb('shadow-server');
    const main = storeDb('shadow-main');
    const inbox: InboxRun[] = [];
    await seed(main);
    await runInDurableObject(e.BUDGET.get(e.BUDGET.idFromName('shadow-server')), async (_o, st) => {
      const db = new DurableDb(st.storage);
      await seed(db);
      for (const [n, total] of [
        [1, 120],
        [2, 200],
      ] as const) {
        upTo = total;
        await serverSync(db, st, n);
      }
      for (let seq = 0; ;) {
        const run = await inboxNext(db, seq);
        if (!run) break;
        inbox.push(run);
        seq = run.fetchSeq;
      }
    });
    expect(inbox.length).toBe(2);
    let forks = 0;
    const forkOf = (copy: Db) => async () => {
      const scratch = storeDb(`shadow-scratch-${++forks}`);
      await copyDb(copy, scratch);
      return { db: scratch };
    };

    // The scratch copy is made before the real copy takes the server's rows (as a sync does); then the updates
    // are filed on it and the two are compared.
    const shadow = await Shadow.fork(main, B, forkOf(main));
    await copyDb(server, main);
    expect(await shadow.begin(inbox)).toBeNull();
    while (await shadow.step());
    expect(await shadow.end(main)).toEqual({ runs: 2, compared: true, differences: [] });

    // A difference is found and named by table and column, with no row's content.
    const again = await Shadow.fork(main, B, forkOf(await seeded('shadow-main-2')));
    expect(await again.begin(inbox)).toBeNull();
    while (await again.step());
    await main
      .prepare(`UPDATE bank_txn SET amount = amount + 1 WHERE provider_txn_id = ?1`)
      .bind(DATA[0]!.transaction_id)
      .run();
    expect(await again.end(main)).toEqual({
      runs: 2,
      compared: true,
      differences: [{ table: 'bank_txn', column: 'amount', rows: 1 }],
    });

    // The copy was not where the server began (an edit moved the data version): nothing is filed.
    const edited = await seeded('shadow-main-4');
    await edited.prepare(`UPDATE budget SET data_version = data_version + 1`).run();
    const before = await Shadow.fork(edited, B, forkOf(edited));
    expect(await before.begin(inbox)).toMatchObject({ compared: false, why: 'edited_before' });
    expect(await before.end(main)).toMatchObject({ compared: false, why: 'failed' });
    // An edit landed while the server filed an update.
    const mixed = [{ ...inbox[0]!, endVersion: inbox[0]!.baseVersion + 1 }, inbox[1]!];
    const during = await Shadow.fork(main, B, forkOf(await seeded('shadow-main-5')));
    expect(await during.begin(mixed)).toMatchObject({ why: 'edited_during' });
    // An edit after the last update is in the real copy only.
    const late = await Shadow.fork(main, B, forkOf(await seeded('shadow-main-6')));
    expect(await late.begin(inbox)).toBeNull();
    while (await late.step());
    await main.prepare(`UPDATE budget SET data_version = data_version + 1`).run();
    expect(await late.end(main)).toMatchObject({ runs: 2, compared: false, why: 'edited_after' });
  });
});

/** A copy as it is before any update. */
async function seeded(name: string): Promise<Db> {
  const db = storeDb(name);
  await seed(db);
  return db;
}
