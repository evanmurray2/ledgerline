// Conditional GETs: every screen response carries an ETag built from counters that change whenever anything it
// shows can change. The browser revalidates with If-None-Match, and an unchanged screen costs a couple of rows
// read instead of the whole screen (the free plan allows 5 million rows read a day; docs/measurements.md).
//
// What moves the tag:
// - budget.data_version: every successful change through the API (bumpOnChange) and the daily jobs (bumpVersion)
// - apply_counter.seq: new bank rows applied by a sync; budget.processed_through: those rows processed
// - budget.summary_version, rta, summary_month, summary_dirty_from: recomputes
// - connections' updated_at and last_synced_at: sync results, balances, repairs
// - today's date in the budget's time zone, and the deployed app version
import type { Db } from '@ledgerline/db/sql';
import type { MiddlewareHandler } from 'hono';
import { localDate } from '@ledgerline/domain';
import type { AppEnv } from './context.js';
import { clock } from './clock.js';

/** GETs that don't use the ETag: sign-in state, session (it carries the live usage brake), health and exports. */
const SKIP = [
  /^\/api\/session$/,
  /^\/api\/sync/,
  /^\/api\/settings\/security/,
  /^\/api\/health$/,
  /^\/api\/export\//,
  /^\/api\/auth\//,
];
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

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const etags: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const budgetId = c.get('budgetId');
  if (c.req.method !== 'GET' || !budgetId || c.get('userId') === 'service' || SKIP.some((r) => r.test(path)))
    return next();
  const v = await c.env.DB.prepare(
    `SELECT b.data_version, b.summary_version, b.processed_through, b.rta, b.summary_month, b.summary_dirty_from, b.time_zone,
       (SELECT seq FROM apply_counter WHERE id = 1) AS applied,
       (SELECT max(coalesce(max(updated_at), 0), coalesce(max(last_synced_at), 0)) FROM connection WHERE budget_id = ?1) AS conn
     FROM budget b WHERE b.id = ?1`,
  )
    .bind(budgetId)
    .first<Record<string, unknown> & { time_zone: string }>();
  if (!v) return next();
  const today = localDate(clock(c.env), v.time_zone);
  const tag = `W/"${fnv(JSON.stringify([Object.values(v), today, c.env.APP_VERSION ?? '']))}"`;
  const headers = { etag: tag, 'cache-control': 'private, no-cache' };
  if (c.req.header('if-none-match') === tag) return c.body(null, 304, headers);
  await next();
  if (c.res.status === 200) for (const [k, val] of Object.entries(headers)) c.res.headers.set(k, val);
};
