// Go/no-go: CPU of one fetch step and one apply step at count 500, 250 and 100, and the totals for a
// 3,000-transaction backfill. Writes .measure/sync.json for docs/measurements.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { encryptToken, parseKeyring } from '@ledgerline/platform';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { processPending } from '../src/sync/process.js';
import { cpu, freshDb, MemR2, stats } from './harness.js';

const TOTAL = 3000;
const DATA = generate(TOTAL, 1);

/** Bodies are generated before measuring: producing them is Plaid's work, not the Worker's. */
function provider(count: number): PlaidProvider {
  const bodies = new Map<number, string>();
  for (let s = 0; s < TOTAL; s += count) bodies.set(s, syncBody(DATA, s, count));
  return new PlaidProvider({
    clientId: 'c',
    secret: 's',
    env: 'sandbox',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { cursor?: string; count: number };
      const start = body.cursor ? Number(Buffer.from(body.cursor, 'base64').toString()) : 0;
      return new Response(bodies.get(start)!, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('sync steps CPU', async () => {
  const out: Record<string, unknown> = {};
  for (const count of [500, 250, 100]) {
    const db = freshDb();
    const raw = new MemR2();
    const d1 = db as unknown as D1Database;
    const now = Date.now();
    const ring = parseKeyring('1:' + Buffer.alloc(32, 7).toString('base64'), '1');
    const tok = await encryptToken(ring, 'access-sandbox-x', 'con1');
    await d1.batch([
      d1
        .prepare(
          `INSERT INTO budget (id, name, budget_start_month, created_at, updated_at) VALUES ('b1','B','2023-11',?1,?1)`,
        )
        .bind(now),
      d1
        .prepare(
          `INSERT INTO connection (id, budget_id, provider, institution_name, access_token_enc, key_version, linked_at, created_at, updated_at)
           VALUES ('con1','b1','plaid','Sandbox',?1,1,?2,?2,?2)`,
        )
        .bind(tok.enc, now),
    ]);
    const holder = 'run1';
    await acquire(d1, 'con1', holder, now);
    const ctx = () => ({
      db: d1,
      raw: raw as unknown as R2Bucket,
      connectionId: 'con1',
      budgetId: 'b1',
      holder,
      now: Date.now(),
    });
    await beginRun(ctx(), 'measure');
    const p = provider(count);
    const fetches: number[] = [];
    const fetchQueries: number[] = [];
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      const r = await cpu(db, () => fetchPage(ctx(), p, 'access-sandbox-x', holder, 0, page, cursor, count));
      fetches.push(r.ms);
      fetchQueries.push(r.queries);
      if (r.result.kind !== 'page') throw new Error('mutation');
      cursor = r.result.nextCursor;
      page++;
      if (!r.result.hasMore) break;
    }
    const applies: number[] = [];
    const applyQueries: number[] = [];
    let statements = 0;
    for (let i = 0; i < page; i++) {
      const r = await cpu(db, () => applyPage(ctx(), p, holder, i));
      applies.push(r.ms);
      applyQueries.push(r.queries);
      statements = Math.max(statements, r.result.statements);
    }
    const processes: number[] = [];
    for (;;) {
      const r = await cpu(db, () => processPending({ DB: d1 } as never, 'b1'));
      processes.push(r.ms);
      if (r.result.caughtUp) break;
    }
    const n = (await d1.prepare('SELECT count(*) AS n FROM bank_txn').first<{ n: number }>())!.n;
    out[count] = {
      pages: page,
      txns: n,
      fetchMs: stats(fetches),
      applyMs: stats(applies),
      processMs: stats(processes),
      queriesPerFetch: Math.max(...fetchQueries),
      queriesPerApply: Math.max(...applyQueries),
      statementsPerApplyBatch: statements,
      // Workflow steps for this backfill: begin + per page (budget check + fetch + budget check + apply) +
      // process steps + finalize + release.
      workflowSteps: 1 + page * 4 + processes.length + 2,
      plaidCalls: page,
    };
  }
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/sync.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
