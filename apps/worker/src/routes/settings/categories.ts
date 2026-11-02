// Settings → Categories and groups: list, add, rename, archive, remove and reorder.
import { Hono } from 'hono';
import { clock } from '../../http/clock.js';
import {
  ArchiveRequest,
  CategoryUpsert,
  GroupUpsert,
  ReorderRequest,
  type CategoriesView,
} from '@ledgerline/contracts';
import { type Month, cents, formatCents } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../../http/context.js';
import { HttpError, afterWrite, parse, scoped } from '../api.js';
import { fresh, monthResult, structure } from '../../views/common.js';
import { markDirty } from '../../budget/recompute.js';
import type { Scoped } from '../../db/scoped.js';
import type { Env } from '../../env.js';

export const categoriesRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- categories and groups

categoriesRoutes.get('/settings/categories', async (c) => {
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

categoriesRoutes.post('/settings/categories', async (c) => {
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

categoriesRoutes.post('/settings/groups', async (c) => {
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

categoriesRoutes.post('/settings/categories/:id/archive', async (c) => {
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
  await archiveCategory(c.env, s, id, r.archived, now);
  return c.json(await afterWrite(c.env, s.budgetId, now));
});

/** Archive (or restore) a category. Archiving one that still has money moves the money to Ready to Assign first. */
async function archiveCategory(
  env: Env,
  s: Scoped,
  id: string,
  archived: boolean,
  now: number,
): Promise<void> {
  const w: D1PreparedStatement[] = [
    s.q(
      `UPDATE category SET archived_at = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
      id,
      archived ? now : null,
      now,
    ),
  ];
  if (archived) {
    const f = await fresh(env, s, now);
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
  w.push(s.audit(archived ? 'category.archive' : 'category.restore', 'category', id, null, null, now));
  await s.batch(w);
}

categoriesRoutes.post('/settings/categories/:id/remove', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const cat = await s.first<{ kind: string; name: string }>(
    `SELECT kind, name FROM category WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!cat) throw new HttpError(404, 'not_found', 'category');
  if (cat.kind === 'cc_payment')
    throw new HttpError(422, 'system', 'Card payment categories are made by the app');
  const used = await s.first<{ n: number }>(
    `SELECT
       (SELECT count(*) FROM assignment WHERE budget_id = ?1 AND category_id = ?2 AND amount != 0)
     + (SELECT count(*) FROM txn_overlay WHERE budget_id = ?1 AND category_id = ?2)
     + (SELECT count(*) FROM txn_split WHERE budget_id = ?1 AND category_id = ?2)
     + (SELECT count(*) FROM budget_line WHERE budget_id = ?1 AND category_id = ?2)
     + (SELECT count(*) FROM payee WHERE budget_id = ?1 AND default_category_id = ?2)
     + (SELECT count(*) FROM rule WHERE budget_id = ?1 AND actions LIKE '%' || ?2 || '%') AS n`,
    id,
  );
  if ((used?.n ?? 0) > 0) {
    await archiveCategory(c.env, s, id, true, now);
    return c.json({ ok: true as const, outcome: 'archived' as const });
  }
  await s.batch([
    s.q(`DELETE FROM assignment WHERE budget_id = ?1 AND category_id = ?2`, id),
    s.q(`DELETE FROM target WHERE budget_id = ?1 AND category_id = ?2`, id),
    s.q(`DELETE FROM category WHERE budget_id = ?1 AND id = ?2`, id),
    s.audit('category.delete', 'category', id, { name: cat.name }, null, now),
  ]);
  return c.json({ ok: true as const, outcome: 'deleted' as const });
});

/** Remove an empty group (it's archived, so nothing that points at it breaks). */
categoriesRoutes.post('/settings/groups/:id/remove', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const g = await s.first<{ id: string }>(
    `SELECT id FROM category_group WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!g) throw new HttpError(404, 'not_found', 'group');
  const left = await s.first<{ n: number }>(
    `SELECT count(*) AS n FROM category WHERE budget_id = ?1 AND group_id = ?2 AND archived_at IS NULL`,
    id,
  );
  if ((left?.n ?? 0) > 0)
    throw new HttpError(409, 'not_empty', 'Move or remove the categories in this group first.');
  await s.batch([
    s.q(
      `UPDATE category_group SET archived_at = ?3, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2`,
      id,
      now,
    ),
    s.audit('group.remove', 'category_group', id, null, null, now),
  ]);
  return c.json({ ok: true as const });
});

categoriesRoutes.post('/settings/groups/reorder', async (c) => {
  const r = await parse(ReorderRequest, c.req.raw);
  const s = scoped(c);
  await s.batch(
    r.ids.map((id, i) => s.q(`UPDATE category_group SET sort = ?3 WHERE budget_id = ?1 AND id = ?2`, id, i)),
  );
  return c.json({ ok: true });
});

categoriesRoutes.post('/settings/categories/reorder', async (c) => {
  const r = await parse(ReorderRequest, c.req.raw);
  const s = scoped(c);
  await s.batch(
    r.ids.map((id, i) => s.q(`UPDATE category SET sort = ?3 WHERE budget_id = ?1 AND id = ?2`, id, i)),
  );
  return c.json({ ok: true });
});
