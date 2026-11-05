// One-time job, parts 2 and 3 of docs/payee-names.md 8: every existing transaction follows the new payee rules.
//
// Queued once, without a migration: by the plaid_name fill (fill-plaid-name.ts) when it finishes, and by the store at
// start (budget-store.ts), for a store whose fill had already finished before this release. Both run QUEUE_REFILE,
// which queues it only where payees were made by the old rules (an old cleaned-text alias exists) and the job hasn't
// run yet (no `payee.refile` audit row). So a new budget, and the phone's copy, never get it.
//
// Steps, each one batch behind the processing watermark fence (budget.processed_through, as healPending): every
// connection's processing moves that one watermark, so a step whose reads a sync has changed in the meantime writes
// nothing and runs again. The job waits until the fill is done and processing has caught up. Each step writes its
// next state into its own job row in the same batch, so a step killed after its batch committed resumes after it.
//   wait     the fill job is gone and processing has caught up
//   names    part 2: a payee is `user` only if an audit row shows a name you chose; every other one is `sync`
//   release  sync payees give up their keys (the old cleaned-text aliases stay, for a code rollback); a user payee
//            gets the key of its name if no payee has it
//   refile   part 3: the transactions of sync payees, REFILE_ROWS at a time in date order, filed again by 4–6
//   finish   a sync payee left with no transactions joins the payee most of its rows went to; one audit row
//   done     nothing left (a finish step killed after its batch committed ends here, without a second audit row)
import type { Db, Stmt } from '@ledgerline/db/sql';
import { newPayeeName, payeeNameKey } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';
import { FILL_PLAID_NAME_ID } from './fill-plaid-name.js';
import { conditionFence, isFenceAbort } from './lease.js';
import { claimName, insertKey, loadOwners, payeeSource, rowKeys } from './payee-keys.js';

export const REFILE_PAYEES_ID = 'once:refile_payees';

/** Transactions filed again per step: well inside 10 ms of CPU (docs/measurements.md). */
export const REFILE_ROWS = 40;

/** How long the job waits for the fill or for processing to catch up. */
export const REFILE_WAIT_MS = 60_000;

/**
 * Queues the job once (see the top of this file). Plain SQL on the store's database, so the store can run it at
 * start before it serves anything.
 */
export const QUEUE_REFILE = `INSERT INTO job (id, kind, state, run_at, created_at, updated_at)
  SELECT '${REFILE_PAYEES_ID}', 'refile_payees', '{}', ?1, ?1, ?1
  WHERE NOT EXISTS (SELECT 1 FROM job WHERE id = '${REFILE_PAYEES_ID}')
    AND EXISTS (SELECT 1 FROM payee_alias WHERE pattern IS NOT NULL AND pattern NOT LIKE 'n:%')
    AND NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'payee.refile')`;

export interface RefileState {
  phase?: 'wait' | 'names' | 'release' | 'refile' | 'finish' | 'done';
  /** Refile: the last transaction done, by its earliest date and key. */
  after?: { date: string; key: string };
  /** Refile: each old payee, and how many of its rows went to each other payee. */
  moves?: Record<string, Record<string, number>>;
  /** Counts for the audit row. */
  user?: number;
  filed?: number;
  moved?: number;
  made?: number;
}

export type RefileStep = { done: true } | { done: false; state: RefileState; runAt: number };

interface AuditRow {
  id: number;
  action: string;
  entity_id: string | null;
  before: string | null;
  after: string | null;
}

/** One step of the job. `jobId` is the job's row, which the step's batch updates with the next state. */
export async function refilePayeesStep(
  db: Db,
  budgetId: string,
  jobId: string,
  state: RefileState,
  now: number,
): Promise<RefileStep> {
  const s = new Scoped(db, budgetId, 'system');
  const b = await s.first<{ processed_through: number }>(
    `SELECT processed_through FROM budget WHERE id = ?1`,
  );
  if (!b) return { done: true };
  const later = (st: RefileState): RefileStep => ({ done: false, state: st, runAt: now + REFILE_WAIT_MS });
  /** Writes `stmts` and the next state in one batch behind the watermark fence; a lost race runs the step again. */
  const write = async (stmts: Stmt[], next: RefileState): Promise<RefileStep> => {
    try {
      await db.batch([
        conditionFence(
          db,
          `SELECT processed_through = ?1 FROM budget WHERE id = ?2`,
          b.processed_through,
          budgetId,
        ),
        ...stmts,
        db
          .prepare(`UPDATE job SET state = ?2, updated_at = ?3 WHERE id = ?1`)
          .bind(jobId, JSON.stringify(next), now),
      ]);
    } catch (e) {
      if (!isFenceAbort(e)) throw e;
      return { done: false, state, runAt: now + 1000 };
    }
    return { done: false, state: next, runAt: now };
  };

  switch (state.phase ?? 'wait') {
    case 'wait': {
      const [fill, events] = await db.batch([
        db.prepare(`SELECT 1 FROM job WHERE id = ?1 AND failed_at IS NULL`).bind(FILL_PLAID_NAME_ID),
        s.q(`SELECT coalesce(max(id), 0) AS n FROM bank_event WHERE budget_id = ?1`),
      ]);
      if (fill!.results.length) return later(state);
      if ((events!.results[0] as { n: number }).n > b.processed_through) return later(state);
      return write([], { ...state, phase: 'names' });
    }
    case 'names': {
      const { user, sync } = await chosenNames(s);
      const stmts: Stmt[] = [];
      for (const k of chunks(sync))
        stmts.push(
          s.q(
            `UPDATE payee SET named_by = 'sync' WHERE budget_id = ?1 AND named_by = 'user' AND id IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
            ...k,
          ),
        );
      for (const k of chunks(user))
        stmts.push(
          s.q(
            `UPDATE payee SET named_by = 'user' WHERE budget_id = ?1 AND id IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
            ...k,
          ),
        );
      return write(stmts, { ...state, phase: 'release', user: user.length });
    }
    case 'release': {
      const users = await s.all<{ id: string; name: string }>(
        `SELECT id, name FROM payee WHERE budget_id = ?1 AND named_by = 'user' AND merged_into IS NULL`,
      );
      return write(
        [
          s.q(
            `DELETE FROM payee_alias WHERE budget_id = ?1 AND (pattern IS NULL OR pattern LIKE 'n:%')
               AND payee_id IN (SELECT id FROM payee WHERE budget_id = ?1 AND named_by = 'sync')`,
          ),
          ...users.map((p) => claimName(s, p.id, p.name, now)),
        ],
        { ...state, phase: 'refile', moves: {}, filed: 0, moved: 0, made: 0 },
      );
    }
    case 'refile':
      return refileChunk(s, state, now, write);
    case 'finish': {
      const empty = await s.all<{ id: string }>(
        `SELECT p.id FROM payee p WHERE p.budget_id = ?1 AND p.named_by = 'sync' AND p.merged_into IS NULL
           AND NOT EXISTS (SELECT 1 FROM txn_overlay o WHERE o.budget_id = ?1 AND o.payee_id = p.id)`,
      );
      const stmts: Stmt[] = [];
      let merged = 0;
      for (const { id } of empty) {
        const to = Object.entries(state.moves?.[id] ?? {}).sort(
          (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1),
        )[0]?.[0];
        // A payee with no rows before the job either (nothing moved off it) stays as it is.
        if (!to) continue;
        merged++;
        // Links to it still resolve; payees joined into it earlier, and its old cleaned-text aliases, follow it.
        stmts.push(
          s.q(
            `UPDATE payee SET merged_into = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
            id,
            to,
            now,
          ),
          s.q(
            `UPDATE payee SET merged_into = ?3, updated_at = ?4 WHERE budget_id = ?1 AND merged_into = ?2`,
            id,
            to,
            now,
          ),
          s.q(`UPDATE payee_alias SET payee_id = ?3 WHERE budget_id = ?1 AND payee_id = ?2`, id, to),
        );
      }
      stmts.push(
        s.audit(
          'payee.refile',
          'payee',
          null,
          null,
          {
            userPayees: state.user ?? 0,
            filed: state.filed ?? 0,
            moved: state.moved ?? 0,
            made: state.made ?? 0,
            merged,
          },
          now,
        ),
      );
      const r = await write(stmts, { ...state, phase: 'done' });
      return r.done || r.runAt > now ? r : { done: true };
    }
    case 'done':
      return { done: true };
  }
}

/**
 * Part 2 (docs/payee-names.md 8.2): the live payees whose name you chose, and the others. A name you chose is a
 * rename, a name typed on a transaction (`txn.edit` with payeeName), or a join under a name that wasn't one of the
 * joined payees' names; a join made by this release (its audit has namedBy) always is. Each counts for the payee the
 * renamed one is now part of, and only while that payee still has that name.
 */
async function chosenNames(s: Scoped): Promise<{ user: string[]; sync: string[] }> {
  const [audit, typed, payees] = await s.batch([
    s.q(
      `SELECT id, action, entity_id, before, after FROM audit_log
       WHERE budget_id = ?1 AND action IN ('payee.rename', 'payee.merge', 'payee.merge.undo') ORDER BY id`,
    ),
    s.q(
      `SELECT a.id, 'txn.edit' AS action, o.payee_id AS entity_id, NULL AS before, json_object('name', json_extract(a.after, '$.payeeName')) AS after
       FROM audit_log a JOIN txn_overlay o ON o.txn_key = a.entity_id
       WHERE a.budget_id = ?1 AND a.action = 'txn.edit' AND json_extract(a.after, '$.payeeName') IS NOT NULL AND o.payee_id IS NOT NULL`,
    ),
    s.q(`SELECT id, name, merged_into FROM payee WHERE budget_id = ?1`),
  ]);
  const all = payees!.results as { id: string; name: string; merged_into: string | null }[];
  const byId = new Map(all.map((p) => [p.id, p]));
  const root = (id: string): string => {
    for (let i = 0, at = id; i < 50; i++) {
      const next = byId.get(at)?.merged_into;
      if (!next) return at;
      at = next;
    }
    return id;
  };
  const rows = audit!.results as AuditRow[];
  const undone = new Set(rows.filter((r) => r.action === 'payee.merge.undo').map((r) => r.entity_id));
  const chosen = new Map<string, Set<string>>();
  const choose = (id: string | null | undefined, name: unknown) => {
    if (!id || typeof name !== 'string' || !byId.has(id)) return;
    const r = root(id);
    chosen.set(r, (chosen.get(r) ?? new Set()).add(payeeNameKey(name)));
  };
  for (const r of [...rows, ...(typed!.results as AuditRow[])]) {
    // Old rows store the JSON text 'null' for an empty side.
    const after = (r.after ? (JSON.parse(r.after) as { name?: unknown; keep?: unknown } | null) : null) ?? {};
    if (r.action === 'payee.rename' || r.action === 'txn.edit') choose(r.entity_id, after.name);
    else if (r.action === 'payee.merge' && !undone.has(r.entity_id)) {
      const before =
        (r.before
          ? (JSON.parse(r.before) as { names?: Record<string, string>; namedBy?: unknown } | null)
          : null) ?? {};
      const names = Object.values(before.names ?? {}).map(payeeNameKey);
      if (before.namedBy || (typeof after.name === 'string' && !names.includes(payeeNameKey(after.name))))
        choose(typeof after.keep === 'string' ? after.keep : null, after.name);
    }
  }
  const user: string[] = [];
  const sync: string[] = [];
  for (const p of all) {
    if (p.merged_into) continue;
    (chosen.get(p.id)?.has(payeeNameKey(p.name)) ? user : sync).push(p.id);
  }
  return { user, sync };
}

interface RefileRow {
  txn_key: string;
  raw_name: string;
  plaid_name: string | null;
  merchant_name: string | null;
  merchant_entity_id: string | null;
  pending: number;
  removed_at: number | null;
  first_apply_seq: number;
}

/** Part 3 (8.3): the next transactions of sync payees, in date order, filed again by section 4. */
async function refileChunk(
  s: Scoped,
  state: RefileState,
  now: number,
  write: (stmts: Stmt[], next: RefileState) => Promise<RefileStep>,
): Promise<RefileStep> {
  const after = state.after ?? { date: '', key: '' };
  // Only transactions of sync payees: a user payee keeps its name, transactions and keys. The money, category, memo,
  // owed marks and splits of a transaction are never touched: only txn_overlay.payee_id changes.
  // Each transaction once, at its earliest bank row (a posted row and the pending row it took over share a key),
  // read in date order from the date index.
  const next = await s.all<{ txn_key: string; payee_id: string; merged_into: string | null; d: string }>(
    `SELECT b.txn_key, o.payee_id, p.merged_into, b.date AS d FROM bank_txn b
     JOIN txn_overlay o ON o.txn_key = b.txn_key
     JOIN payee p ON p.id = o.payee_id AND p.named_by = 'sync'
     WHERE b.budget_id = ?1 AND (b.date > ?2 OR (b.date = ?2 AND b.txn_key > ?3))
       AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key
         AND (x.date < b.date OR (x.date = b.date AND x.provider_txn_id < b.provider_txn_id)))
     ORDER BY b.date, b.txn_key LIMIT ?4`,
    after.date,
    after.key,
    REFILE_ROWS,
  );
  if (!next.length) return write([], { ...state, phase: 'finish' });
  const keys = next.map((t) => t.txn_key);
  const banks: RefileRow[] = [];
  for (const k of chunks(keys))
    banks.push(
      ...(await s.all<RefileRow>(
        `SELECT txn_key, raw_name, plaid_name, merchant_name, merchant_entity_id, pending, removed_at, first_apply_seq
         FROM bank_txn WHERE budget_id = ?1 AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
        ...k,
      )),
    );
  // Each transaction's row as Plaid sends it now: the live posted row, else the live pending one, else the newest.
  const rank = (r: RefileRow) => (r.removed_at === null ? (r.pending ? 1 : 2) : 0);
  const rowOf = new Map<string, RefileRow>();
  for (const r of banks) {
    const had = rowOf.get(r.txn_key);
    if (!had || rank(r) > rank(had) || (rank(r) === rank(had) && r.first_apply_seq > had.first_apply_seq))
      rowOf.set(r.txn_key, r);
  }
  const keysOf = new Map(keys.map((k) => [k, rowKeys(rowOf.get(k)!).keys]));
  const owners = (await loadOwners(s, [...keysOf.values()].flat())).keys;
  // An old payee that holds no key yet is used again for the first new payee its rows make, so its id (and links to
  // it) stay; it is named afresh by section 5.
  const olds = [...new Set(next.map((t) => t.payee_id))];
  const claimed = new Set([...owners.values(), ...next.filter((t) => t.merged_into).map((t) => t.payee_id)]);
  for (const k of chunks(olds))
    for (const a of await s.all<{ payee_id: string }>(
      `SELECT DISTINCT payee_id FROM payee_alias WHERE budget_id = ?1 AND (pattern IS NULL OR pattern LIKE 'n:%')
         AND payee_id IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
      ...k,
    ))
      claimed.add(a.payee_id);
  const stmts: Stmt[] = [];
  const moves = structuredClone(state.moves ?? {});
  let moved = state.moved ?? 0;
  let made = state.made ?? 0;
  for (const t of next) {
    const row = rowOf.get(t.txn_key)!;
    const ks = keysOf.get(t.txn_key)!;
    let payee = ks.map((k) => owners.get(k)).find((p) => p);
    if (!payee) {
      const name = newPayeeName(payeeSource(row));
      if (!claimed.has(t.payee_id)) {
        payee = t.payee_id;
        stmts.push(
          s.q(
            `UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
            payee,
            name,
            now,
          ),
        );
      } else {
        payee = ulid(now);
        made++;
        stmts.push(
          s.q(
            `INSERT INTO payee (id, budget_id, name, named_by, created_at, updated_at) VALUES (?2, ?1, ?3, 'sync', ?4, ?4)`,
            payee,
            name,
            now,
          ),
        );
      }
      claimed.add(payee);
    }
    for (const k of ks) {
      if (owners.has(k)) continue;
      owners.set(k, payee);
      stmts.push(insertKey(s, k, payee, now));
    }
    if (payee !== t.payee_id) {
      moved++;
      const m = (moves[t.payee_id] ??= {});
      m[payee] = (m[payee] ?? 0) + 1;
      stmts.push(
        s.q(
          `UPDATE txn_overlay SET payee_id = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2 AND payee_id = ?5`,
          t.txn_key,
          payee,
          now,
          t.payee_id,
        ),
      );
    }
  }
  const last = next[next.length - 1]!;
  return write(stmts, {
    ...state,
    phase: next.length < REFILE_ROWS ? 'finish' : 'refile',
    after: { date: last.d, key: last.txn_key },
    moves,
    moved,
    made,
    filed: (state.filed ?? 0) + next.length,
  });
}
