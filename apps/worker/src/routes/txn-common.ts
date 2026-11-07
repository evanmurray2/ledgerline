// Shared by the Activity, transaction sheet, matching and transfer routes.
import type { Stmt } from '@ledgerline/db/sql';
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
  if (isHistory(t)) throw new HttpError(409, 'history', 'This is from before your budget, so it can’t be changed.');
}
