// Settings → Categories and groups: list, add, rename, archive, remove, reorder and pin.
import { newId } from '../../http/ids.js';
import { changedSince } from '../../http/through.js';
import type { Stmt } from '@ledgerline/db/sql';
import { Hono, type Context } from 'hono';
import { editNow } from '../../http/clock.js';
import {
  ArchiveRequest,
  RemoveCategoryRequest,
  CategoryUpsert,
  GroupUpsert,
  PinRequest,
  ReorderRequest,
  type CategoriesView,
} from '@ledgerline/contracts';
import { type Month, cents, currentMonth, describeTarget, formatCents } from '@ledgerline/domain';

import type { AppEnv } from '../../http/context.js';
import { ACK, CHANGED, FAR_MONTH, GONE, HttpError, inReach, parse, scoped } from '../api.js';
import { fresh, monthLong, monthResult, structure } from '../../views/common.js';
import { cleanName, sameName } from './names.js';
import { PINNED_KEY, readPinned } from '../../views/pinned.js';
import type { Scoped } from '../../db/scoped.js';

export const categoriesRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------- categories and groups

categoriesRoutes.get('/settings/categories', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  const { categories, groups, targets } = await structure(s);
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const mr = await monthResult(s, f.current, start);
  const meta = (id: string, kind: string) => {
    if (kind === 'cc_payment') return 'One per card';
    const v = (targets.get(id) ?? []).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]?.target;
    // The same words as Budget's own target line.
    const t = describeTarget(v ?? null, formatCents);
    return kind === 'saving' ? `Saving or investing · ${t}` : t;
  };
  const cardCats = categories.filter((x) => x.kind === 'cc_payment' && !x.archived_at);
  const view: CategoriesView = {
    groups: [
      ...(cardCats.length
        ? [
            {
              id: 'cards',
              name: 'Card payments',
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
    // A closed card's payment category comes back when the card opens again, not from here (D-73).
    archived: categories
      .filter((x) => x.archived_at && x.kind !== 'cc_payment')
      .map((x) => {
        // The month it was archived in the budget's own time zone.
        const m = currentMonth(x.archived_at!, f.budget.time_zone);
        return { id: x.id, name: x.name, meta: `Archived ${monthLong(m)} ${m.slice(0, 4)}` };
      }),
  };
  return c.json(view);
});

categoriesRoutes.post('/settings/categories', async (c) => {
  const r = await parse(CategoryUpsert, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const name = cleanName(r.name);
  if (!name) throw new HttpError(422, 'invalid', 'Enter a name.');
  // Two categories with one name can't be told apart on Budget, Activity or Reports. A name kept as it was is fine.
  const named = await s.all<{ id: string; name: string; archived_at: number | null }>(
    `SELECT id, name, archived_at FROM category WHERE budget_id = ?1`,
  );
  const self = r.id ? named.find((x) => x.id === r.id) : undefined;
  if (!(self && sameName(self.name, name))) {
    const dup = named.find((x) => x.id !== r.id && sameName(x.name, name));
    if (dup)
      throw new HttpError(
        409,
        'duplicate',
        dup.archived_at
          ? 'An archived category has this name. Restore it, or pick another name.'
          : 'You already have a category with this name.',
      );
  }
  if (r.groupId) {
    const g = await s.first(`SELECT id FROM category_group WHERE budget_id = ?1 AND id = ?2`, r.groupId);
    if (!g) throw new HttpError(404, 'not_found', GONE);
  }
  const id = r.id ?? newId(c);
  if (r.id) {
    const ex = await s.first<{ kind: string }>(
      `SELECT kind FROM category WHERE budget_id = ?1 AND id = ?2`,
      r.id,
    );
    if (!ex) throw new HttpError(404, 'not_found', GONE);
    if (ex.kind === 'cc_payment')
      throw new HttpError(422, 'system', 'Rename the card on Accounts to rename its payment category.');
    await s.batch([
      s.q(
        `UPDATE category SET name = ?3, group_id = ?4, kind = ?5, due_day = ?6, low_threshold = ?7, updated_at = ?8 WHERE budget_id = ?1 AND id = ?2`,
        id,
        name,
        r.groupId,
        r.kind,
        r.dueDay ?? null,
        r.lowThreshold ?? null,
        now,
      ),
      s.audit('category.edit', 'category', id, null, { ...r, name }, now),
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
        name,
        r.kind,
        r.dueDay ?? null,
        r.lowThreshold ?? null,
        (max?.m ?? 0) + 1,
        now,
      ),
      s.audit('category.add', 'category', id, null, { ...r, name }, now),
    ]);
  }
  return c.json({ ok: true, id });
});

categoriesRoutes.post('/settings/groups', async (c) => {
  const r = await parse(GroupUpsert, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const name = cleanName(r.name);
  if (!name) throw new HttpError(422, 'invalid', 'Enter a name.');
  const id = r.id ?? newId(c);
  if (r.id) {
    // A link to a group that was removed (or never was) says so, rather than closing as if it saved.
    const g = await s.first(
      `SELECT id FROM category_group WHERE budget_id = ?1 AND id = ?2 AND archived_at IS NULL`,
      r.id,
    );
    if (!g) throw new HttpError(404, 'not_found', GONE);
    await s.run(
      `UPDATE category_group SET name = ?3, is_bills = ?4, updated_at = ?5 WHERE budget_id = ?1 AND id = ?2`,
      id,
      name,
      r.isBills ? 1 : 0,
      now,
    );
  } else {
    const max = await s.first<{ m: number | null }>(
      `SELECT max(sort) AS m FROM category_group WHERE budget_id = ?1`,
    );
    await s.run(
      `INSERT INTO category_group (id, budget_id, name, is_bills, sort, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?6)`,
      id,
      name,
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
  const now = editNow(c);
  const id = c.req.param('id');
  const cat = await s.first<{ kind: string }>(
    `SELECT kind FROM category WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!cat) throw new HttpError(404, 'not_found', GONE);
  if (cat.kind === 'cc_payment')
    throw new HttpError(422, 'system', 'Card payment categories can’t be archived.');
  const returned = await archiveCategory(c, s, id, r.archived, now, r);
  return c.json({ ...ACK, returned });
});

type Returned = { month: Month; amount: number }[];

/**
 * Archive (or restore) a category. Archiving one that still has money moves the money to Ready to Assign first: what
 * it has this month, and what is assigned to it in later months. One that is overspent is refused until the
 * overspending is covered. Answers what was moved, so Undo can give it back: a restore sent with `giveBack` assigns
 * it again, in the same months. A restore also brings back the category's group if that was removed meanwhile, or
 * the category would be on no list at all.
 */
async function archiveCategory(
  c: Context<AppEnv>,
  s: Scoped,
  id: string,
  archived: boolean,
  now: number,
  sent: {
    available?: number | undefined;
    through?: number | undefined;
    giveBack?: { month: string; amount: number }[] | undefined;
  } = {},
): Promise<Returned> {
  const w: Stmt[] = [
    s.q(
      `UPDATE category SET archived_at = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`,
      id,
      archived ? now : null,
      now,
    ),
  ];
  const returned: Returned = [];
  const f = await fresh(s, now);
  const add = (month: string, amount: number) =>
    s.q(
      `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (budget_id, month, category_id) DO UPDATE SET amount = assignment.amount + excluded.amount, updated_at = excluded.updated_at`,
      id,
      month,
      amount,
      now,
    );
  if (archived) {
    // The server doesn't work out balances (D-45): the phone sends what it showed. A category's available can
    // depend on other categories' card refunds (D-12), so it can't be checked here alone; instead nothing may have
    // changed since the phone worked it out. Anything able to send this can already assign and move money.
    const avail = sent.available ?? 0;
    if (avail !== 0) {
      if (await changedSince(c, sent.through)) throw new HttpError(409, 'changed', CHANGED);
    }
    // Archived, its overspending would drop out of Budget's attention while still counting (D-79).
    if (avail < 0) throw new HttpError(422, 'overspent', 'Cover this category’s overspending first.');
    if (avail > 0) {
      w.push(add(f.current, -avail));
      returned.push({ month: f.current, amount: avail });
    }
    // Money already assigned to it in later months goes back too: an archived category takes no new money.
    const later = await s.all<{ month: Month; amount: number }>(
      `SELECT month, amount FROM assignment WHERE budget_id = ?1 AND category_id = ?2 AND month > ?3 AND amount != 0 ORDER BY month`,
      id,
      f.current,
    );
    for (const l of later) {
      w.push(add(l.month, -l.amount));
      returned.push({ month: l.month, amount: l.amount });
    }
  } else {
    const row = await s.first<{ archived_at: number | null; group_id: string | null }>(
      `SELECT archived_at, group_id FROM category WHERE budget_id = ?1 AND id = ?2`,
      id,
    );
    if (sent.giveBack?.length) {
      // An Undo sent twice gives the money back once: the second finds the category restored already.
      if (!row?.archived_at) throw new HttpError(409, 'changed', CHANGED);
      const start = f.budget.budget_start_month;
      if (sent.giveBack.some((g) => !inReach(g.month, f.current) || !start || g.month < start))
        throw new HttpError(422, 'too_far', FAR_MONTH);
      for (const g of sent.giveBack) w.push(add(g.month, g.amount));
    }
    if (row?.group_id)
      w.push(
        s.q(
          `UPDATE category_group SET archived_at = NULL, updated_at = ?3 WHERE budget_id = ?1 AND id = ?2 AND archived_at IS NOT NULL`,
          row.group_id,
          now,
        ),
      );
  }
  w.push(
    s.audit(
      archived ? 'category.archive' : 'category.restore',
      'category',
      id,
      null,
      returned.length ? { returned } : sent.giveBack?.length ? { giveBack: sent.giveBack } : null,
      now,
    ),
  );
  await s.batch(w);
  return returned;
}

/**
 * Pin a category to the top of Budget, or unpin it. One category at a time, so a change sent later from a phone that
 * was offline doesn't undo pins made on another device meanwhile. Pinning changes no money.
 */
categoriesRoutes.post('/settings/categories/:id/pin', async (c) => {
  const r = await parse(PinRequest, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const row = await s.first<{ value: string }>(
    `SELECT value FROM setting WHERE budget_id = ?1 AND key = ?2`,
    PINNED_KEY,
  );
  const was = readPinned(row?.value);
  const ids = r.pinned ? (was.includes(id) ? was : [...was, id]) : was.filter((x) => x !== id);
  if (ids.length > 200) throw new HttpError(422, 'invalid', 'Unpin a category first.');
  if (ids.length !== was.length)
    await s.run(
      `INSERT INTO setting (budget_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (budget_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      PINNED_KEY,
      JSON.stringify(ids),
      now,
    );
  return c.json(ACK);
});

categoriesRoutes.post('/settings/categories/:id/remove', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const cat = await s.first<{ kind: string; name: string }>(
    `SELECT kind, name FROM category WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!cat) throw new HttpError(404, 'not_found', GONE);
  if (cat.kind === 'cc_payment')
    throw new HttpError(422, 'system', 'Card payment categories can’t be removed.');
  const sent = await parse(RemoveCategoryRequest, c.req.raw).catch(() => ({}));
  const used = await s.first<{ n: number }>(
    `SELECT
       (SELECT count(*) FROM assignment WHERE budget_id = ?1 AND category_id = ?2 AND amount != 0)
     + (SELECT count(*) FROM txn_overlay WHERE budget_id = ?1 AND category_id = ?2)
     + (SELECT count(*) FROM txn_split WHERE budget_id = ?1 AND category_id = ?2) AS n`,
    id,
  );
  if ((used?.n ?? 0) > 0) {
    const returned = await archiveCategory(c, s, id, true, now, sent);
    return c.json({ ok: true as const, outcome: 'archived' as const, returned });
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
  const now = editNow(c);
  const id = c.req.param('id');
  const g = await s.first<{ id: string }>(
    `SELECT id FROM category_group WHERE budget_id = ?1 AND id = ?2`,
    id,
  );
  if (!g) throw new HttpError(404, 'not_found', GONE);
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
