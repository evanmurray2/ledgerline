// Settings → Rules: list, save, live preview, apply to past transactions, delete and export.
import type { Stmt } from '@ledgerline/db/sql';
import { Hono } from 'hono';
import { clock } from '../../http/clock.js';
import { RuleBody, type RulePreview, type RulesView } from '@ledgerline/contracts';
import { type Rule, addDays, cents, evaluateRules, formatCents, treeHolds } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../../http/context.js';
import { ACK, HttpError, parse, scoped } from '../api.js';
import { structure } from '../../views/common.js';
import { listRow } from '../../views/rows.js';
import { TX_COLUMNS, type TxRow } from '../../ledger/ledger.js';
import type { Scoped } from '../../db/scoped.js';

export const rulesRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- rules

function ruleSummary(r: RuleBody): string {
  const when = r.conditions.all
    .map((x) =>
      x.field === 'payee'
        ? `payee ${x.op} “${x.value}”`
        : x.field === 'description'
          ? `description ${x.op} “${x.value}”`
          : x.field === 'amount'
            ? x.op === 'equals'
              ? `amount ${formatCents(x.value)}`
              : `amount ${formatCents(x.min)}–${formatCents(x.max)}`
            : x.field === 'direction'
              ? `money ${x.value}`
              : x.field === 'day_of_month'
                ? `day ${x.min}–${x.max}`
                : `${x.field} ${'value' in x ? x.value : ''}`,
    )
    .join(' and ');
  return `When ${when || 'any transaction'}`;
}

rulesRoutes.get('/settings/rules', async (c) => {
  const s = scoped(c);
  const rows = await s.all<{
    id: string;
    name: string;
    conditions: string;
    actions: string;
    apply_to_pending: number;
    stop_after: number;
    enabled: number;
  }>(
    `SELECT id, name, conditions, actions, apply_to_pending, stop_after, enabled FROM rule WHERE budget_id = ?1 ORDER BY sort`,
  );
  const counts = await s.all<{ rule_id: string; n: number }>(
    `SELECT o.rule_id, count(*) AS n FROM txn_overlay o JOIN v_transaction v ON v.budget_id = o.budget_id AND v.key = o.txn_key
     WHERE o.budget_id = ?1 AND o.rule_id IS NOT NULL AND v.date >= date('now', '-90 days') GROUP BY o.rule_id`,
  );
  const n = new Map(counts.map((x) => [x.rule_id, x.n]));
  const view: RulesView = {
    rules: rows.map((r) => {
      const body: RuleBody = {
        id: r.id,
        name: r.name,
        conditions: JSON.parse(r.conditions),
        actions: JSON.parse(r.actions),
        applyToPending: r.apply_to_pending === 1,
        stopAfter: r.stop_after === 1,
        enabled: r.enabled === 1,
      };
      return { ...body, id: r.id, summary: ruleSummary(body), matches90d: n.get(r.id) ?? 0 };
    }),
  };
  return c.json(view);
});

rulesRoutes.post('/settings/rules', async (c) => {
  const r = await parse(RuleBody, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = r.id ?? ulid(now);
  const max = await s.first<{ m: number | null }>(`SELECT max(sort) AS m FROM rule WHERE budget_id = ?1`);
  await s.batch([
    s.q(
      `INSERT INTO rule (id, budget_id, sort, name, conditions, actions, apply_to_pending, stop_after, enabled, created_at, updated_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, conditions = excluded.conditions, actions = excluded.actions,
         apply_to_pending = excluded.apply_to_pending, stop_after = excluded.stop_after, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      id,
      (max?.m ?? 0) + 1,
      r.name,
      JSON.stringify(r.conditions),
      JSON.stringify(r.actions),
      r.applyToPending ? 1 : 0,
      r.stopAfter ? 1 : 0,
      r.enabled ? 1 : 0,
      now,
    ),
    s.audit(r.id ? 'rule.edit' : 'rule.add', 'rule', id, null, r, now),
  ]);
  return c.json({ ok: true, id });
});

async function recentTxns(s: Scoped, days: number): Promise<TxRow[]> {
  return s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND date >= ?2 ORDER BY date DESC LIMIT 2000`,
    addDays(new Date().toISOString().slice(0, 10), -days),
  );
}

function asRule(r: RuleBody, id = 'preview'): Rule {
  return {
    id,
    name: r.name,
    conditions: r.conditions as Rule['conditions'],
    actions: r.actions as Rule['actions'],
    applyToPending: r.applyToPending,
    stopAfter: r.stopAfter,
    enabled: true,
  };
}

function ruleTxn(t: TxRow) {
  return {
    payeeId: t.payee_id,
    payeeName: t.payee,
    description: t.raw_name,
    accountId: t.account_id,
    amount: cents(t.amount),
    date: t.date,
    pending: t.status === 'pending',
    providerCategory: t.provider_category,
  };
}

rulesRoutes.post('/settings/rules/preview', async (c) => {
  const r = await parse(RuleBody, c.req.raw);
  const s = scoped(c);
  const txs = await recentTxns(s, 90);
  const rule = asRule(r);
  const hits = txs.filter((t) => treeHolds(rule.conditions, ruleTxn(t)));
  const { categories } = await structure(s);
  const cats = new Map(categories.map((x) => [x.id, x.name]));
  const accts = new Map(
    (await s.all<{ id: string; name: string }>(`SELECT id, name FROM account WHERE budget_id = ?1`)).map(
      (a) => [a.id, a.name],
    ),
  );
  const view: RulePreview = {
    matches: hits.slice(0, 50).map((t) => listRow(t, accts, cats)),
    uncategorizedMatches: hits.filter((t) => !t.category_id && !t.to_rta && !t.transfer_state && !t.wtm_state)
      .length,
  };
  return c.json(view);
});

rulesRoutes.post('/settings/rules/:id/apply', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const row = await s.first<{
    id: string;
    name: string;
    conditions: string;
    actions: string;
    apply_to_pending: number;
    stop_after: number;
  }>(
    `SELECT id, name, conditions, actions, apply_to_pending, stop_after FROM rule WHERE budget_id = ?1 AND id = ?2`,
    c.req.param('id'),
  );
  if (!row) throw new HttpError(404, 'not_found', 'rule');
  const rule: Rule = {
    id: row.id,
    name: row.name,
    conditions: JSON.parse(row.conditions),
    actions: JSON.parse(row.actions),
    applyToPending: row.apply_to_pending === 1,
    stopAfter: row.stop_after === 1,
    enabled: true,
  };
  // Applies only to uncategorized history: rules never overwrite a category you set by hand.
  const txs = (await recentTxns(s, 3650)).filter(
    (t) => !t.category_id && !t.to_rta && !t.transfer_state && !t.wtm_state && t.categorized_by !== 'user',
  );
  const w: Stmt[] = [];
  const keys: string[] = [];
  for (const t of txs) {
    const res = evaluateRules(ruleTxn(t), [rule], null);
    if (!res.categoryId) continue;
    keys.push(t.key);
    w.push(
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, category_id, categorized_by, rule_id, created_at, updated_at) VALUES (?2, ?1, ?3, 'rule', ?4, ?5, ?5)
         ON CONFLICT (txn_key) DO UPDATE SET category_id = excluded.category_id, categorized_by = 'rule', rule_id = excluded.rule_id, updated_at = excluded.updated_at
         WHERE txn_overlay.categorized_by IS NULL OR txn_overlay.categorized_by != 'user'`,
        t.key,
        res.categoryId,
        rule.id,
        now,
      ),
    );
    if (keys.length >= 150) break;
  }
  if (w.length) await s.batch(w);
  return c.json(ACK);
});

rulesRoutes.delete('/settings/rules/:id', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  await s.batch([
    s.q(`DELETE FROM rule WHERE budget_id = ?1 AND id = ?2`, c.req.param('id')),
    s.audit('rule.delete', 'rule', c.req.param('id'), null, null, now),
  ]);
  return c.json({ ok: true });
});

rulesRoutes.get('/settings/rules/export', async (c) => {
  const s = scoped(c);
  const rows = await s.all<{
    name: string;
    conditions: string;
    actions: string;
    apply_to_pending: number;
    stop_after: number;
    enabled: number;
  }>(
    `SELECT name, conditions, actions, apply_to_pending, stop_after, enabled FROM rule WHERE budget_id = ?1 ORDER BY sort`,
  );
  const body = rows.map((r) => ({
    name: r.name,
    conditions: JSON.parse(r.conditions),
    actions: JSON.parse(r.actions),
    applyToPending: !!r.apply_to_pending,
    stopAfter: !!r.stop_after,
    enabled: !!r.enabled,
  }));
  return new Response(JSON.stringify({ rules: body }, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="ledgerline-rules.json"',
    },
  });
});
