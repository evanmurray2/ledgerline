// CPU of one step of the one-time plaid_name fill (src/sync/fill-plaid-name.ts, docs/payee-names.md 8.1): a
// 3,000-transaction history staged and applied at 100 and 500 per page, every plaid_name cleared as before migration
// 0007, then the job run to the end. Writes .measure/fill-plaid-name.json for docs/measurements.md.
import { writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PlaidProvider } from '@ledgerline/bank-provider';
import { generate, syncBody } from '../../../tools/plaid-mock/data.mjs';
import { acquire } from '../src/sync/lease.js';
import { applyPage, beginRun, fetchPage } from '../src/sync/steps.js';
import { fillPlaidNameStep, type FillPlaidNameState } from '../src/sync/fill-plaid-name.js';
import { cpu, freshDb, stats } from './harness.js';

const TOTAL = 3000;
const DATA = generate(TOTAL, 1);

function provider(count: number): PlaidProvider {
  const bodies = new Map<number, string>();
  for (let s = 0; s < TOTAL; s += count) bodies.set(s, syncBody(DATA, s, count));
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

test('plaid_name fill step CPU', async () => {
  const out: Record<string, unknown> = {};
  for (const count of [100, 500]) {
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
    ]);
    const holder = 'run1';
    await acquire(db, 'con1', holder, now);
    const ctx = () => ({ db, connectionId: 'con1', budgetId: 'b1', holder, now: Date.now() });
    await beginRun(ctx(), 'measure');
    const p = provider(count);
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      const r = await fetchPage(ctx(), p, 'access-sandbox-x', holder, 0, page, cursor, count);
      if (r.kind !== 'page') throw new Error('mutation');
      cursor = r.nextCursor;
      page++;
      if (!r.hasMore) break;
    }
    for (let i = 0; i < page; i++)
      for (let ch = 0; ; ch++) if ((await applyPage(ctx(), p, holder, i, ch)).pageDone) break;
    await db.prepare(`UPDATE bank_txn SET plaid_name = NULL`).run();
    const steps: number[] = [];
    let state: FillPlaidNameState = {};
    for (;;) {
      const r = await cpu(db, () => fillPlaidNameStep(db, 'b1', state));
      steps.push(r.ms);
      if (r.result.done) break;
      state = r.result.state;
    }
    const left = await db
      .prepare(`SELECT count(*) AS n FROM bank_txn WHERE plaid_name IS NULL`)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    out[count] = { pages: page, steps: steps.length, stepMs: stats(steps) };
  }
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/fill-plaid-name.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
