// CPU of the payee filing that changed in docs/payee-names.md PR 2: the processing step (step 5 files rows by
// Plaid's keys, sync/file-fresh.ts) and one step of the one-time re-file job (sync/refile-payees.ts), on a
// 3,000-transaction history at 100 per page. For the job, every payee is first turned back into one the old rules
// made (named_by 'user', its keys gone), so every transaction is filed again. Writes .measure/refile-payees.json for
// docs/measurements.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { refilePayeesStep, type RefileState } from '../src/sync/refile-payees.js';
import { cpu, freshDb, stats } from './harness.js';

const TOTAL = 3000;
const COUNT = 100;
const DATA = generate(TOTAL, 1);

function provider(): PlaidProvider {
  const bodies = new Map<number, string>();
  for (let s = 0; s < TOTAL; s += COUNT) bodies.set(s, syncBody(DATA, s, COUNT));
  return new PlaidProvider({
    clientId: 'c',
    secret: 's',
    env: 'sandbox',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      const start = body.cursor ? Number(Buffer.from(body.cursor, 'base64').toString()) : 0;
      return new Response(bodies.get(start)!, { status: 200 });
    },
  });
}

test('payee filing CPU: processing step and re-file job step', async () => {
  const out: Record<string, unknown> = {};
  const db = freshDb();
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1','B','2023-11',?1,?1)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO connection (id, budget_id, provider, institution_name, linked_at, created_at, updated_at)
         VALUES ('con1','b1','plaid','Sandbox',?1,?1,?1)`,
      )
      .bind(now),
    ...['acc_checking', 'acc_savings', 'acc_credit'].map((a, i) =>
      db
        .prepare(
          `INSERT INTO account (id, budget_id, provider_account_id, name, kind, budget_from, starting_balance, created_at, updated_at)
           VALUES (?1, 'b1', ?2, ?2, ?3, '2023-11-01', 0, ?4, ?4)`,
        )
        .bind(`a${i}`, a, i === 2 ? 'credit' : i === 1 ? 'savings' : 'checking', now),
    ),
  ]);
  const holder = 'run1';
  await acquire(db, 'con1', holder, now);
  const ctx = () => ({ db, connectionId: 'con1', budgetId: 'b1', holder, now: Date.now() });
  await beginRun(ctx(), 'measure');
  const p = provider();
  let cursor: string | null = null;
  let page = 0;
  for (;;) {
    const r = await fetchPage(ctx(), p, 'access-sandbox-x', holder, 0, page, cursor, COUNT);
    if (r.kind !== 'page') throw new Error('mutation');
    cursor = r.nextCursor;
    page++;
    if (!r.hasMore) break;
  }
  for (let i = 0; i < page; i++)
    for (let ch = 0; ; ch++) if ((await applyPage(ctx(), p, holder, i, ch)).pageDone) break;
  const processes: number[] = [];
  for (;;) {
    const r = await cpu(db, () => processPending({ DB: db } as never, 'b1'));
    processes.push(r.ms);
    if (r.result.caughtUp) break;
  }
  const payees = (await db.prepare(`SELECT count(*) AS n FROM payee`).first<{ n: number }>())!.n;
  // As before the job: every payee named_by 'user' (the column's default), with only an old cleaned-text alias.
  await db.batch([
    db.prepare(`UPDATE payee SET named_by = 'user'`),
    db.prepare(`DELETE FROM payee_alias`),
    db.prepare(
      `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at)
       SELECT 'old_' || id, budget_id, upper(replace(name, ' ', '')), NULL, id, 0 FROM payee`,
    ),
  ]);
  const steps: number[] = [];
  const t = Date.now();
  let state: RefileState = {};
  for (;;) {
    const r = await cpu(db, () => refilePayeesStep(db, 'b1', 'once:refile_payees', state, t));
    steps.push(r.ms);
    if (r.result.done) break;
    state = r.result.state;
    if (steps.length > 500) throw new Error('job did not finish');
  }
  const audit = await db
    .prepare(`SELECT after FROM audit_log WHERE action = 'payee.refile'`)
    .first<{ after: string }>();
  expect(audit).not.toBeNull();
  out.process = { steps: processes.length, stepMs: stats(processes) };
  out.refile = { payees, steps: steps.length, stepMs: stats(steps), result: JSON.parse(audit!.after) };
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/refile-payees.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
