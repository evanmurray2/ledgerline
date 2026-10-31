// Go/no-go: an assignment edit in the first budget month after 36 simulated months with 60 categories — D1 queries,
// rows written and (Node) CPU. Writes .measure/budget.json. The workerd CPU of the same work comes from
// tools/measure/budget-kernel.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { test, expect } from 'vitest';
import { markDirty, recompute } from '../src/budget/recompute.js';
import { seedBudget } from '../src/measure/budget-seed.js';
import { cpu, freshDb, stats } from './harness.js';

test('budget edit in the first month', async () => {
  const db = freshDb();
  const d1 = db as unknown as D1Database;
  const seed = seedBudget();
  const now = Date.UTC(2026, 10, 14, 20);
  const B = 'b1';
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO budget (id, name, budget_start_month, time_zone, created_at, updated_at) VALUES (?1, 'B', ?2, 'America/Los_Angeles', 0, 0)`,
      )
      .bind(B, seed.startMonth),
  ]);
  const chunks = <T>(xs: T[], n: number) =>
    Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  for (const c of seed.categories) {
    await d1
      .prepare(
        `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?4, 0, 0)`,
      )
      .bind(c.id, B, c.kind, c.card_account_id)
      .run();
  }
  for (const ch of chunks(seed.assignments, 20)) {
    await d1.batch(
      ch.map((a) =>
        d1
          .prepare(
            `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, 0)`,
          )
          .bind(B, a.category_id, a.month, a.amount),
      ),
    );
  }
  for (const ch of chunks(seed.lines, 50)) {
    await d1.batch(
      ch.map((l) =>
        d1
          .prepare(
            `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .bind(B, ...l),
      ),
    );
  }
  const full = await recompute(d1, B, now, { force: true });
  expect(full.ok).toBe(true);

  // Full recompute to fill the cache (in chunks, as the Workflow does).
  for (let r = await recompute(d1, B, now, { force: true }); !r.done; r = await recompute(d1, B, now))
    expect(r.ok).toBe(true);
  const runs: number[] = [];
  const chunkRuns: number[] = [];
  let last = full;
  let rows = { read: 0, changes: 0 };
  let invocations = 0;
  for (let i = 0; i < 8; i++) {
    const r = await cpu(db, async () => {
      await d1.batch([
        d1
          .prepare(
            `UPDATE assignment SET amount = amount + 100, updated_at = ?3 WHERE budget_id = ?1 AND category_id = 'cat00' AND month = ?2`,
          )
          .bind(B, seed.startMonth, now),
        markDirty(d1, B, seed.startMonth as never, now),
      ]);
      return recompute(d1, B, now);
    });
    runs.push(r.ms);
    last = r.result;
    let reads = db.stats.rowsRead;
    let changes = db.stats.changes;
    invocations = 1;
    // The recompute Workflow continues in steps of MONTHS_PER_CHUNK months.
    while (!last.done) {
      const c = await cpu(db, () => recompute(d1, B, now));
      chunkRuns.push(c.ms);
      last = c.result;
      reads += db.stats.rowsRead;
      changes += db.stats.changes;
      invocations++;
    }
    rows = { read: reads, changes };
  }
  expect(last.rta).toBeTypeOf('number');
  const out = {
    months: seed.months.length,
    categories: seed.categories.length,
    budgetLines: seed.lines.length,
    assignments: seed.assignments.length,
    nodeCpuMsEditRequest: stats(runs),
    nodeCpuMsPerWorkflowChunk: stats(chunkRuns),
    invocationsPerEdit: invocations,
    d1CallsPerInvocation: last.queries + 1,
    monthsPerInvocation: last.monthsComputed,
    sqliteChangesPerEdit: rows.changes,
    rowsReadPerEdit: rows.read,
  };
  mkdirSync('.measure', { recursive: true });
  writeFileSync('.measure/budget.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
});
