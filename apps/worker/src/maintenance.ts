// The daily maintenance job's pieces (Sync spec: Daily maintenance job): the rule 10 identity assertion, usage
// roll-up and pruning, and the watchdog. store/budget-jobs.ts runs them as alarm steps, each sized for 10 ms of CPU.
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  type Month,
  type StoredMonth,
  addMonths,
  computeBudget,
  cents,
  currentMonth,
} from '@ledgerline/domain';
import type { Env } from './env.js';
import { clock } from './http/clock.js';
import { Scoped } from './db/scoped.js';
import { lineFromRow } from './budget/recompute.js';
import { RECENT_TX } from './ledger/ledger.js';
import { adjustments } from './ledger/start-part.js';

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
              (SELECT coalesce(sum(amount), 0) FROM ${RECENT_TX} WHERE budget_id = ?1 AND wont_clear = 0 AND (date >= budget_from OR pending_at_link = 1)
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
  // Rows that move a starting balance beyond what the sum above holds (ledger/start-part.ts, D-?).
  let working = (work!.results[0] as { w: number }).w;
  for (const v of (await adjustments(s, now)).sum.values()) working += v;
  // A row pending at link that posted with a date before the earliest budget start: RECENT_TX reads posted rows from
  // that date on, but the budget counts it in the starting balance.
  const early = await s.first<{ a: number }>(
    `SELECT coalesce(sum(amount), 0) AS a FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted' AND wont_clear = 0
       AND key IN (SELECT txn_key FROM txn_overlay WHERE budget_id = ?1 AND pending_at_link = 1)
       AND posted_date < (SELECT min(budget_from) FROM account WHERE budget_id = ?1)`,
  );
  working += early?.a ?? 0;
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

export async function rollUpUsage(env: Env, budgetId: string, now: number): Promise<void> {
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

/** The budget's half of the watchdog (docs/multi-user.md 5.6: the auth prune runs in the Directory). */
export function watchdogBudgetStmts(db: Db, budgetId: string, now: number): Stmt[] {
  // The watchdog records that it ran; the Accounts alerts compare it with the monitor's last check.
  return [
    db
      .prepare(
        `INSERT INTO health_status (budget_id, key, value, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
      )
      .bind(budgetId, 'watchdog_ran_at', String(now), now),
    // Card statement snapshots older than 120 days: only each card's latest is shown.
    db
      .prepare(
        `DELETE FROM liability_snapshot WHERE budget_id = ?1 AND as_of < date(?2 / 1000, 'unixepoch', '-120 days')`,
      )
      .bind(budgetId, now),
  ];
}

/** Expired sign-in state (decisions.md D-27). */
export function pruneAuthStmts(db: Db, now: number): Stmt[] {
  return [
    db.prepare(`DELETE FROM auth_session WHERE expires_at <= ?1`).bind(now),
    db.prepare(`DELETE FROM auth_challenge WHERE expires_at <= ?1`).bind(now),
    db.prepare(`DELETE FROM device_link WHERE expires_at <= ?1`).bind(now),
  ];
}

export { addMonths };
