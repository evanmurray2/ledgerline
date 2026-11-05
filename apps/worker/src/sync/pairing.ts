// The writes that pair two rows as one purchase, shared by processing (pending-match.ts) and your answers to "Same
// purchase?" (routes/same-purchase.ts): a posted row takes over another row's key; a posted row takes your entry's
// key; your entry covers the bank's pending row (docs/payee-names.md 9.1, 9.2). Each returns statements for the
// caller's one batch.
import type { Stmt } from '@ledgerline/db/sql';
import { notSameKeys } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';

/** The alerts that ask about a row's pairing: "Same purchase?", and several close candidates with different edits. */
export const ASK_TYPES = `('same_purchase', 'ambiguous_match')`;

/**
 * A posted row takes over the key of the row it replaces (a bank pending row, a removed posted row, or your entry),
 * and so its overlay: its category, memo, splits and owed marks.
 */
export function inheritStmts(
  s: Scoped,
  postedId: string,
  fromKey: string,
  by: 'provider' | 'auto' | 'user',
  postedAmount: number,
  expected: number | null,
  now: number,
): Stmt[] {
  const stmts: Stmt[] = [
    s.q(
      `UPDATE bank_txn SET txn_key = ?3, updated_at = ?4 WHERE budget_id = ?1 AND provider_txn_id = ?2`,
      postedId,
      fromKey,
      now,
    ),
    // An edit made offline to the posted row's own key lands on the key it now has (docs/phone-budget.md section 12).
    s.db
      .prepare(`INSERT OR REPLACE INTO txn_key_move (old_key, new_key, at) VALUES (?1, ?2, ?3)`)
      .bind(`p:${postedId}`, fromKey, now),
    // What you set on the posted row itself before it claimed the pending row (a category from a rule or the payee, a
    // memo) fills what the pending row leaves empty; a category you chose on the pending row always wins.
    fillFrom(s, fromKey, `'p:' || ?3`, postedId, now),
  ];
  const alerts: string[] = [];
  if (expected !== null && expected !== postedAmount)
    alerts.push(`amount_changed:${expected}:${postedAmount}`);
  // A posted charge always counts (design: the posted amount wins): won't clear is cleared on every match, whichever
  // rule made it, and flagged when it was set. The flag is read from the overlay itself, so no path can miss it.
  // A pending row removed earlier and claimed now is no longer orphaned.
  stmts.push(
    s.q(
      `INSERT INTO txn_overlay (txn_key, budget_id, alert, wont_clear, created_at, updated_at) VALUES (?2, ?1, ?3, 0, ?4, ?4)
       ON CONFLICT (txn_key) DO UPDATE SET
         alert = CASE WHEN txn_overlay.wont_clear = 1
           THEN json_insert(coalesce(excluded.alert, '[]'), '$[#]', 'cleared_despite_wont_clear')
           ELSE coalesce(excluded.alert, txn_overlay.alert) END,
         wont_clear = 0, estimated_amount = NULL, orphaned_at = NULL, updated_at = excluded.updated_at`,
      fromKey,
      alerts.length ? JSON.stringify(alerts) : null,
      now,
    ),
    s.q(
      `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'pending_match', ?3, ?4, ?5, ?6)`,
      ulid(now),
      `p:${postedId}`,
      fromKey,
      by,
      now,
    ),
    s.q(
      `UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND type = 'vanished_pending' AND ref_key = ?2 AND acked_at IS NULL`,
      fromKey,
      now,
    ),
    // The posted row is paired: nothing is left to ask about it.
    ackAsks(s, `p:${postedId}`, now),
  );
  return stmts;
}

/**
 * What the overlay of `fromKeySql` (a SQL expression over ?3) has fills what the overlay of `toKey` leaves empty: a
 * category (unless you chose one there), the payee, the memo, and with `month` the budget month.
 */
function fillFrom(
  s: Scoped,
  toKey: string,
  fromKeySql: string,
  arg: string,
  now: number,
  month = false,
): Stmt {
  const src = `(SELECT o.%c FROM txn_overlay o WHERE o.txn_key = ${fromKeySql})`;
  const col = (c: string) => src.replace('%c', c);
  return s.q(
    `UPDATE txn_overlay SET
       category_id = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN category_id ELSE ${col('category_id')} END,
       categorized_by = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN categorized_by ELSE ${col('categorized_by')} END,
       rule_id = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN rule_id ELSE ${col('rule_id')} END,
       payee_id = coalesce(${col('payee_id')}, payee_id),
       memo = coalesce(memo, ${col('memo')}),${
         month
           ? `
       budget_month = coalesce(budget_month, ${col('budget_month')}),`
           : ''
       }
       updated_at = ?4
     WHERE budget_id = ?1 AND txn_key = ?2 AND ${fromKeySql} != ?2 AND EXISTS (SELECT 1 FROM txn_overlay o WHERE o.txn_key = ${fromKeySql})`,
    toKey,
    arg,
    now,
  );
}

export interface Entry {
  txn_key: string;
  amount: number;
  covers_provider_txn_id: string | null;
}

/**
 * A posted row and your entry are one purchase (9.2): the posted row takes the entry's key (inherit), the entry is
 * matched, and the bank pending row the entry covers, if any, is claimed with it: it takes the same key, so it's done,
 * and what you set on it fills what the entry leaves empty. The cover stays recorded: Not the same brings it back.
 */
export function matchEntryStmts(
  s: Scoped,
  postedId: string,
  e: Entry,
  postedAmount: number,
  by: 'auto' | 'user',
  now: number,
): Stmt[] {
  const stmts: Stmt[] = [];
  if (e.covers_provider_txn_id) {
    const covered = e.covers_provider_txn_id;
    const keyOf = `(SELECT b.txn_key FROM bank_txn b WHERE b.budget_id = ?1 AND b.provider_txn_id = ?3)`;
    // Only while no other posted row has claimed it.
    const free = `NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = ${keyOf} AND x.pending = 0 AND x.removed_at IS NULL)`;
    stmts.push(
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, created_at, updated_at) VALUES (?2, ?1, ?3, ?3) ON CONFLICT (txn_key) DO NOTHING`,
        e.txn_key,
        now,
      ),
      fillFrom(s, e.txn_key, keyOf, covered, now, true),
      s.q(
        `INSERT OR REPLACE INTO txn_key_move (old_key, new_key, at) SELECT ${keyOf}, ?2, ?4 WHERE ${free} AND ${keyOf} != ?2`,
        e.txn_key,
        covered,
        now,
      ),
      s.q(
        `UPDATE bank_txn SET txn_key = ?2, updated_at = ?4 WHERE budget_id = ?1 AND provider_txn_id = ?3 AND pending = 1 AND ${free}`,
        e.txn_key,
        covered,
        now,
      ),
      ackAsks(s, `p:${covered}`, now),
    );
  }
  stmts.push(
    ...inheritStmts(s, postedId, e.txn_key, by, postedAmount, e.amount, now),
    s.q(
      `UPDATE manual_pending SET matched_txn_key = ?2, matched_by = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
      e.txn_key,
      by,
      now,
    ),
  );
  return stmts;
}

/** Your entry covers the bank's pending row (9.2): the bank row is hidden and stops counting; nothing else moves. */
export function coverStmts(s: Scoped, entryKey: string, pendingId: string, now: number): Stmt[] {
  return [
    s.q(
      `UPDATE manual_pending SET covers_provider_txn_id = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2`,
      entryKey,
      pendingId,
      now,
    ),
    ackAsks(s, `p:${pendingId}`, now),
  ];
}

/**
 * A bank row gets its own key back (`p:` and its provider id): when the provider's link wins over a pair made without
 * it (D-47), and on Not the same for a posted row that took a bank pending row's key.
 */
export function ownKeyStmt(s: Scoped, providerId: string, now: number): Stmt {
  return s.q(
    `UPDATE bank_txn SET txn_key = 'p:' || provider_txn_id, updated_at = ?3 WHERE budget_id = ?1 AND provider_txn_id = ?2`,
    providerId,
    now,
  );
}

/** Every open question about this row is answered. */
export function ackAsks(s: Scoped, ref: string, now: number): Stmt {
  return s.q(
    `UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND type IN ${ASK_TYPES} AND ref_key = ?2 AND acked_at IS NULL`,
    ref,
    now,
  );
}

/**
 * "Same purchase?" about a bank row (its own key), with its candidates. Written only when it changes, so a sync that
 * asks again writes nothing; new candidates ask again even after an earlier answer.
 */
export function askStmt(s: Scoped, ref: string, candidates: string[], now: number): Stmt {
  return s.q(
    `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?2, ?1, 'same_purchase', ?3, ?4, ?5)
     ON CONFLICT (budget_id, type, ref_key) DO UPDATE SET data = excluded.data, acked_at = NULL
       WHERE alert.data IS NOT excluded.data`,
    ulid(now),
    ref,
    JSON.stringify({ candidates }),
    now,
  );
}

/** Remembers No for a pair: never asked again, never paired by itself. */
export function notSameStmt(s: Scoped, x: string, y: string, now: number): Stmt {
  const [a, b] = notSameKeys(x, y);
  return s.q(
    `INSERT INTO not_same (budget_id, a_key, b_key, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`,
    a,
    b,
    now,
  );
}

/** The pairs you answered No to, as a lookup. */
export async function loadNotSame(s: Scoped): Promise<(x: string, y: string) => boolean> {
  const rows = await s.all<{ a_key: string; b_key: string }>(
    `SELECT a_key, b_key FROM not_same WHERE budget_id = ?1`,
  );
  if (!rows.length) return () => false;
  const set = new Set(rows.map((r) => `${r.a_key}\u0000${r.b_key}`));
  return (x, y) => {
    const [a, b] = notSameKeys(x, y);
    return set.has(`${a}\u0000${b}`);
  };
}
