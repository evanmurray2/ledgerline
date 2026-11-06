// Post-apply work driven by the watermark (Sync spec F3). Each step reads up to CHUNK.process events after
// budget.processed_through, decides matches, categorization, transfers and Waiting to match with the pure domain
// functions, and writes everything plus the new watermark in one batch behind a watermark fence. Reprocessing is
// harmless: it never overwrites a user's categorization. Categories come only from you (docs/payees.md: no rules).
import type { Db, Stmt } from '@ledgerline/db/sql';
import {
  type IsoDate,
  type Month,
  addDays,
  cents,
  currentMonth,
  localDate,
  matchReissues,
  type MatchRow,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { Scoped } from '../db/scoped.js';
import { accountLedger, bankDiff } from '../ledger/bank-diff.js';
import { conditionFence, isFenceAbort } from './lease.js';
import type { StepContext } from './steps.js';
import { CHUNK } from './steps.js';
import { budgetMeta, chunks } from '../ledger/ledger.js';
import { makeProvider, connectionToken } from './provider.js';
import { planFresh } from './file-fresh.js';
import { loadBankRows } from './bank-rows.js';
import { alert, channel, merchantOf, planMatches } from './pending-match.js';

const MAX_WATERMARK_RETRIES = 3;

export interface ProcessResult {
  caughtUp: boolean;
  processed: number;
}

interface EventRow {
  id: number;
  kind: 'added' | 'modified' | 'removed';
  provider_txn_id: string;
}

export interface BankRow {
  provider_txn_id: string;
  txn_key: string;
  account_id: string | null;
  account_kind: string | null;
  budget_from: string | null;
  amount: number;
  date: string;
  authorized_date: string | null;
  pending: number;
  pending_provider_txn_id: string | null;
  raw_name: string;
  plaid_name: string | null;
  merchant_name: string | null;
  merchant_entity_id: string | null;
  provider_category: string | null;
  payment_channel: string | null;
  removed_at: number | null;
  first_apply_seq: number;
  linked_at: number | null;
}

export async function processPending(env: Env, budgetId: string, now = Date.now()): Promise<ProcessResult> {
  const s = new Scoped(env.DB, budgetId, 'system');
  for (let attempt = 0; attempt < MAX_WATERMARK_RETRIES; attempt++) {
    const b = await s.first<{
      processed_through: number;
      time_zone: string;
      budget_start_month: string | null;
    }>(`SELECT processed_through, time_zone, budget_start_month FROM budget WHERE id = ?1`);
    if (!b) return { caughtUp: true, processed: 0 };
    const expected = b.processed_through;
    const evs = await s.all<EventRow>(
      `SELECT id, kind, provider_txn_id FROM bank_event WHERE budget_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`,
      expected,
      CHUNK.process,
    );
    if (evs.length === 0) return { caughtUp: true, processed: 0 };
    const through = evs[evs.length - 1]!.id;
    const today = localDate(now, b.time_zone);
    const meta = await budgetMeta(s);
    const plan = meta ? await planProcessing(s, evs, today, now) : { stmts: [] };
    const fence = () =>
      conditionFence(env.DB, `SELECT processed_through = ?1 FROM budget WHERE id = ?2`, expected, budgetId);
    try {
      // 1. Matches, categorization and transfers (idempotent: reprocessing the same events writes the same rows).
      if (plan.stmts.length) await env.DB.batch([fence(), ...plan.stmts]);
      // 2. The new watermark, behind the same fence.
      await env.DB.batch([
        fence(),
        s.q(`UPDATE budget SET processed_through = ?2, updated_at = ?3 WHERE id = ?1`, through, now),
      ]);
      return { caughtUp: evs.length < CHUNK.process, processed: evs.length };
    } catch (e) {
      if (!isFenceAbort(e)) throw e;
      // Another processor moved the watermark first: re-read and continue.
    }
  }
  return { caughtUp: false, processed: 0 };
}

/**
 * After every sync of a connection, whether or not the bank sent anything: its accounts' pending rows that no posted
 * row has claimed are matched again (D-47, step 2 of pending-match.ts) and checked for covers (step 4), so a pairing
 * missed earlier, by an older release, or with an entry added since, heals on the next sync instead of waiting for
 * the bank to send news about that row. Behind the same watermark fence as
 * processing, so the two never claim a row twice; on a lost race it simply waits for the next sync.
 */
export async function healPending(
  env: Env,
  budgetId: string,
  connectionId: string,
  now = Date.now(),
): Promise<{ changed: boolean }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const b = await s.first<{ processed_through: number; time_zone: string }>(
    `SELECT processed_through, time_zone FROM budget WHERE id = ?1`,
  );
  const meta = b ? await budgetMeta(s) : null;
  if (!b || !meta) return { changed: false };
  const today = localDate(now, b.time_zone);
  const open = await s.all<{ provider_txn_id: string }>(
    `SELECT b.provider_txn_id FROM bank_txn b
     WHERE b.budget_id = ?1 AND b.connection_id = ?2 AND b.pending = 1 AND b.date >= ?3
       AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)
     ORDER BY b.date DESC LIMIT ?4`,
    connectionId,
    addDays(today, -44),
    CHUNK.process,
  );
  if (!open.length) return { changed: false };
  const evs: EventRow[] = open.map((r, i) => ({
    id: i,
    kind: 'modified',
    provider_txn_id: r.provider_txn_id,
  }));
  const plan = await planProcessing(s, evs, today, now, true);
  if (!plan.stmts.length) return { changed: false };
  const fence = () =>
    conditionFence(
      env.DB,
      `SELECT processed_through = ?1 FROM budget WHERE id = ?2`,
      b.processed_through,
      budgetId,
    );
  try {
    await env.DB.batch([fence(), ...plan.stmts]);
  } catch (e) {
    if (!isFenceAbort(e)) throw e;
    return { changed: false };
  }
  return { changed: true };
}

/** Decides what the new events mean and returns the overlay writes. */
async function planProcessing(
  s: Scoped,
  evs: EventRow[],
  today: IsoDate,
  now: number,
  /** Healing (healPending): only the matching steps, for rows nothing new arrived for. */
  matchOnly = false,
): Promise<{ stmts: Stmt[] }> {
  const rows = await loadBankRows(s, [...new Set(evs.map((e) => e.provider_txn_id))]);
  const stmts: Stmt[] = [];
  const live = rows.filter((r) => r.removed_at === null && r.account_id);
  const removed = rows.filter((r) => r.removed_at !== null && r.account_id);

  const m = await planMatches(s, rows, live, today, now, stmts);
  const { inherited, claimed, tookOver } = m;
  const inherit = m.inherit;

  if (matchOnly) return { stmts };

  // ---- 5. Re-issued posted rows, and removed pending rows nothing has claimed.
  const removedPosted = removed.filter((r) => !r.pending);
  const addedPosted = live.filter(
    (r) => !r.pending && !inherited.has(r.provider_txn_id) && r.txn_key === `p:${r.provider_txn_id}`,
  );
  const asRow = (r: BankRow): MatchRow => ({
    key: r.provider_txn_id,
    accountId: r.account_id!,
    amount: cents(r.amount),
    date: r.date,
    ...merchantOf(r),
    channel: channel(r),
  });
  for (const d of matchReissues(removedPosted.map(asRow), addedPosted.map(asRow))) {
    const old = removedPosted.find((r) => r.provider_txn_id === d.removedKey)!;
    if (d.kind === 'inherit') {
      const add = addedPosted.find((r) => r.provider_txn_id === d.addedKey)!;
      inherit(add.provider_txn_id, old.txn_key, 'auto', add.amount, null);
    } else stmts.push(alert(s, 'possible_reissue', old.txn_key, { added: d.addedKeys }, now));
    // A posted row in an earlier month that is removed or re-issued: History changed.
    const cm = currentMonth(now, 'America/Los_Angeles');
    if (old.date.slice(0, 7) < cm)
      stmts.push(
        alert(s, 'history_changed', old.txn_key, { month: old.date.slice(0, 7), amount: old.amount }, now),
      );
  }
  const removedPending = removed.filter((x) => x.pending && !claimed.has(x.txn_key));
  if (removedPending.length) {
    // Already claimed by a posted row (by the provider's link, or earlier without it): nothing to hold.
    const held = new Set<string>();
    for (const k of chunks(removedPending.map((r) => r.txn_key)))
      for (const h of await s.all<{ txn_key: string }>(
        `SELECT txn_key FROM bank_txn WHERE budget_id = ?1 AND pending = 0 AND removed_at IS NULL
           AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
        ...k,
      ))
        held.add(h.txn_key);
    for (const r of removedPending) {
      if (held.has(r.txn_key)) continue;
      // Removed with no posted successor yet: hold its edits (14 days) and flag a vanished pending after 5 days (daily
      // scan). A posted row that arrives later still claims it (step 2). A row your entry covers vanished from
      // nothing: the entry still counts for it (docs/payee-names.md 9.2).
      stmts.push(
        s.q(
          `UPDATE txn_overlay SET orphaned_at = coalesce(orphaned_at, ?3) WHERE budget_id = ?1 AND txn_key = ?2
             AND NOT EXISTS (SELECT 1 FROM manual_pending m WHERE m.budget_id = ?1 AND m.covers_provider_txn_id = ?4
               AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL)`,
          r.txn_key,
          now,
          r.provider_txn_id,
        ),
      );
    }
  }

  // ---- 6. For rows without your categorization: the payee, transfers and Waiting to match. No category is set.
  const fresh = live.filter((r) => !inherited.has(r.provider_txn_id));
  if (fresh.length || tookOver.length) stmts.push(...(await planFresh(s, fresh, now, tookOver)));
  return { stmts };
}

/** After the watermark catches up: refresh balances and card liabilities, mark the sync done. */
export async function finalizeConnection(env: Env, c: StepContext, runId: string): Promise<void> {
  const now = Date.now();
  try {
    const provider = makeProvider(env);
    const token = await connectionToken(env, c.connectionId);
    const conn = { id: c.connectionId, accessToken: token, providerItemId: null };
    const accounts = await provider.getAccounts(conn);
    const stmts: Stmt[] = accounts.map((a) =>
      env.DB.prepare(
        `UPDATE provider_account SET current_balance = ?3, available_balance = ?4, credit_limit = ?5, balance_as_of = ?6, updated_at = ?6
         WHERE connection_id = ?1 AND provider_account_id = ?2`,
      ).bind(c.connectionId, a.providerAccountId, a.currentBalance, a.availableBalance, a.creditLimit, now),
    );
    if (provider.getLiabilities) {
      const liab = await provider.getLiabilities(conn).catch(() => []);
      // One snapshot per card per day in the budget's time zone.
      const zone = await env.DB.prepare(`SELECT time_zone FROM budget WHERE id = ?1`)
        .bind(c.budgetId)
        .first<{ time_zone: string }>();
      const snapshotDay = localDate(now, zone?.time_zone ?? 'America/Los_Angeles');
      for (const l of liab) {
        stmts.push(
          env.DB.prepare(
            // One snapshot per card per day: a later sync the same day replaces it (liability_day index).
            `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, statement_date, due_date, minimum_payment, apr_bp, data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}', ?10)
             ON CONFLICT (budget_id, provider_account_id, as_of) DO UPDATE SET statement_balance = excluded.statement_balance,
               statement_date = excluded.statement_date, due_date = excluded.due_date, minimum_payment = excluded.minimum_payment,
               apr_bp = excluded.apr_bp, created_at = excluded.created_at`,
          ).bind(
            ulid(now),
            c.budgetId,
            l.providerAccountId,
            snapshotDay,
            l.statementBalance,
            l.statementDate,
            l.dueDate,
            l.minimumPayment,
            l.aprBasisPoints,
            now,
          ),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch {
    // Balances refresh on the next sync; the transactions are already applied.
  }
  try {
    await markDrift(env.DB, c.budgetId, c.connectionId, now);
  } catch {
    // The next sync sets it; until then a difference waits a little longer to show.
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sync_run SET phase = 'done', finished_at = ?2, updated_at = ?2 WHERE id = ?1`,
    ).bind(runId, now),
    env.DB.prepare(`DELETE FROM sync_page WHERE sync_run_id = ?1`).bind(runId),
    env.DB.prepare(
      `UPDATE connection SET last_synced_at = ?2, last_attempt_at = ?2, error_code = NULL, status = 'ok' WHERE id = ?1`,
    ).bind(c.connectionId, now),
  ]);
}

/**
 * When each account of the connection began to differ from the bank (D-68): set on the first sync that sees a
 * difference pending can't explain, cleared on the first that sees none. Accounts shows it after DIFF_WAIT_MS.
 */
export async function markDrift(db: Db, budgetId: string, connectionId: string, now: number): Promise<void> {
  const s = new Scoped(db, budgetId, 'system');
  const zone = await s.first<{ time_zone: string }>(`SELECT time_zone FROM budget WHERE id = ?1`);
  const today = localDate(now, zone?.time_zone ?? 'America/Los_Angeles');
  const rows = await s.all<{
    id: string;
    kind: string;
    budget_from: string;
    starting_balance: number;
    pa_id: string;
    bank: number | null;
    drift_since: number | null;
  }>(
    `SELECT a.id, a.kind, a.budget_from, a.starting_balance, pa.id AS pa_id, pa.current_balance AS bank, pa.drift_since
     FROM account a JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
     WHERE a.budget_id = ?1 AND pa.connection_id = ?2 AND a.closed_at IS NULL`,
    connectionId,
  );
  if (!rows.length) return;
  const ledger = await accountLedger(s, rows, today, now, true);
  const stmts: Stmt[] = [];
  for (const a of rows) {
    if (a.bank === null) continue;
    const bank = a.kind === 'credit' ? -a.bank : a.bank;
    const { left } = bankDiff(
      bank,
      ledger.posted.get(a.id) ?? a.starting_balance,
      ledger.pending.get(a.id) ?? 0,
    );
    const since = left === 0 ? null : (a.drift_since ?? now);
    if (since !== a.drift_since)
      stmts.push(
        s.q(`UPDATE provider_account SET drift_since = ?3 WHERE budget_id = ?1 AND id = ?2`, a.pa_id, since),
      );
  }
  if (stmts.length) await s.batch(stmts);
}

export type { Month };
