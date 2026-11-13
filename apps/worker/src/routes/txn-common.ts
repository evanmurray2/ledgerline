// Shared by the Activity, transaction sheet, matching and transfer routes.
import type { Stmt } from '@ledgerline/db/sql';
import type { OwedMark } from '@ledgerline/contracts';
import { cents, fractionOf } from '@ledgerline/domain';
import { ACK, HttpError, scoped, GONE } from './api.js';
import { isHistory } from '../views/rows.js';
import { structure } from '../views/common.js';
import { TX_COLUMNS, type TxRow } from '../ledger/ledger.js';
import type { Scoped } from '../db/scoped.js';
import { accountNames } from '../views/category.js';

export async function names(s: Scoped) {
  const { categories } = await structure(s);
  return { cats: new Map(categories.map((c) => [c.id, c.name])), accts: await accountNames(s) };
}

/** Runs the caller's writes as one batch; returns the mutation result. */
export async function commit(c: Parameters<typeof scoped>[0], writes: Stmt[]) {
  if (writes.length) await scoped(c).batch(writes);
  return ACK;
}

export async function loadTx(s: Scoped, key: string): Promise<TxRow> {
  const t = await s.first<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND key = ?2`,
    key,
  );
  if (!t) throw new HttpError(404, 'not_found', GONE);
  return t;
}

export const OVERLAY_UPSERT = `INSERT INTO txn_overlay (txn_key, budget_id, created_at, updated_at) VALUES (?2, ?1, ?3, ?3) ON CONFLICT (txn_key) DO NOTHING`;

/** Rows before the account's budget start are read-only (D-61): the budget never counts them, so nothing on them changes. */
export function refuseHistory(t: TxRow): void {
  if (isHistory(t))
    throw new HttpError(409, 'history', 'This is from before your budget, so it can’t be changed.');
}

/** The owed item for money out of `out` cents (negative), as the mark says. One per transaction: a new mark replaces it. */
export function owedStmt(s: Scoped, key: string, out: number, m: OwedMark, now: number): Stmt {
  if (out >= 0) throw new HttpError(422, 'not_outflow', 'Only money going out can be owed to you.');
  const x = cents(-out);
  const [num, den] =
    m.mode === 'half'
      ? [1, 2]
      : m.mode === 'even'
        ? [(m.n ?? 2) - 1, m.n ?? 2]
        : m.mode === 'all'
          ? [1, 1]
          : m.mode === 'fraction'
            ? [m.num ?? 1, m.den ?? 2]
            : [null, null];
  const amount = num !== null && den ? fractionOf(x, num, den) : cents(Math.min(m.amount ?? 0, x));
  if (amount <= 0) throw new HttpError(422, 'invalid', 'Enter how much is owed to you.');
  return s.q(
    `INSERT INTO expected_reimbursement (id, budget_id, txn_key, amount, fraction_num, fraction_den, expect_by, created_at, updated_at)
     VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, fraction_num = excluded.fraction_num, fraction_den = excluded.fraction_den,
       expect_by = excluded.expect_by, canceled_at = NULL, closed_at = NULL, updated_at = excluded.updated_at`,
    `${key}:owed`,
    key,
    amount,
    num,
    den,
    m.expectBy,
    now,
  );
}
