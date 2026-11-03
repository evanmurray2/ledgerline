// What the phone's engine does after a sync (local/engine.ts derive(), D-45), run on a test database: rebuild every
// transaction's budget lines and recompute every month. Tests that build a budget by hand (no accounts' starting
// balances, so no start lines to rebuild) check the server's rows through this.
import type { Db } from '@ledgerline/db/sql';
import { localDate } from '@ledgerline/domain';
import { Scoped } from '../src/db/scoped.js';
import { budgetMeta, chunks, planLineRebuild } from '../src/ledger/ledger.js';
import { recompute } from '../src/budget/recompute.js';

export async function workOut(db: Db, budgetId: string, now: number): Promise<{ rta: number }> {
  const s = new Scoped(db, budgetId, 'test');
  const meta = await budgetMeta(s);
  if (!meta) return { rta: 0 };
  const today = localDate(now, meta.timeZone);
  // Live transactions, and any whose rows went away (their old lines must go too).
  const keys = (
    await s.all<{ key: string }>(
      `SELECT key FROM v_transaction WHERE budget_id = ?1
       UNION SELECT txn_key FROM budget_line WHERE budget_id = ?1 AND txn_key NOT LIKE 'start:%'`,
    )
  ).map((r) => r.key);
  for (const part of chunks(keys, 450)) {
    const plan = await planLineRebuild(s, part, meta, today, now);
    if (plan.stmts.length) await s.batch(plan.stmts);
  }
  let r = await recompute(db, budgetId, now, { force: true, fullFrom: true, maxMonths: 1200 });
  for (let i = 0; !r.done && i < 20; i++) r = await recompute(db, budgetId, now, { maxMonths: 1200 });
  return { rta: r.rta };
}
