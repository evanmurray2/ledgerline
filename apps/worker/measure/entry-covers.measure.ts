// CPU of processing with the batch order of docs/payee-names.md 9.2 (src/sync/pending-match.ts): after a
// 3,000-transaction history at 100 per page, a card gets 40 entries you added, 25 bank pending rows and 25 posted rows
// (10 with the provider's link, 10 like a pending row, 5 like an entry), as one sync's events. Measures the processing
// steps of that batch (steps 1–4 and the rest) and the heal step after it. Writes .measure/entry-covers.json for
// docs/measurements.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, rawPageKey } from '../src/sync/steps.js';
import { healPending, processPending } from '../src/sync/process.js';
import { cpu, freshDb, stats } from './harness.js';

const TOTAL = 3000;
const COUNT = 100;
const DATA = generate(TOTAL, 1);
const NOW = Date.parse('2026-11-02T20:00:00Z');

/** Applying a page only reads it: nothing here asks the bank. */
const provider = () =>
  new PlaidProvider({
    clientId: 'c',
    secret: 's',
    env: 'sandbox',
    fetch: () => Promise.reject(new Error('no bank calls in this measure')),
  });

const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);

test('processing CPU with entries, covers and "Same purchase?"', async () => {
  const db = freshDb();
  await db.batch([
    db
      .prepare(
        `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1','B','2023-11',?1,?1)`,
      )
      .bind(NOW),
    db
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
         VALUES ('con1','b1','plaid','Sandbox',?1,?1,?1)`,
      )
      .bind(NOW),
    ...['acc_checking', 'acc_savings', 'acc_credit'].map((a, i) =>
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at)
           VALUES (?1, 'b1', ?2, ?2, ?3, '2023-11-01', 0, ?4, ?4)`,
        )
        .bind(`a${i}`, a, i === 2 ? 'credit' : i === 1 ? 'savings' : 'checking', NOW),
    ),
  ]);
  const holder = 'run1';
  await acquire(db, 'con1', holder, NOW);
  const ctx = () => ({ db, connectionId: 'con1', budgetId: 'b1', holder, now: NOW });
  await beginRun(ctx(), 'measure');
  const p = provider();
  // The history's pages, staged as a bank update leaves them for applying (as test/bank-sync.ts does).
  let page = 0;
  for (let start = 0; start < TOTAL; start += COUNT, page++) {
    const body = syncBody(DATA, start, COUNT);
    const key = rawPageKey('b1', 'con1', holder, 0, page);
    const more = start + COUNT < TOTAL ? 1 : 0;
    await db.batch([
      db
        .prepare(
          `INSERT INTO raw_page (key, budget_id, body, sha256, bytes, created_at) VALUES (?1, 'b1', ?2, 'none', ?3, ?4)`,
        )
        .bind(key, body, body.length, NOW),
      db
        .prepare(
          `INSERT INTO sync_page (sync_run_id, page, budget_id, restart, raw_key, sha256, bytes, next_cursor, has_more, created_at)
           VALUES (?1, ?2, 'b1', 0, ?3, 'none', ?4, ?5, ?6, ?7)`,
        )
        .bind(holder, page, key, body.length, `cur${page}`, more, NOW),
    ]);
  }
  await db
    .prepare(`UPDATE sync_run SET pages_fetched = ?2, fetched_at = ?3, fetch_seq = 1 WHERE id = ?1`)
    .bind(holder, page, NOW)
    .run();
  for (let i = 0; i < page; i++)
    for (let ch = 0; ; ch++) if ((await applyPage(ctx(), p, holder, i, ch)).pageDone) break;
  for (;;) if ((await processPending({ DB: db } as never, 'b1', NOW)).caughtUp) break;

  // 40 entries on the card; the first 15 have the name the bank will send for a pending row.
  const entries = Array.from({ length: 40 }, (_, j) =>
    db
      .prepare(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, created_at, updated_at)
         VALUES (?1, 'b1', ?1, 'a2', 'pending', ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(
        `m:e${j}`,
        day(3 + (j % 6)),
        -(1000 + j * 137 + (j % 3) * 100),
        j < 15 ? `SHOP ${j}` : `Entry ${j}`,
        NOW,
      ),
  );
  // One sync's events: 25 pending rows, then 25 posted rows.
  let seq = (await db.prepare(`SELECT max(id) AS m FROM bank_event`).first<{ m: number }>())!.m;
  const rows: {
    id: string;
    amount: number;
    date: string;
    pending: number;
    link: string | null;
    name: string;
  }[] = [];
  for (let j = 0; j < 25; j++)
    rows.push({
      id: `pm_p${j}`,
      amount: -(1000 + j * 137),
      date: day(2 + (j % 6)),
      pending: 1,
      link: null,
      name: `SHOP ${j}`,
    });
  for (let j = 0; j < 25; j++)
    rows.push({
      id: `pm_q${j}`,
      amount: -(1000 + j * 137 + (j % 2) * 150),
      date: day(1),
      pending: 0,
      link: j < 10 ? `pm_p${j}` : null,
      name: j < 20 ? `SHOP ${j}` : `Entry ${j + 15}`,
    });
  const bank = rows.flatMap((r, i) => {
    seq++;
    return [
      db
        .prepare(
          `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, authorized_date, pending,
             pending_provider_txn_id, raw_name, plaid_name, payment_channel, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
           VALUES (?1, 'b1', 'con1', 'acc_credit', ?2, ?3, ?3, ?4, ?5, ?6, ?6, 'in store', 'p:' || ?1, ?7, ?7, ?8, ?8)`,
        )
        .bind(r.id, r.amount, r.date, r.pending, r.link, r.name, seq, NOW),
      db
        .prepare(
          `INSERT INTO bank_event (id, budget_id, connection_id, sync_run_id, page, position, apply_seq, kind, provider_txn_id,
             provider_account_id, payload, raw_ref, sha256, created_at)
           VALUES (?1, 'b1', 'con1', 'run_m', 0, ?2, ?1, 'added', ?3, 'acc_credit', '{}', 'x', 'x', ?4)`,
        )
        .bind(seq, i, r.id, NOW),
    ];
  });
  await db.batch([...entries, ...bank]);

  const processes: number[] = [];
  for (;;) {
    const r = await cpu(db, () => processPending({ DB: db } as never, 'b1', NOW));
    processes.push(r.ms);
    if (r.result.caughtUp) break;
  }
  const heals: number[] = [];
  for (let i = 0; i < 3; i++)
    heals.push((await cpu(db, () => healPending({ DB: db } as never, 'b1', 'con1', NOW))).ms);
  const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
  const out = {
    processSteps: processes.length,
    processMs: stats(processes),
    all: processes.map((x) => +x.toFixed(1)),
    healMs: stats(heals),
    covered: await n(`SELECT count(*) AS n FROM manual_pending WHERE covers_provider_txn_id IS NOT NULL`),
    matched: await n(`SELECT count(*) AS n FROM manual_pending WHERE matched_txn_key IS NOT NULL`),
    asked: await n(`SELECT count(*) AS n FROM alert WHERE type = 'same_purchase'`),
  };
  expect(out.covered + out.matched + out.asked).toBeGreaterThan(0);
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/entry-covers.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
