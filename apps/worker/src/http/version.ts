// budget.data_version moves whenever something a screen shows can change: every successful change through the API
// (bumpOnChange) and the daily jobs (bumpVersion). It reaches the phone with the budget row, and the phone's stored
// month totals (ledger/totals.ts) are stamped with it.
import type { MiddlewareHandler } from 'hono';
import type { Db } from '@ledgerline/db/sql';
import type { AppEnv } from './context.js';

/** Changes that don't alter any screen. */
const NO_BUMP = new Set(['/api/usage', '/api/notes']);

export async function bumpVersion(db: Db, budgetId: string): Promise<void> {
  await db.prepare(`UPDATE budget SET data_version = data_version + 1 WHERE id = ?1`).bind(budgetId).run();
}

/** After every successful change through the API: bump the version. */
export const bumpOnChange: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || c.res.status >= 400) return;
  const budgetId = c.get('budgetId');
  if (!budgetId || c.get('userId') === 'service' || NO_BUMP.has(new URL(c.req.url).pathname)) return;
  await bumpVersion(c.env.DB, budgetId);
};
