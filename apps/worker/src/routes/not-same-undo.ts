// Undo of Not the same (docs/payee-names.md 9.1): the toast after Not the same has Undo, which pairs the two rows
// again exactly as Yes would (routes/same-purchase.ts) and forgets the No. It reads which pair it was from the record
// Not the same wrote (audit_log), and pairs only while both rows are still as Not the same left them.
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { editNow } from '../http/clock.js';
import { newId } from '../http/ids.js';
import type { AppEnv } from '../http/context.js';
import type { Scoped } from '../db/scoped.js';
import { ACK, GONE, HttpError, scoped } from './api.js';
import { BANK_SQL, ENTRY_SQL, changed, fenced, type BankDb, type EntryDb } from './same-purchase.js';
import {
  ackAsks,
  coverStmts,
  forgetNotSameStmt,
  inheritStmts,
  loadNotSame,
  matchEntryStmts,
} from '../sync/pairing.js';

export const notSameUndoRoutes = new Hono<AppEnv>();

/** A posted row filed under its own key, with nothing linked to it since (a transfer, a payback, a refund). */
async function freePosted(s: Scoped, postedId: string): Promise<BankDb> {
  const q = await s.first<BankDb>(`${BANK_SQL} AND b.provider_txn_id = ?2`, postedId);
  if (!q || q.pending !== 0 || q.txn_key !== `p:${postedId}`) throw changed();
  const linked = await s.first(
    `SELECT 1 FROM txn_link WHERE budget_id = ?1 AND undone_at IS NULL AND (from_key = ?2 OR to_key = ?2)`,
    q.txn_key,
  );
  if (linked) throw changed();
  return q;
}

notSameUndoRoutes.post('/transactions/:key/not-same/undo', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const key = c.req.param('key');
  const rec = await s.first<{ after: string | null }>(
    `SELECT after FROM audit_log WHERE budget_id = ?1 AND action = 'txn.not_same' AND entity_id = ?2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    key,
  );
  const was = (rec?.after ? JSON.parse(rec.after) : null) as { cover?: string; posted?: string } | null;
  const otherId = was?.cover ?? was?.posted;
  if (!otherId) throw new HttpError(404, 'not_found', GONE);
  const other = `p:${otherId}`;
  // Undone already (the No is gone): nothing to do.
  if (!(await loadNotSame(s))(key, other)) return c.json(ACK);
  const done: Stmt[] = [
    forgetNotSameStmt(s, key, other),
    s.audit('txn.not_same.undo', 'transaction', key, null, was, now),
  ];

  const entry = await s.first<EntryDb>(`${ENTRY_SQL} AND m.txn_key = ?2`, key);
  if (was!.cover) {
    // Your entry covered the bank's pending row: it covers it again.
    if (!entry || entry.covers_provider_txn_id) throw changed();
    const p = await s.first<BankDb>(`${BANK_SQL} AND b.provider_txn_id = ?2`, otherId);
    if (!p || p.pending !== 1 || p.claimed) throw changed();
    const covered = await s.first(
      `SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND covers_provider_txn_id = ?2 AND deleted_at IS NULL AND matched_txn_key IS NULL`,
      otherId,
    );
    if (covered) throw changed();
    await s.batch([...coverStmts(s, key, otherId, now), ...done]);
    return c.json(ACK);
  }

  const q = await freePosted(s, otherId);
  if (entry) {
    // The posted row had taken your entry's key: it takes it again (and the pending row your entry covers, if any).
    await fenced(s, [...matchEntryStmts(s, otherId, entry, q.amount, 'user', now, newId(c)), ...done]);
    return c.json(ACK);
  }
  if (await s.first(`SELECT 1 FROM manual_pending WHERE budget_id = ?1 AND txn_key = ?2`, key))
    throw changed();
  // The posted row had taken the bank pending row's key: it takes it again. The pending row may be one the bank
  // removed since; it is claimed all the same, as processing claims it.
  const p = await s.first<{ amount: number; estimated_amount: number | null }>(
    `SELECT b.amount, o.estimated_amount FROM bank_txn b LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
     WHERE b.budget_id = ?1 AND b.txn_key = ?2 AND b.pending = 1
       AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)
     ORDER BY b.date, b.provider_txn_id LIMIT 1`,
    key,
  );
  if (!p) throw changed();
  await fenced(s, [
    ...inheritStmts(s, otherId, key, 'user', q.amount, p.estimated_amount ?? p.amount, now, newId(c)),
    ackAsks(s, other, now),
    ...done,
  ]);
  return c.json(ACK);
});
