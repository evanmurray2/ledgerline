// Undo for Activity's one-tap answers that change no money: No on a "Same purchase?" card asks the question again,
// and OK on a "Removed by the bank" row shows the row again.
import { Hono } from 'hono';
import { SamePurchaseUndo } from '@ledgerline/contracts';
import { editNow } from '../http/clock.js';
import type { AppEnv } from '../http/context.js';
import { ACK, CHANGED, HttpError, parse, scoped } from './api.js';
import { ASK_TYPES, forgetNotSameStmt } from '../sync/pairing.js';

export const activityUndoRoutes = new Hono<AppEnv>();

/** Undo of No (routes/same-purchase.ts): forgets the No and puts the row back on the card. */
activityUndoRoutes.post('/same-purchase/:id/undo', async (c) => {
  const r = await parse(SamePurchaseUndo, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const a = await s.first<{ id: string; ref_key: string; data: string | null }>(
    `SELECT id, ref_key, data FROM alert WHERE budget_id = ?1 AND id = ?2 AND type IN ${ASK_TYPES}`,
    c.req.param('id'),
  );
  if (!a) throw new HttpError(409, 'changed', CHANGED);
  const data = (a.data ? JSON.parse(a.data) : {}) as { candidates?: string[] };
  const candidates = [...new Set([...(data.candidates ?? []), r.key])];
  await s.batch([
    forgetNotSameStmt(s, a.ref_key, r.key),
    s.q(
      `UPDATE alert SET data = ?3, acked_at = NULL WHERE budget_id = ?1 AND id = ?2`,
      a.id,
      JSON.stringify({ ...data, candidates }),
    ),
    s.audit('same_purchase.no.undo', 'transaction', a.ref_key, null, { key: r.key }, now),
  ]);
  return c.json(ACK);
});

/** Undo of OK on a "Removed by the bank" row: the alert shows again. */
activityUndoRoutes.post('/alerts/:id/undo', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const a = await s.first<{ id: string }>(
    `SELECT id FROM alert WHERE budget_id = ?1 AND id = ?2 AND type = 'vanished_pending'`,
    id,
  );
  if (!a) throw new HttpError(409, 'changed', CHANGED);
  await s.batch([
    s.q(`UPDATE alert SET acked_at = NULL WHERE budget_id = ?1 AND id = ?2`, id),
    s.audit('alert.dismiss.undo', 'alert', id, null, null, now),
  ]);
  return c.json(ACK);
});
