// Settings → Payees: list, merge and rename.
import { Hono } from 'hono';
import { clock } from '../../http/clock.js';
import { MergePayees, RenamePayee, type PayeesView } from '@ledgerline/contracts';
import { clusterPayees } from '@ledgerline/domain';
import type { AppEnv } from '../../http/context.js';
import { parse, scoped } from '../api.js';

export const payeesRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- payees

payeesRoutes.get('/settings/payees', async (c) => {
  const s = scoped(c);
  const [p, raw] = await s.batch([
    s.q(
      `SELECT p.id, p.name, p.remember_category, c.name AS def, (SELECT count(*) FROM txn_overlay o WHERE o.budget_id = p.budget_id AND o.payee_id = p.id) AS n
       FROM payee p LEFT JOIN category c ON c.id = p.default_category_id WHERE p.budget_id = ?1 AND p.merged_into IS NULL ORDER BY n DESC LIMIT 300`,
    ),
    s.q(
      `SELECT v.raw_name AS raw, v.merchant_entity_id, v.payee AS merchant_name, v.payee_id, count(*) AS n FROM v_transaction v WHERE v.budget_id = ?1
       GROUP BY v.raw_name, v.payee_id ORDER BY n DESC LIMIT 500`,
    ),
  ]);
  const rawRows = raw!.results as {
    raw: string;
    merchant_entity_id: string | null;
    merchant_name: string | null;
    payee_id: string | null;
    n: number;
  }[];
  const clusters = clusterPayees(
    rawRows.map((r) => ({
      raw: r.raw,
      merchantEntityId: r.merchant_entity_id,
      merchantName: r.merchant_name,
      count: r.n,
    })),
  );
  const view: PayeesView = {
    suggestions: clusters
      .map((cl) => ({
        name: cl.name,
        rawNames: cl.members.map((m) => m.raw),
        transactions: cl.transactions,
        payeeIds: [
          ...new Set(
            cl.members
              .map((m) => rawRows.find((r) => r.raw === m.raw)?.payee_id)
              .filter((x): x is string => !!x),
          ),
        ],
      }))
      .filter((x) => x.payeeIds.length > 1),
    payees: (
      p!.results as { id: string; name: string; remember_category: number; def: string | null; n: number }[]
    ).map((x) => ({
      id: x.id,
      name: x.name,
      transactions: x.n,
      remember: x.remember_category === 1,
      defaultCategory: x.def,
    })),
  };
  return c.json(view);
});

payeesRoutes.post('/settings/payees/merge', async (c) => {
  const r = await parse(MergePayees, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const [keep, ...rest] = r.ids;
  const ph = rest.map((_, i) => `?${i + 3}`).join(',');
  // A merge writes alias rows (they now point at the kept payee); raw bank descriptions stay untouched.
  await s.batch([
    s.q(`UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`, keep, r.name, now),
    s.q(`UPDATE payee_alias SET payee_id = ?2 WHERE budget_id = ?1 AND payee_id IN (${ph})`, keep, ...rest),
    s.q(`UPDATE txn_overlay SET payee_id = ?2 WHERE budget_id = ?1 AND payee_id IN (${ph})`, keep, ...rest),
    s.q(
      `UPDATE payee SET merged_into = ?2, updated_at = ${now} WHERE budget_id = ?1 AND id IN (${ph})`,
      keep,
      ...rest,
    ),
    s.audit('payee.merge', 'payee', keep!, null, r, now),
  ]);
  return c.json({ ok: true });
});

payeesRoutes.post('/settings/payees/:id', async (c) => {
  const r = await parse(RenamePayee, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  await s.batch([
    s.q(
      `UPDATE payee SET name = ?3, remember_category = coalesce(?4, remember_category), updated_at = ?5 WHERE budget_id = ?1 AND id = ?2`,
      c.req.param('id'),
      r.name,
      r.remember === undefined ? null : r.remember ? 1 : 0,
      now,
    ),
    s.audit('payee.rename', 'payee', c.req.param('id'), null, r, now),
  ]);
  return c.json({ ok: true });
});
