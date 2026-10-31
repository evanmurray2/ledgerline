import { Hono } from 'hono';
import { clock } from '../http/clock.js';
import {
  ArchiveRequest,
  CategoryUpsert,
  GroupUpsert,
  LinkExchange,
  LinkTokenRequest,
  MergePayees,
  RenamePayee,
  ReorderRequest,
  RuleBody,
  SettingsPatch,
  SetupStart,
  StartingBalances,
  type CategoriesView,
  type ConnectionsView,
  type PayeesView,
  type RulePreview,
  type RulesView,
} from '@ledgerline/contracts';
import {
  type Month,
  type Rule,
  addDays,
  cents,
  clusterPayees,
  evaluateRules,
  formatCents,
  localDate,
  monthOfDate,
  treeHolds,
} from '@ledgerline/domain';
import { encryptToken, parseKeyring, ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { HttpError, afterWrite, parse, scoped, startRecompute } from './api.js';
import { fresh, monthResult, structure } from '../views/common.js';
import { listRow } from '../views/rows.js';
import {
  TX_COLUMNS,
  budgetMeta,
  planLineRebuild,
  planStartLines,
  toLedgerAccount,
  type AccountRowDb,
  type TxRow,
} from '../ledger/ledger.js';
import { makeProvider } from '../sync/provider.js';
import { acquire, requestSync } from '../sync/lease.js';
import { markDirty } from '../budget/recompute.js';
import type { Scoped } from '../db/scoped.js';
import type { Env } from '../env.js';

export const settingsRoutes = new Hono<AppEnv>();

/** Plaid Trial: 10 Production Items for the life of the team; removed Items still count. */
export const ITEM_LIMIT = 10;

// ---------------------------------------------------------------- categories and groups

settingsRoutes.get('/settings/categories', async (c) => {
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env));
  const { categories, groups, targets } = await structure(s);
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const mr = await monthResult(s, f.current, start);
  const meta = (id: string, kind: string) => {
    if (kind === 'cc_payment') return 'One per card';
    const v = (targets.get(id) ?? []).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]?.target;
    const t = !v
      ? 'No target'
      : v.type === 'refill'
        ? `Refill ${v.periodMonths === 1 ? 'monthly' : `every ${v.periodMonths} months`} · ${formatCents(v.amount)}`
        : v.type === 'set_aside'
          ? `Set aside ${formatCents(v.amount)} monthly`
          : v.type === 'by_date'
            ? `${formatCents(v.amount)} by ${v.targetMonth}`
            : `${formatCents(v.amount)}${v.monthly ? `, ${formatCents(v.monthly)} monthly` : ''}`;
    return kind === 'saving' ? `Saving or investing · ${t}` : t;
  };
  const cardCats = categories.filter((x) => x.kind === 'cc_payment' && !x.archived_at);
  const view: CategoriesView = {
    groups: [
      ...(cardCats.length
        ? [
            {
              id: 'cards',
              name: 'Credit card payments',
              isBills: false,
              system: true,
              categories: cardCats.map((x) => ({
                id: x.id,
                name: x.name,
                kind: x.kind,
                meta: meta(x.id, x.kind),
                available: cents(0),
              })),
            },
          ]
        : []),
      ...groups
        .filter((g) => !g.archived_at)
        .map((g) => ({
          id: g.id,
          name: g.name,
          isBills: g.is_bills === 1,
          system: false,
          categories: categories
            .filter((x) => x.group_id === g.id && !x.archived_at && x.kind !== 'cc_payment')
            .map((x) => ({
              id: x.id,
              name: x.name,
              kind: x.kind,
              meta: meta(x.id, x.kind),
              available: cents(mr?.categories[x.id]?.available ?? 0),
            })),
        })),
    ],
    archived: categories
      .filter((x) => x.archived_at)
      .map((x) => ({
        id: x.id,
        name: x.name,
        meta: `Archived ${new Date(x.archived_at!).toISOString().slice(0, 7)}`,
      })),
  };
  return c.json(view);
});

settingsRoutes.post('/settings/categories', async (c) => {
  const r = await parse(CategoryUpsert, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  if (r.groupId) {
    const g = await s.first(`SELECT id FROM category_group WHERE budget_id = ?1 AND id = ?2`, r.groupId);
    if (!g) throw new HttpError(404, 'not_found', 'group');
  }
  const id = r.id ?? ulid(now);
  if (r.id) {
    const ex = await s.first<{ kind: string }>(
      `SELECT kind FROM category WHERE budget_id = ?1 AND id = ?2`,
      r.id,
    );
    if (!ex) throw new HttpError(404, 'not_found', 'category');
    if (ex.kind === 'cc_payment')
      throw new HttpError(422, 'system', 'Card payment categories are made by the app');
    await s.batch([
      s.q(
        `UPDATE category SET name = ?3, group_id = ?4, kind = ?5, due_day = ?6, low_threshold = ?7, updated_at = ?8 WHERE budget_id = ?1 AND id = ?2`,
        id,
        r.name,
        r.groupId,
        r.kind,
        r.dueDay ?? null,
        r.lowThreshold ?? null,
        now,
      ),
      s.audit('category.edit', 'category', id, null, r, now),
    ]);
  } else {
    const max = await s.first<{ m: number | null }>(
      `SELECT max(sort) AS m FROM category WHERE budget_id = ?1`,
    );
    await s.batch([
      s.q(
        `INSERT INTO category (id, budget_id, group_id, name, kind, due_day, low_threshold, sort, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        id,
        r.groupId,
        r.name,
        r.kind,
        r.dueDay ?? null,
        r.lowThreshold ?? null,
        (max?.m ?? 0) + 1,
        now,
      ),
      s.audit('category.add', 'category', id, null, r, now),
    ]);
  }
  return c.json({ ok: true, id });
});

settingsRoutes.post('/settings/groups', async (c) => {
  const r = await parse(GroupUpsert, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = r.id ?? ulid(now);
  if (r.id)
    await s.run(
      `UPDATE category_group SET name = ?3, is_bills = ?4, updated_at = ?5 WHERE budget_id = ?1 AND id = ?2`,
      id,
      r.name,
      r.isBills ? 1 : 0,
      now,
    );
  else {
    const max = await s.first<{ m: number | null }>(
      `SELECT max(sort) AS m FROM category_group WHERE budget_id = ?1`,
    );
    await s.run(
      `INSERT INTO category_group (id, budget_id, name, is_bills, sort, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?6)`,
      id,
      r.name,
      r.isBills ? 1 : 0,
      (max?.m ?? 0) + 1,
      now,
    );
  }
  return c.json({ ok: true, id });
});

settingsRoutes.post('/settings/categories/:id/archive', async (c) => {
  const r = await parse(ArchiveRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const cat = await s.first<{ kind: string }>(
    `SELECT kind FROM category WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!cat) throw new HttpError(404, 'not_found', 'category');
  if (cat.kind === 'cc_payment')
    throw new HttpError(422, 'system', 'Card payment categories can’t be archived');
  const w: D1PreparedStatement[] = [
    s.q(
      `UPDATE category SET archived_at = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
      id,
      r.archived ? now : null,
      now,
    ),
  ];
  if (r.archived) {
    // Archiving one that still has money moves the money to Ready to Assign first.
    const f = await fresh(c.env, s, now);
    const start = (f.budget.budget_start_month ?? f.current) as Month;
    const mr = await monthResult(s, f.current, start);
    const avail = mr?.categories[id]?.available ?? 0;
    if (avail > 0) {
      w.push(
        s.q(
          `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (budget_id, month, category_id) DO UPDATE SET amount = assignment.amount + excluded.amount, updated_at = excluded.updated_at`,
          id,
          f.current,
          -avail,
          now,
        ),
        markDirty(s.db, s.budgetId, f.current, now),
      );
    }
  }
  w.push(s.audit(r.archived ? 'category.archive' : 'category.restore', 'category', id, null, null, now));
  await s.batch(w);
  return c.json(await afterWrite(c.env, s.budgetId, now));
});

settingsRoutes.post('/settings/categories/reorder', async (c) => {
  const r = await parse(ReorderRequest, c.req.raw);
  const s = scoped(c);
  await s.batch(
    r.ids.map((id, i) => s.q(`UPDATE category SET sort = ?3 WHERE budget_id = ?1 AND id = ?2`, id, i)),
  );
  return c.json({ ok: true });
});

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

settingsRoutes.get('/settings/rules', async (c) => {
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

settingsRoutes.post('/settings/rules', async (c) => {
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

settingsRoutes.post('/settings/rules/preview', async (c) => {
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

settingsRoutes.post('/settings/rules/:id/apply', async (c) => {
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
  const w: D1PreparedStatement[] = [];
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
  const meta = await budgetMeta(s);
  if (meta && keys.length) {
    const plan = await planLineRebuild(s, keys, meta, localDate(now, meta.timeZone), now);
    await s.batch(plan.stmts);
  }
  return c.json(await afterWrite(c.env, s.budgetId, now));
});

settingsRoutes.delete('/settings/rules/:id', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  await s.batch([
    s.q(`DELETE FROM rule WHERE budget_id = ?1 AND id = ?2`, c.req.param('id')),
    s.audit('rule.delete', 'rule', c.req.param('id'), null, null, now),
  ]);
  return c.json({ ok: true });
});

settingsRoutes.get('/settings/rules/export', async (c) => {
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

// ---------------------------------------------------------------- payees

settingsRoutes.get('/settings/payees', async (c) => {
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

settingsRoutes.post('/settings/payees/merge', async (c) => {
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

settingsRoutes.post('/settings/payees/:id', async (c) => {
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

// ---------------------------------------------------------------- bank connections

settingsRoutes.get('/settings/connections', async (c) => {
  const s = scoped(c);
  const rows = await s.all<{
    id: string;
    institution_name: string;
    status: string;
    last_synced_at: number | null;
    linked_at: number;
    accounts: string | null;
    removed_at: number | null;
  }>(
    `SELECT c.id, c.institution_name, c.status, c.last_synced_at, c.linked_at, c.removed_at,
       (SELECT group_concat(name, ', ') FROM provider_account p WHERE p.connection_id = c.id) AS accounts
     FROM connection c WHERE c.budget_id = ?1 AND c.provider = 'plaid' ORDER BY c.linked_at`,
  );
  const view: ConnectionsView = {
    used: rows.length,
    limit: ITEM_LIMIT,
    environment: c.env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
    items: rows.map((r) => ({
      id: r.id,
      institution: r.institution_name,
      accounts: r.accounts ?? '',
      status: r.removed_at ? 'removed' : (r.status as 'ok' | 'login_required' | 'error'),
      lastSynced: r.last_synced_at,
      linkedAt: r.linked_at,
    })),
  };
  return c.json(view);
});

settingsRoutes.post('/settings/connections/link-token', async (c) => {
  const r = await parse(LinkTokenRequest, c.req.raw);
  const s = scoped(c);
  const provider = makeProvider(c.env);
  if (r.mode === 'repair') {
    // Update mode reuses the Item; it never uses a new slot.
    if (!r.connectionId) throw new HttpError(400, 'invalid', 'connectionId');
    const { connectionToken } = await import('../sync/provider.js');
    const token = await connectionToken(c.env, r.connectionId);
    const lt = await provider.createLinkSession({
      mode: 'repair',
      accessToken: token,
      userId: c.get('userId'),
    });
    return c.json({ linkToken: lt.linkToken });
  }
  const used = await s.first<{ n: number }>(
    `SELECT count(*) AS n FROM connection WHERE budget_id = ?1 AND provider = 'plaid'`,
  );
  if ((used?.n ?? 0) >= ITEM_LIMIT) throw new HttpError(409, 'item_limit', 'All 10 bank links are used');
  if (c.env.PLAID_ENV === 'production' && !r.confirmSlot)
    throw new HttpError(409, 'confirm_slot', 'Confirm using one of your remaining bank links');
  const lt = await provider.createLinkSession({ mode: 'new', userId: c.get('userId') });
  return c.json({ linkToken: lt.linkToken });
});

/** Maps a provider account to a budget account kind; investment and loan accounts are not linked in v1. */
export function accountKind(type: string, subtype: string | null): 'checking' | 'savings' | 'credit' | null {
  if (type === 'credit') return 'credit';
  if (type === 'depository')
    return subtype === 'savings' || subtype === 'money market' || subtype === 'cd' || subtype === 'hsa'
      ? 'savings'
      : 'checking';
  return null;
}

export async function completeLink(
  env: Env,
  s: Scoped,
  accessToken: string,
  itemId: string,
  institution: string,
  now: number,
): Promise<{
  connectionId: string;
  accounts: { id: string; name: string; kind: string; startingBalance: number }[];
}> {
  const connectionId = `con_${ulid(now)}`;
  const enc = await encryptToken(
    parseKeyring(env.TOKEN_KEYS, env.TOKEN_KEY_CURRENT),
    accessToken,
    connectionId,
  );
  const provider = makeProvider(env);
  const accts = await provider.getAccounts({ id: connectionId, accessToken, providerItemId: itemId });
  const b = await s.first<{ budget_start_month: string | null; time_zone: string }>(
    `SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`,
  );
  const today = localDate(now, b?.time_zone ?? 'America/Los_Angeles');
  const startDate = b?.budget_start_month ? `${b.budget_start_month}-01` : today;
  // Each account budgets from the later of the budget start and the date it was linked (Budget start).
  const budgetFrom = today > startDate ? today : startDate;
  const w: D1PreparedStatement[] = [
    s.q(
      `INSERT INTO connection (id, budget_id, provider, provider_item_id, institution_name, access_token_enc, key_version, days_requested, linked_at, created_at, updated_at)
       VALUES (?2, ?1, 'plaid', ?3, ?4, ?5, ?6, 180, ?7, ?7, ?7)`,
      connectionId,
      itemId,
      institution,
      enc.enc,
      enc.keyVersion,
      now,
    ),
  ];
  const out: { id: string; name: string; kind: string; startingBalance: number }[] = [];
  for (const a of accts) {
    w.push(
      s.q(
        `INSERT INTO provider_account (id, budget_id, connection_id, provider_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, credit_limit, iso_currency, balance_as_of, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?14)`,
        ulid(now),
        connectionId,
        a.providerAccountId,
        a.name,
        a.officialName,
        a.type,
        a.subtype,
        a.mask,
        a.currentBalance,
        a.availableBalance,
        a.creditLimit,
        a.isoCurrency,
        now,
      ),
    );
    const kind = accountKind(a.type, a.subtype);
    if (!kind) continue;
    const id = `acc_${ulid(now)}`;
    // Starting balance = current balance at link, treated as excluding pending; you confirm or correct it.
    const startingBalance = kind === 'credit' ? -(a.currentBalance ?? 0) : (a.currentBalance ?? 0);
    w.push(
      s.q(
        `INSERT INTO account (id, budget_id, provider_account_id, name, role, kind, budget_from, starting_balance, opening_anchor, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, 'budget', ?5, ?6, ?7, ?7, ?8, ?8)`,
        id,
        a.providerAccountId,
        a.name,
        kind,
        budgetFrom,
        startingBalance,
        now,
      ),
    );
    if (kind === 'credit') {
      // The only categories the app makes: one card payment category per card.
      w.push(
        s.q(
          `INSERT INTO category (id, budget_id, name, kind, card_account_id, created_at, updated_at) VALUES (?2, ?1, ?3, 'cc_payment', ?4, ?5, ?5)`,
          `pay_${id}`,
          a.name,
          id,
          now,
        ),
      );
    }
    out.push({ id, name: a.name, kind, startingBalance });
  }
  w.push(
    s.audit('connection.link', 'connection', connectionId, null, { institution, accounts: out.length }, now),
  );
  await s.batch(w);
  const meta = await budgetMeta(s);
  if (meta) {
    const rows = await s.all<AccountRowDb>(
      `SELECT * FROM account WHERE budget_id = ?1 AND provider_account_id IN (SELECT provider_account_id FROM provider_account WHERE connection_id = ?2)`,
      connectionId,
    );
    await s.batch(rows.flatMap((r) => planStartLines(s, toLedgerAccount(r), meta, now)));
  }
  return { connectionId, accounts: out };
}

export async function startSync(
  env: Env,
  budgetId: string,
  connectionId: string,
  trigger: 'webhook' | 'cron' | 'refresh' | 'link',
): Promise<boolean> {
  const now = clock(env);
  await requestSync(env.DB, connectionId, now);
  const runId = `run_${ulid(now)}`;
  if (!(await acquire(env.DB, connectionId, runId, now))) return false;
  try {
    await env.SYNC.create({ id: runId, params: { connectionId, budgetId, runId, trigger } });
    return true;
  } catch (e) {
    const { releaseFailed } = await import('../sync/lease.js');
    await releaseFailed(env.DB, connectionId, runId);
    throw e;
  }
}

settingsRoutes.post('/settings/connections/exchange', async (c) => {
  const r = await parse(LinkExchange, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const provider = makeProvider(c.env);
  const done = await provider.completeLink(r.publicToken);
  const existing = await s.first<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND provider_item_id = ?2`,
    done.providerItemId,
  );
  if (existing) {
    // Update mode returned the same Item: repaired, not a new link.
    await s.run(
      `UPDATE connection SET status = 'ok', error_code = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      existing.id,
      now,
    );
    await startSync(c.env, s.budgetId, existing.id, 'link');
    return c.json({ ok: true, connectionId: existing.id, accounts: [] });
  }
  const res = await completeLink(
    c.env,
    s,
    done.accessToken,
    done.providerItemId,
    done.institutionName ?? 'Bank',
    now,
  );
  await startSync(c.env, s.budgetId, res.connectionId, 'link');
  return c.json({ ok: true, ...res });
});

settingsRoutes.post('/settings/connections/:id/refresh', async (c) => {
  const s = scoped(c);
  const conn = await s.first<{ id: string }>(
    `SELECT id FROM connection WHERE budget_id = ?1 AND id = ?2 AND removed_at IS NULL`,
    c.req.param('id'),
  );
  if (!conn) throw new HttpError(404, 'not_found', 'connection');
  await startSync(c.env, s.budgetId, conn.id, 'refresh');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- first run and preferences

settingsRoutes.post('/setup/start', async (c) => {
  const r = await parse(SetupStart, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const b = await s.first<{ budget_start_month: string | null }>(
    `SELECT budget_start_month FROM budget WHERE id = ?1`,
  );
  if (b?.budget_start_month) throw new HttpError(409, 'started', 'The budget start is already set');
  await s.batch([
    s.q(
      `UPDATE budget SET budget_start_month = ?2, summary_dirty_from = ?2, summary_version = summary_version + 1, updated_at = ?3 WHERE id = ?1`,
      r.startMonth,
      now,
    ),
    s.audit('budget.start', 'budget', s.budgetId, null, r, now),
  ]);
  return c.json({ ok: true });
});

settingsRoutes.post('/setup/starting-balances', async (c) => {
  const r = await parse(StartingBalances, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const meta = await budgetMeta(s);
  if (!meta) throw new HttpError(409, 'not_started', 'Set the budget start first');
  const w: D1PreparedStatement[] = [];
  for (const a of r.accounts) {
    const row = await s.first<AccountRowDb>(
      `SELECT * FROM account WHERE budget_id = ?1 AND id = ?2`,
      a.accountId,
    );
    if (!row) throw new HttpError(404, 'not_found', 'account');
    w.push(
      s.q(
        `UPDATE account SET starting_balance = ?3, starting_balance_confirmed_at = ?4, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
        a.accountId,
        a.startingBalance,
        now,
      ),
      ...planStartLines(s, toLedgerAccount({ ...row, starting_balance: a.startingBalance }), meta, now),
      s.audit(
        'account.starting_balance',
        'account',
        a.accountId,
        row.starting_balance,
        a.startingBalance,
        now,
      ),
    );
  }
  await s.batch(w);
  return c.json(await afterWrite(c.env, s.budgetId, now));
});

settingsRoutes.patch('/settings', async (c) => {
  const r = await parse(SettingsPatch, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const w: D1PreparedStatement[] = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined) continue;
    w.push(
      s.q(
        `INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        k,
        JSON.stringify(v),
        now,
      ),
    );
  }
  if (w.length) await s.batch(w);
  return c.json({ ok: true });
});

export { monthOfDate, startRecompute };
