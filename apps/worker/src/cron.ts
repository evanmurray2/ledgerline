// Three cron triggers (of the five allowed): sync backstop every 4 hours, the daily stale-pending scan (which also
// brings due Upcoming entries into the budget), and the daily maintenance job.
import { localDate, type Month } from '@ledgerline/domain';
import type { Env } from './env.js';
import { startSync } from './routes/settings.js';
import { clock } from './http/clock.js';
import { Scoped } from './db/scoped.js';
import { budgetMeta, planLineRebuild } from './ledger/ledger.js';
import { recompute } from './budget/recompute.js';
import { refreshUsage } from './ops/usage.js';
import { ulid } from '@ledgerline/platform';
import { bumpVersion } from './http/etag.js';

export const CRON_BACKSTOP = '7 */4 * * *';
export const CRON_DAILY_SCAN = '10 8 * * *';
export const CRON_MAINTENANCE = '20 10 * * *';

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const now = clock(env);
  if (controller.cron === CRON_MAINTENANCE) {
    for (const b of (await env.DB.prepare(`SELECT id FROM budget`).all<{ id: string }>()).results) {
      const day = new Date(now).toISOString().slice(0, 10);
      try {
        await env.MAINTENANCE.create({ id: `maint-${b.id}-${day}`, params: { day, budgetId: b.id } });
      } catch (e) {
        if (!/already exists/i.test(String(e))) throw e;
      }
    }
    return;
  }
  if (controller.cron === CRON_DAILY_SCAN) {
    for (const b of (await env.DB.prepare(`SELECT id FROM budget`).all<{ id: string }>()).results)
      await dailyScan(env, b.id, now);
    return;
  }
  // Backstop: any connection without a successful sync in the last 4 hours, or with a request left by a failed run.
  await refreshUsage(env, now).catch(() => null);
  const due = await env.DB.prepare(
    `SELECT id, budget_id FROM connection WHERE removed_at IS NULL AND provider = 'plaid' AND status != 'login_required'
       AND (last_synced_at IS NULL OR last_synced_at < ?1 OR resync_requested = 1)`,
  )
    .bind(now - 4 * 3_600_000)
    .all<{ id: string; budget_id: string }>();
  for (const c of due.results) await startSync(env, c.budget_id, c.id, 'cron').catch(() => false);
}

/** Upcoming entries count from their date; repeating ones schedule their next occurrence. Vanished pending rows get an alert. */
export async function dailyScan(
  env: Env,
  budgetId: string,
  now: number,
  opts: { recompute?: boolean } = {},
): Promise<{ materialized: number }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const meta = await budgetMeta(s);
  if (!meta) return { materialized: 0 };
  const today = localDate(now, meta.timeZone);
  const due = await s.all<{
    txn_key: string;
    repeats: string;
    date: string;
    account_id: string;
    amount: number;
    payee_name: string;
  }>(
    `SELECT m.txn_key, m.repeats, m.date, m.account_id, m.amount, m.payee_name FROM manual_pending m
     WHERE m.budget_id = ?1 AND m.kind = 'upcoming' AND m.deleted_at IS NULL AND m.date <= ?2
       AND NOT EXISTS (SELECT 1 FROM budget_line l WHERE l.budget_id = m.budget_id AND l.txn_key = m.txn_key) LIMIT 40`,
    today,
  );
  const w: D1PreparedStatement[] = [];
  for (const d of due) {
    if (d.repeats === 'never') continue;
    const [y, mo, dd] = d.date.split('-').map(Number) as [number, number, number];
    const next =
      d.repeats === 'monthly'
        ? new Date(Date.UTC(y, mo, Math.min(dd, 28)))
        : new Date(Date.UTC(y + 1, mo - 1, dd));
    const key = `m:${ulid(now)}`;
    w.push(
      s.q(
        `INSERT INTO manual_pending (id, budget_id, txn_key, account_id, kind, date, amount, payee_name, repeats, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'upcoming', ?5, ?6, ?7, ?8, ?9, ?9)`,
        ulid(now),
        key,
        d.account_id,
        next.toISOString().slice(0, 10),
        d.amount,
        d.payee_name,
        d.repeats,
        now,
      ),
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, category_id, categorized_by, created_at, updated_at)
         SELECT ?2, budget_id, category_id, categorized_by, ?3, ?3 FROM txn_overlay WHERE budget_id = ?1 AND txn_key = ?4`,
        key,
        now,
        d.txn_key,
      ),
      s.q(`UPDATE manual_pending SET repeats = 'never' WHERE budget_id = ?1 AND txn_key = ?2`, d.txn_key),
    );
  }
  // Bank pending rows removed with no posted successor after 5 days: usually a released hold.
  w.push(
    s.q(
      `INSERT OR IGNORE INTO alert (id, budget_id, type, ref_key, data, created_at)
       SELECT 'vp:' || o.txn_key, o.budget_id, 'vanished_pending', o.txn_key, '{}', ?2 FROM txn_overlay o
       WHERE o.budget_id = ?1 AND o.orphaned_at IS NOT NULL AND o.orphaned_at < ?2 - 5 * 86400000
         AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.txn_key = o.txn_key AND b.removed_at IS NULL)`,
      now,
    ),
  );
  if (w.length) await s.batch(w);
  const keys = due.map((d) => d.txn_key);
  if (keys.length) {
    const plan = await planLineRebuild(s, keys, meta, today, now);
    await s.batch(plan.stmts);
  }
  // The job runner recomputes in its own small steps instead (docs/multi-user.md 6.1).
  if (opts.recompute !== false) await recompute(env.DB, budgetId, now);
  await bumpVersion(env.DB, budgetId);
  return { materialized: keys.length };
}

export type { Month };
