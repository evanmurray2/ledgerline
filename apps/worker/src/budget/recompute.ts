// Budget recalculation (Sync spec: Budget recalculation). At most four D1 calls whatever the history:
//   1. the budget row (version, dirty month, start, time zone)
//   2. one read batch: snapshot before the dirty month, categories, lines and assignments from it on, the cached
//      month rows (to write only what changed) and refund targets
//   3. computeBudget() in JavaScript
//   4. one write batch behind a version fence: changed month rows, Ready to Assign, dirty flag cleared
import {
  computeBudget,
  currentMonth,
  addMonths,
  type Assignment,
  type BudgetCategory,
  type BudgetLine,
  type MonthSnapshot,
  type Month,
  type StoredMonth,
  cents,
  changeHash,
  encodeMonth,
} from '@ledgerline/domain';
import { conditionFence, isFenceAbort } from '../sync/lease.js';

export const MAX_RECOMPUTE_RETRIES = 3;
/**
 * Months recomputed per call when the caller doesn't say. The phone's engine (local/engine.ts, the only caller since
 * D-45) asks for every month at once.
 */
export const MONTHS_PER_CHUNK = 2;

export interface RecomputeResult {
  ok: boolean;
  /** False when months remain dirty after this chunk; run again. */
  done: boolean;
  rta: number;
  from: Month | null;
  monthsComputed: number;
  monthsWritten: number;
  queries: number;
  rowsWritten: number;
  /** True when the cached figures were current and nothing ran. */
  cached: boolean;
}

interface BudgetRow {
  max_asg: string | null;
  max_line: string | null;
  summary_version: number;
  summary_dirty_from: string | null;
  summary_month: string | null;
  budget_start_month: string | null;
  time_zone: string;
  rta: number;
}

export function lineFromRow(r: unknown[]): BudgetLine {
  const [txnKey, line, month, date, seq, kind, accountId, card, categoryId, amount, ref] = r as [
    string,
    string,
    Month,
    string,
    number,
    BudgetLine['kind'],
    string,
    number,
    string | null,
    number,
    string | null,
  ];
  const id = `${txnKey}:${line}`;
  const base = { id, month, date, seq };
  const a = cents(amount);
  switch (kind) {
    case 'rta':
      return { kind, ...base, accountId, card: card === 1, amount: a };
    case 'cat':
      return {
        kind,
        ...base,
        accountId,
        card: card === 1,
        categoryId: categoryId!,
        amount: a,
        ...(ref ? { refundOf: ref } : {}),
      };
    case 'owed':
      return { kind, ...base, accountId, card: card === 1, amount: a, itemId: ref ?? '' };
    case 'close':
      return { kind, ...base, categoryId: categoryId!, amount: a, itemId: ref ?? '' };
    case 'payment':
      return { kind, ...base, cardAccountId: accountId, amount: a };
    case 'debt':
      return { kind, ...base, cardAccountId: accountId, amount: a };
  }
}

/** Bumps the summary version and widens the dirty range; goes in the same batch as the edit that changes inputs. */
export function markDirty(db: D1Database, budgetId: string, month: Month, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE budget SET summary_version = summary_version + 1,
         summary_dirty_from = CASE WHEN summary_dirty_from IS NULL OR summary_dirty_from > ?2 THEN ?2 ELSE summary_dirty_from END,
         updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(budgetId, month, now);
}

export async function recompute(
  db: D1Database,
  budgetId: string,
  now: number,
  opts: { force?: boolean; fullFrom?: boolean; maxMonths?: number } = {},
): Promise<RecomputeResult> {
  const maxMonths = opts.maxMonths ?? MONTHS_PER_CHUNK;
  let queries = 0;
  const none = (rta: number, cached: boolean, ok = true): RecomputeResult => ({
    ok,
    done: ok,
    rta,
    from: null,
    monthsComputed: 0,
    monthsWritten: 0,
    queries,
    rowsWritten: 0,
    cached,
  });
  for (let attempt = 0; attempt < MAX_RECOMPUTE_RETRIES; attempt++) {
    const b = await db
      .prepare(
        `SELECT summary_version, summary_dirty_from, summary_month, budget_start_month, time_zone, rta,
           (SELECT max(month) FROM assignment WHERE budget_id = ?1) AS max_asg,
           (SELECT max(month) FROM budget_line WHERE budget_id = ?1) AS max_line
         FROM budget WHERE id = ?1`,
      )
      .bind(budgetId)
      .first<BudgetRow>();
    queries++;
    if (!b?.budget_start_month) return none(0, true);
    const start = b.budget_start_month as Month;
    const cur = currentMonth(now, b.time_zone);
    if (!opts.force && b.summary_dirty_from === null && b.summary_month === cur) return none(b.rta, true);
    // Month results never depend on which month is current, so a rollover only recomputes from the current month.
    let from = (b.summary_dirty_from ?? cur) as Month;
    if (from > cur) from = cur;
    if (opts.fullFrom || from < start) from = start;
    const prevMonth = addMonths(from, -1);
    let last = cur;
    if (b.max_asg && b.max_asg > last) last = b.max_asg as Month;
    if (b.max_line && b.max_line > last) last = b.max_line as Month;
    // A chunk that reaches the current month runs to the end: RTA needs the totals through the current month, and
    // later months hold only assignments, so they are cheap.
    const windowEnd = addMonths(from, maxMonths - 1);
    const final = windowEnd >= last || windowEnd >= cur;
    const until = final ? last : windowEnd;

    const [snap, catRows, lineRows, asgRows, cachedRows, refundRows] = await db.batch([
      db
        .prepare(`SELECT state FROM month_snapshot WHERE budget_id = ?1 AND month = ?2`)
        .bind(budgetId, prevMonth),
      db.prepare(`SELECT id, kind, card_account_id FROM category WHERE budget_id = ?1`).bind(budgetId),
      db
        .prepare(
          `SELECT txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref
           FROM budget_line WHERE budget_id = ?1 AND month >= ?2 AND month <= ?3
             AND kind IN ('rta', 'cat', 'owed', 'close', 'payment', 'debt')`,
        )
        .bind(budgetId, from, until),
      db
        .prepare(
          `SELECT category_id, month, amount FROM assignment WHERE budget_id = ?1 AND month >= ?2 AND month <= ?3`,
        )
        .bind(budgetId, from, until),
      db
        .prepare(`SELECT month, hash FROM month_snapshot WHERE budget_id = ?1 AND month >= ?2`)
        .bind(budgetId, from),
      db
        .prepare(
          `SELECT to_key FROM txn_link WHERE budget_id = ?1 AND kind = 'refund_of' AND undone_at IS NULL`,
        )
        .bind(budgetId),
    ]);
    queries++;

    const snapState = (snap?.results[0] as { state: string } | undefined)?.state;
    const snapshot = from > start && snapState ? (JSON.parse(snapState) as StoredMonth).s : undefined;
    if (from > start && !snapshot) {
      // No snapshot to start from (first run, or a gap): start over from the budget start.
      opts = { ...opts, force: true, fullFrom: true };
      continue;
    }
    const categories: BudgetCategory[] = (
      catRows!.results as { id: string; kind: BudgetCategory['kind']; card_account_id: string | null }[]
    ).map((c) => ({ id: c.id, kind: c.kind, cardAccountId: c.card_account_id }));
    const lines = (lineRows!.results as Record<string, unknown>[]).map((r) =>
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
    );
    const assignments: Assignment[] = (
      asgRows!.results as { category_id: string; month: Month; amount: number }[]
    ).map((a) => ({
      categoryId: a.category_id,
      month: a.month,
      amount: cents(a.amount),
    }));
    const refundTargets = new Set((refundRows!.results as { to_key: string }[]).map((r) => `${r.to_key}:0`));
    const result = computeBudget({
      startMonth: start,
      currentMonth: cur,
      categories,
      assignments,
      lines,
      refundTargets,
      until,
      ...(snapshot ? { snapshot: snapshot as MonthSnapshot } : {}),
    });

    const cached = new Map(
      (cachedRows!.results as { month: string; hash: string }[]).map((r) => [r.month, r.hash]),
    );
    const writes: D1PreparedStatement[] = [
      conditionFence(
        db,
        `SELECT summary_version = ?1 FROM budget WHERE id = ?2`,
        b.summary_version,
        budgetId,
      ),
    ];
    let monthsWritten = 0;
    for (const m of result.months) {
      const json = JSON.stringify(encodeMonth(m));
      const hash = changeHash(json);
      if (cached.get(m.month) === hash) continue;
      monthsWritten++;
      writes.push(
        db
          .prepare(
            `INSERT INTO month_snapshot (budget_id, month, state, hash) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (budget_id, month) DO UPDATE SET state = excluded.state, hash = excluded.hash`,
          )
          .bind(budgetId, m.month, json, hash),
      );
    }
    if (final) {
      for (const m of cached.keys()) {
        if (m > result.through)
          writes.push(
            db.prepare(`DELETE FROM month_snapshot WHERE budget_id = ?1 AND month = ?2`).bind(budgetId, m),
          );
      }
      writes.push(
        db
          .prepare(
            `UPDATE budget SET rta = ?2, summary_month = ?3, summary_dirty_from = NULL, updated_at = ?4 WHERE id = ?1`,
          )
          .bind(budgetId, result.rta, cur, now),
      );
    } else {
      // Later months stay dirty; the next chunk starts after this one.
      writes.push(
        db
          .prepare(`UPDATE budget SET summary_dirty_from = ?2, updated_at = ?3 WHERE id = ?1`)
          .bind(budgetId, addMonths(until, 1), now),
      );
    }
    try {
      const res = await db.batch(writes);
      queries++;
      const rowsWritten = res.reduce((a, r) => a + (r.meta.rows_written ?? 0), 0);
      return {
        ok: true,
        done: final,
        rta: final ? result.rta : b.rta,
        from,
        monthsComputed: result.months.length,
        monthsWritten,
        queries,
        rowsWritten,
        cached: false,
      };
    } catch (e) {
      queries++;
      if (!isFenceAbort(e)) throw e;
      // Another write changed the inputs meanwhile: re-read and try again.
    }
  }
  return none(0, false, false);
}
