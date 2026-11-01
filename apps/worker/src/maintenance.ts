// The daily maintenance job (Sync spec: Daily maintenance job): full recompute with drift report and the rule 10
// identity assertion, post-sync catch-up, usage roll-up and pruning, account-wide D1 usage, and the watchdog.
// Each step is sized for 10 ms of CPU.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  type Month,
  type StoredMonth,
  addMonths,
  computeBudget,
  cents,
  currentMonth,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Env, MaintenanceParams } from './env.js';
import { recompute } from './budget/recompute.js';
import { processPending } from './sync/process.js';
import { refreshUsage } from './ops/usage.js';
import { clock } from './http/clock.js';
import { Scoped } from './db/scoped.js';
import { lineFromRow } from './budget/recompute.js';

const STEP = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
  timeout: '2 minutes' as const,
};

export class MaintenanceWorkflow extends WorkflowEntrypoint<Env, MaintenanceParams> {
  override async run(event: WorkflowEvent<MaintenanceParams>, step: WorkflowStep): Promise<unknown> {
    const env = this.env;
    const b = event.payload.budgetId;
    // 1. Full recompute from budget start; any month that changes without a pending edit is drift.
    const dirtyBefore = await step.do('drift-check-start', STEP, async () => {
      const r = await env.DB.prepare(`SELECT summary_dirty_from FROM budget WHERE id = ?1`)
        .bind(b)
        .first<{ summary_dirty_from: string | null }>();
      return r?.summary_dirty_from ?? null;
    });
    let written = 0;
    for (let i = 0; i < 60; i++) {
      const r = await step.do(`recompute-${i}`, STEP, () =>
        recompute(env.DB, b, clock(env), i === 0 ? { force: true, fullFrom: true } : {}),
      );
      written += r.monthsWritten;
      if (r.done || !r.ok) break;
    }
    const identity = await step.do('identity', STEP, () => checkIdentityDb(env, b));
    await step.do('drift-record', STEP, async () => {
      const now = clock(env);
      const stmts = [
        env.DB.prepare(
          `INSERT INTO health_status (budget_id, key, value, at) VALUES (?1, 'last_recompute', ?2, ?3) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
        ).bind(
          b,
          JSON.stringify({ monthsChanged: written, drift: dirtyBefore === null && written > 0, identity }),
          now,
        ),
      ];
      if (!identity.ok) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?1, ?2, 'identity', ?3, ?4, ?5) ON CONFLICT (budget_id, type, ref_key) DO UPDATE SET data = excluded.data`,
          ).bind(ulid(now), b, new Date(now).toISOString().slice(0, 10), JSON.stringify(identity), now),
        );
        console.log(JSON.stringify({ event: 'identity_failed', count: identity.difference }));
      }
      await env.DB.batch(stmts);
    });
    // 2. Post-sync catch-up from the watermark.
    for (let i = 0; i < 100; i++) {
      const r = await step.do(`catch-up-${i}`, STEP, () => processPending(env, b, clock(env)));
      if (r.caughtUp) break;
    }
    // 3. Usage roll-up into usage_daily; prune raw events older than 90 days.
    await step.do('usage-rollup', STEP, () => rollUpUsage(env, b, clock(env)));
    // 4. Account-wide D1 usage from the GraphQL Analytics API.
    await step.do('usage-refresh', STEP, () => refreshUsage(env, clock(env), true));
    // 5. Watchdog.
    await step.do('watchdog', STEP, () => watchdog(env, b, clock(env)));
    // Housekeeping: staging rows of finished runs.
    await step.do('prune-staging', STEP, async () => {
      await env.DB.prepare(
        `DELETE FROM sync_page WHERE sync_run_id IN (SELECT id FROM sync_run WHERE phase IN ('done', 'failed') AND budget_id = ?1)`,
      )
        .bind(b)
        .run();
    });
    return { ok: true };
  }
}

/** Rule 10 on the stored data: working balances vs categories + RTA + held amounts − unbudgeted card debt + later months. */
export async function checkIdentityDb(
  env: Env,
  budgetId: string,
): Promise<{ ok: boolean; difference: number; literal: boolean }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const now = clock(env);
  const b = await s.first<{ budget_start_month: string | null; time_zone: string; rta: number }>(
    `SELECT budget_start_month, time_zone, rta FROM budget WHERE id = ?1`,
  );
  if (!b?.budget_start_month) return { ok: true, difference: 0, literal: true };
  const cur = currentMonth(now, b.time_zone);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: b.time_zone }).format(now);
  const prev = addMonths(cur, -1);
  const [work, held, snaps, curLines, cats] = await s.batch([
    s.q(
      `SELECT (SELECT coalesce(sum(starting_balance), 0) FROM account WHERE budget_id = ?1) +
              (SELECT coalesce(sum(amount), 0) FROM v_transaction WHERE budget_id = ?1 AND wont_clear = 0 AND (date >= budget_from OR pending_at_link = 1)
                 AND (status != 'upcoming' OR date <= ?2)) AS w`,
      today,
    ),
    s.q(
      `SELECT kind, sum(amount) AS a FROM budget_line WHERE budget_id = ?1 AND kind IN ('wait', 'unsorted', 'uncat') GROUP BY kind`,
    ),
    s.q(`SELECT month, state FROM month_snapshot WHERE budget_id = ?1 AND month >= ?2 ORDER BY month`, prev),
    s.q(
      `SELECT txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref FROM budget_line WHERE budget_id = ?1 AND month = ?2
         AND kind IN ('rta', 'cat', 'owed', 'close', 'payment', 'debt')`,
      cur,
    ),
    s.q(`SELECT id, kind, card_account_id FROM category WHERE budget_id = ?1`),
  ]);
  const working = (work!.results[0] as { w: number }).w;
  const h = new Map((held!.results as { kind: string; a: number }[]).map((r) => [r.kind, r.a]));
  const months = (snaps!.results as { month: string; state: string }[]).map((r) => ({
    month: r.month as Month,
    s: JSON.parse(r.state) as StoredMonth,
  }));
  const curM = months.find((m) => m.month === cur);
  const categories = curM ? curM.s.c.reduce((a, c) => a + c[4], 0) : 0;
  // Unbudgeted card debt as of now: replay the current month from the previous month's snapshot.
  const prevSnap = months.find((m) => m.month === prev)?.s.s;
  const replay = computeBudget({
    startMonth: b.budget_start_month as Month,
    currentMonth: cur,
    categories: (
      cats!.results as {
        id: string;
        kind: 'spending' | 'saving' | 'cc_payment';
        card_account_id: string | null;
      }[]
    ).map((c) => ({ id: c.id, kind: c.kind, cardAccountId: c.card_account_id })),
    assignments: (
      await s.all<{ category_id: string; month: string; amount: number }>(
        `SELECT category_id, month, amount FROM assignment WHERE budget_id = ?1 AND month = ?2`,
        cur,
      )
    ).map((a) => ({
      categoryId: a.category_id,
      month: a.month as Month,
      amount: cents(a.amount),
    })),
    lines: (curLines!.results as Record<string, unknown>[]).map((r) =>
      lineFromRow([
        r.txn_key,
        r.line,
        r.month,
        r.date,
        r.seq,
        r.kind,
        r.account_id,
        r.card,
        r.category_id,
        r.amount,
        r.ref,
      ]),
    ),
    ...(prevSnap && cur > (b.budget_start_month as Month) ? { snapshot: prevSnap } : {}),
    until: cur,
  });
  const k = Object.values(replay.unbudgetedCardDebt).reduce((a, v) => a + v, 0);
  let later = 0;
  for (const m of months) {
    if (m.month <= cur) continue;
    for (const c of m.s.c) later += c[1] + c[2];
    for (const c of m.s.k) later += c[1];
    later += m.s.i - m.s.o;
  }
  const right =
    categories + b.rta + (h.get('wait') ?? 0) + (h.get('unsorted') ?? 0) + (h.get('uncat') ?? 0) - k + later;
  return { ok: working === right, difference: working - right, literal: working === right && k === 0 };
}

async function rollUpUsage(env: Env, budgetId: string, now: number): Promise<void> {
  const today = new Date(now).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${today}T00:00:00Z`);
  // Roll up earlier days not yet rolled up (raw rows stay 90 days for the export).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO usage_daily (budget_id, date, app_version, screen, event, target, count, median_value)
       SELECT budget_id, date(at / 1000, 'unixepoch'), app_version, screen, event, coalesce(target, ''), count(*), CAST(avg(value) AS INTEGER)
       FROM usage_event WHERE budget_id = ?1 AND at < ?2 AND at >= ?2 - 8 * 86400000
       GROUP BY budget_id, date(at / 1000, 'unixepoch'), app_version, screen, event, coalesce(target, '')`,
    ).bind(budgetId, dayStart),
    env.DB.prepare(`DELETE FROM usage_event WHERE budget_id = ?1 AND at < ?2`).bind(
      budgetId,
      now - 90 * 86_400_000,
    ),
  ]);
}

async function watchdog(env: Env, budgetId: string, now: number): Promise<void> {
  // The nightly GitHub Actions backup reports its finish time itself (POST /api/ops/backup-done), into
  // health_status.last_backup_at; the watchdog only records that it ran.
  const up = (k: string, v: string | null) =>
    env.DB.prepare(
      `INSERT INTO health_status (budget_id, key, value, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
    ).bind(budgetId, k, v, now);
  await env.DB.batch([
    up('watchdog_ran_at', String(now)),
    // Expired sign-in state (decisions.md D-27).
    env.DB.prepare(`DELETE FROM auth_session WHERE expires_at <= ?1`).bind(now),
    env.DB.prepare(`DELETE FROM auth_challenge WHERE expires_at <= ?1`).bind(now),
    env.DB.prepare(`DELETE FROM device_link WHERE expires_at <= ?1`).bind(now),
  ]);
}

export { addMonths };
