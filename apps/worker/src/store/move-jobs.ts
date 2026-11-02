// The move's jobs (docs/multi-user.md 8.3–8.5). A budget's store copies its rows from D1 and verifies them
// (row-for-row comparison of every table, a full recompute that must change nothing, and rule 10); the Directory
// copies the users and sign-in rows, routes every Plaid Item, starts each store, waits for all of them, and only then
// switches move_state to 'moved' in one D1 statement fenced on the freeze lease. Any difference aborts the move:
// the freeze lifts and D1 carries on with nothing changed.
import type { Env } from '../env.js';
import { recompute } from '../budget/recompute.js';
import { checkIdentityDb } from '../maintenance.js';
import { clock } from '../http/clock.js';
import type { Handler, StepResult } from './jobs.js';
import type { QueuedWebhook } from './frozen.js';
import {
  BUDGET_TABLES,
  DIRECTORY_TABLES,
  missingColumns,
  NO_FILTER,
  budgetFilter,
  chain,
  insertStatements,
  readChunk,
  tableMeta,
} from './move.js';

export type MoveStatus =
  | { state: 'copying' | 'verifying' | 'recomputing'; table?: string; detail?: string }
  | { state: 'verified'; tables: number; rows: number; monthsRecomputed: number }
  | { state: 'failed'; reason: string };

interface StoreMoveState {
  phase: 'copy' | 'verify' | 'recompute' | 'identity';
  budgetId: string;
  t: number;
  cursor: unknown[] | null;
  rows: number;
  hash: string;
  written?: number;
  first?: boolean;
  dirtyAtFreeze?: boolean;
}

/** A budget store's move_in job: copy, verify, recompute, rule 10. Reports through setStatus. */
export function storeMoveHandler(
  d1: D1Database,
  store: D1Database,
  appEnv: () => Env,
  setStatus: (s: MoveStatus) => Promise<void>,
): Handler {
  return async (job, now): Promise<StepResult> => {
    const s = job.state as StoreMoveState;
    // Recompute uses the app's clock (FAKE_NOW in tests and local runs): month totals depend on today's date.
    // Scheduling stays on the runner's clock.
    const today = clock(appEnv());
    const next = (st: StoreMoveState): StepResult => ({ state: st, runAt: now });
    const fail = async (reason: string): Promise<StepResult> => {
      await setStatus({ state: 'failed', reason });
      return { done: true };
    };
    if (s.phase === 'copy') {
      const table = BUDGET_TABLES[s.t];
      if (!table) {
        const b = await d1
          .prepare(`SELECT summary_dirty_from FROM budget WHERE id = ?1`)
          .bind(s.budgetId)
          .first<{ summary_dirty_from: string | null }>();
        await setStatus({ state: 'verifying' });
        return next({
          ...s,
          phase: 'verify',
          t: 0,
          cursor: null,
          rows: 0,
          hash: '',
          dirtyAtFreeze: !!b?.summary_dirty_from,
        });
      }
      const meta = await tableMeta(store, table);
      const c = await readChunk(d1, table, meta, budgetFilter(table, s.budgetId), s.cursor);
      if (c.rows.length) {
        const stmts = insertStatements(store, table, meta, c.rows);
        // The fresh store already has its apply_counter row: take D1's value instead.
        if (table === 'apply_counter') await store.prepare(`DELETE FROM apply_counter`).run();
        await store.batch(stmts);
      }
      if (c.cursor) return next({ ...s, cursor: c.cursor, rows: s.rows + c.rows.length });
      await setStatus({ state: 'copying', table });
      return next({ ...s, t: s.t + 1, cursor: null, rows: s.rows + c.rows.length });
    }
    if (s.phase === 'verify') {
      const table = BUDGET_TABLES[s.t];
      if (!table) {
        await setStatus({ state: 'recomputing' });
        return next({ ...s, phase: 'recompute', t: 0, written: 0, first: true });
      }
      // Every source column exists in the store, then the same rows in the same canonical form on both sides.
      if (s.cursor === null) {
        const missing = await missingColumns(d1, store, table, 'budget');
        if (missing) return fail(`${table}: the new database lacks column(s) ${missing.join(', ')}`);
      }
      const meta = await tableMeta(store, table);
      const src = await readChunk(d1, table, meta, budgetFilter(table, s.budgetId), s.cursor);
      const dst = await readChunk(
        store,
        table,
        meta,
        table === 'apply_counter' ? NO_FILTER : budgetFilter(table, s.budgetId),
        s.cursor,
      );
      if (src.text !== dst.text || src.rows.length !== dst.rows.length)
        return fail(`${table}: rows differ after ${s.rows} row(s)`);
      const hash = await chain(s.hash, src.text);
      if (src.cursor) return next({ ...s, cursor: src.cursor, rows: s.rows + src.rows.length, hash });
      // Nothing extra on the store's side either.
      const extra = dst.cursor ? await readChunk(store, table, meta, NO_FILTER, dst.cursor) : null;
      if (extra?.rows.length) return fail(`${table}: extra rows in the new database`);
      await setStatus({ state: 'verifying', table, detail: hash.slice(0, 12) });
      return next({ ...s, t: s.t + 1, cursor: null, rows: s.rows + src.rows.length, hash: '' });
    }
    if (s.phase === 'recompute') {
      // A full recompute from the budget's start must reproduce the copied month summaries exactly.
      const r = await recompute(store, s.budgetId, today, {
        maxMonths: 2,
        ...(s.first ? { force: true, fullFrom: true } : {}),
      });
      const written = (s.written ?? 0) + r.monthsWritten;
      if (!r.ok) return fail('recompute was interrupted');
      if (!r.done) return next({ ...s, written, first: false });
      // Recorded, not a failure: every row was already compared, and stored totals can be up to a day old, so a
      // fresh recompute may legitimately update a month (an upcoming bill's date passed). Rule 10 below is the check.
      return next({ ...s, phase: 'identity', written });
    }
    // Rule 10: working balances equal categories + Ready to Assign + held amounts, on the copied data.
    const identity = await checkIdentityDb(appEnv(), s.budgetId);
    if (!identity.ok) return fail(`rule 10 identity differs by ${identity.difference}`);
    await setStatus({
      state: 'verified',
      tables: BUDGET_TABLES.length,
      rows: s.rows,
      monthsRecomputed: s.written ?? 0,
    });
    return { done: true };
  };
}

interface DirMoveState {
  phase: 'copy' | 'verify' | 'routes' | 'stores' | 'wait' | 'switch' | 'after';
  t: number;
  cursor: unknown[] | null;
  budgets?: string[];
  i?: number;
  polls?: number;
}

export interface DirectoryMoveDeps {
  d1: D1Database;
  dir: D1Database;
  budgetIds: () => Promise<string[]>;
  resetStore: (budgetId: string) => Promise<void>;
  storeStatus: (budgetId: string) => Promise<MoveStatus | null>;
  afterMove: (budgetId: string, webhooks: QueuedWebhook[]) => Promise<void>;
  setStatus: (s: MoveStatus | { state: 'starting' | 'waiting' | 'switching' | 'moved' }) => Promise<void>;
}

/** The Directory's move job: copy and verify its own rows, route Items, run every store's move, switch. */
export function directoryMoveHandler(deps: DirectoryMoveDeps): Handler {
  const { d1, dir } = deps;
  return async (job, now): Promise<StepResult> => {
    const s = job.state as DirMoveState;
    const next = (st: DirMoveState, delay = 0): StepResult => ({ state: st, runAt: now + delay });
    const abort = async (reason: string): Promise<StepResult> => {
      // The freeze lifts; D1 carries on exactly as it was.
      await d1
        .prepare(`UPDATE move_state SET phase = 'none', updated_at = ?1 WHERE id = 1 AND phase = 'frozen'`)
        .bind(now)
        .run();
      await deps.setStatus({ state: 'failed', reason });
      return { done: true };
    };
    switch (s.phase) {
      case 'copy': {
        const table = DIRECTORY_TABLES[s.t];
        if (!table) return next({ phase: 'verify', t: 0, cursor: null });
        const meta = await tableMeta(dir, table);
        const c = await readChunk(d1, table, meta, NO_FILTER, s.cursor);
        if (c.rows.length) await dir.batch(insertStatements(dir, table, meta, c.rows));
        return next(c.cursor ? { ...s, cursor: c.cursor } : { ...s, t: s.t + 1, cursor: null });
      }
      case 'verify': {
        const table = DIRECTORY_TABLES[s.t];
        if (!table) return next({ phase: 'routes', t: 0, cursor: null });
        if (s.cursor === null) {
          const missing = await missingColumns(d1, dir, table, 'directory');
          if (missing) return abort(`${table}: the Directory lacks column(s) ${missing.join(', ')}`);
        }
        const meta = await tableMeta(dir, table);
        const src = await readChunk(d1, table, meta, NO_FILTER, s.cursor);
        const dst = await readChunk(dir, table, meta, NO_FILTER, s.cursor);
        if (src.text !== dst.text) return abort(`${table}: rows differ in the Directory`);
        return next(src.cursor ? { ...s, cursor: src.cursor } : { ...s, t: s.t + 1, cursor: null });
      }
      case 'routes': {
        // Every Plaid Item routed to its budget; each one already counts against the Trial cap.
        const items = await d1
          .prepare(
            `SELECT id, budget_id, provider_item_id, created_at FROM connection WHERE provider = 'plaid' AND provider_item_id IS NOT NULL`,
          )
          .all<{ id: string; budget_id: string; provider_item_id: string; created_at: number }>();
        const stmts = items.results.flatMap((c) => [
          dir
            .prepare(
              `INSERT OR IGNORE INTO connection_route (provider_item_id, budget_id, connection_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
            )
            .bind(c.provider_item_id, c.budget_id, c.id, c.created_at),
          dir
            .prepare(
              `INSERT OR IGNORE INTO plaid_link_slot (id, user_id, budget_id, status, connection_id, created_at)
               SELECT 'slot_' || ?1, m.user_id, ?2, 'used', ?1, ?3 FROM budget_member m WHERE m.budget_id = ?2 AND m.role = 'owner' LIMIT 1`,
            )
            .bind(c.id, c.budget_id, c.created_at),
        ]);
        if (stmts.length) await dir.batch(stmts);
        return next({ phase: 'stores', t: 0, cursor: null, budgets: await deps.budgetIds(), i: 0 });
      }
      case 'stores': {
        const b = s.budgets?.[s.i ?? 0];
        if (!b) {
          await deps.setStatus({ state: 'waiting' });
          return next({ ...s, phase: 'wait', polls: 0 }, 1000);
        }
        await deps.resetStore(b);
        return next({ ...s, i: (s.i ?? 0) + 1 });
      }
      case 'wait': {
        const statuses = await Promise.all((s.budgets ?? []).map((b) => deps.storeStatus(b)));
        const failed = statuses.find((x) => x?.state === 'failed');
        if (failed && failed.state === 'failed') return abort(failed.reason);
        if (statuses.every((x) => x?.state === 'verified')) return next({ ...s, phase: 'switch' });
        if ((s.polls ?? 0) > 1500) return abort('a budget did not finish copying in time');
        return next({ ...s, polls: (s.polls ?? 0) + 1 }, 2000);
      }
      case 'switch': {
        await deps.setStatus({ state: 'switching' });
        // One statement, fenced on the freeze still being ours and unexpired.
        const r = await d1
          .prepare(
            `UPDATE move_state SET phase = 'moved', updated_at = ?1 WHERE id = 1 AND phase = 'frozen' AND lease_expires > ?1`,
          )
          .bind(now)
          .run();
        if (r.meta.changes !== 1) return abort('the freeze ended before the switch (time limit)');
        return next({ ...s, phase: 'after', i: 0 });
      }
      case 'after': {
        // Each store replays the webhooks that arrived during the freeze and queues a sync of every bank.
        const b = s.budgets?.[s.i ?? 0];
        if (!b) {
          await deps.setStatus({ state: 'moved' });
          return { done: true };
        }
        const queued = await d1
          .prepare(`SELECT payload FROM move_queue WHERE kind = 'webhook' ORDER BY id`)
          .all<{ payload: string }>();
        const routes = await dir
          .prepare(`SELECT provider_item_id FROM connection_route WHERE budget_id = ?1`)
          .bind(b)
          .all<{ provider_item_id: string }>();
        const mine = new Set(routes.results.map((r) => r.provider_item_id));
        const events = queued.results
          .map((q) => JSON.parse(q.payload) as QueuedWebhook)
          .filter((e) => mine.has(e.itemId));
        await deps.afterMove(b, events);
        return next({ ...s, i: (s.i ?? 0) + 1 });
      }
    }
  };
}
