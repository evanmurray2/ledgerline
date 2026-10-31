import { Hono } from 'hono';
import { clock } from '../http/clock.js';
import { z } from 'zod';
import {
  AssignRequest,
  MoveRequest,
  SetAssignedRequest,
  TargetRequest,
  type MutationResult,
  type Session,
} from '@ledgerline/contracts';
import { type Month, addMonths, cents, isMonth } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { identify } from '../http/auth.js';
import { csrf } from '../http/security.js';
import { Scoped, resolveMembership } from '../db/scoped.js';
import { markDirty, recompute } from '../budget/recompute.js';
import { budgetView } from '../views/budget.js';
import { fresh } from '../views/common.js';
import { usageToday, classifyUsage } from '../sync/breaker.js';
import { activityRoutes } from './activity.js';
import { accountRoutes } from './accounts.js';
import { settingsRoutes } from './settings.js';
import { opsRoutes } from './ops.js';
import { categorySheet, assignView } from '../views/category.js';

export const api = new Hono<AppEnv>();

/** Every API request: a verified Access identity, then membership in a budget. */
api.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  const path = new URL(c.req.url).pathname;
  if (path === '/api/webhooks/plaid') return next();
  const who = await identify(c.req.raw, c.env);
  if (!who) return c.json({ error: 'unauthenticated', message: 'Sign in through Cloudflare Access' }, 401);
  if (who.serviceClientId) {
    // Access service tokens may only read the health endpoint (the GitHub monitor).
    if (
      path !== '/api/health' ||
      (c.env.ACCESS_SERVICE_CLIENT_ID && who.serviceClientId !== c.env.ACCESS_SERVICE_CLIENT_ID)
    ) {
      return c.json({ error: 'forbidden', message: 'service token' }, 403);
    }
    c.set('userId', 'service');
    c.set('email', '');
    const b = await c.env.DB.prepare(`SELECT id FROM budget ORDER BY created_at LIMIT 1`).first<{
      id: string;
    }>();
    c.set('budgetId', b?.id ?? '');
    return next();
  }
  const m = await resolveMembership(
    c.env.DB,
    who.email,
    c.env.OWNER_EMAIL ?? c.env.DEV_AUTH_EMAIL,
    clock(c.env),
    () => ulid(),
  );
  if (!m) return c.json({ error: 'forbidden', message: 'Not a member of this budget' }, 403);
  c.set('userId', m.userId);
  c.set('email', who.email);
  c.set('budgetId', m.budgetId);
  return next();
});
api.use('*', csrf);

/** Writes are refused when the account is at 90% of a daily D1 limit (Sync spec F8). */
api.use('*', async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD') return next();
  const u = await usageToday(c.env);
  if (classifyUsage(u.written, u.read) === 'readonly')
    return c.json({ error: 'readonly', message: 'Daily database limit reached' }, 503);
  return next();
});

export function scoped(c: { env: AppEnv['Bindings']; get: (k: 'budgetId' | 'userId') => string }): Scoped {
  return new Scoped(c.env.DB, c.get('budgetId'), c.get('userId'));
}

/** Starts (or reuses) the recompute Workflow for an older edit (decisions.md D-22). */
export async function startRecompute(env: AppEnv['Bindings'], budgetId: string): Promise<void> {
  const b = await env.DB.prepare(`SELECT summary_version FROM budget WHERE id = ?1`)
    .bind(budgetId)
    .first<{ summary_version: number }>();
  try {
    await env.RECOMPUTE.create({ id: `rc-${budgetId}-${b?.summary_version ?? 0}`, params: { budgetId } });
  } catch (e) {
    if (!/already exists/i.test(String(e))) throw e;
  }
}

/** After a write: recompute before responding (one chunk), continue older months in the Workflow. */
export async function afterWrite(
  env: AppEnv['Bindings'],
  budgetId: string,
  now: number,
): Promise<MutationResult> {
  const r = await recompute(env.DB, budgetId, now);
  if (!r.done) await startRecompute(env, budgetId);
  const b = await env.DB.prepare(`SELECT rta, summary_dirty_from FROM budget WHERE id = ?1`)
    .bind(budgetId)
    .first<{ rta: number; summary_dirty_from: string | null }>();
  return {
    ok: true,
    rta: cents(b?.rta ?? 0),
    rtaUpdating: b?.summary_dirty_from !== null && b?.summary_dirty_from !== undefined,
  };
}

export async function parse<T extends z.ZodType>(schema: T, req: Request): Promise<z.infer<T>> {
  const body = await req.json().catch(() => {
    throw new HttpError(400, 'bad_json', 'Body must be JSON');
  });
  const r = schema.safeParse(body);
  if (!r.success)
    throw new HttpError(
      400,
      'invalid',
      r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return r.data;
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

api.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.code, message: e.message }, e.status);
  console.log(
    JSON.stringify({
      event: 'error',
      requestId: c.get('requestId'),
      route: new URL(c.req.url).pathname,
      code: e instanceof Error ? e.name : 'unknown',
    }),
  );
  return c.json({ error: 'internal', message: 'Something went wrong' }, 500);
});

// ---------------------------------------------------------------- session and budget

api.get('/session', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(c.env, s, now, () => startRecompute(c.env, s.budgetId));
  const [accounts, cats, settings] = await s.batch([
    s.q(`SELECT count(*) AS n FROM account WHERE budget_id = ?1`),
    s.q(`SELECT count(*) AS n FROM category WHERE budget_id = ?1 AND kind != 'cc_payment'`),
    s.q(`SELECT key, value FROM setting WHERE budget_id = ?1`),
  ]);
  const n = (r: D1Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0;
  const setting = new Map(
    (settings!.results as { key: string; value: string }[]).map((r) => [
      r.key,
      JSON.parse(r.value) as unknown,
    ]),
  );
  const setupStep: Session['budget']['setupStep'] = !f.budget.budget_start_month
    ? 'start'
    : n(accounts) === 0 && !setting.get('setup.skipLink')
      ? 'link'
      : n(cats) === 0
        ? 'categories'
        : 'done';
  const u = await usageToday(c.env, now);
  const ws = classifyUsage(u.written, u.read);
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const user = await s.first<{ github_login: string | null }>(
    `SELECT github_login FROM user WHERE id = ?2 AND ?1 IS NOT NULL`,
    c.get('userId'),
  );
  const body: Session = {
    user: { email: c.get('email'), login: user?.github_login ?? null },
    budget: {
      id: f.budget.id,
      name: f.budget.name,
      startMonth: (f.budget.budget_start_month as Month | null) ?? null,
      timeZone: f.budget.time_zone,
      currentMonth: f.current,
      today: f.today,
      setupStep,
    },
    appVersion: c.env.APP_VERSION ?? '0.1.0',
    writeState: ws === 'normal' ? 'ok' : ws === 'pause' ? 'paused' : 'readonly',
    readOnlyUntil: ws === 'readonly' ? tomorrow.toISOString() : null,
    settings: { tracking: setting.get('tracking') !== false, noteButton: setting.get('noteButton') === true },
  };
  return c.json(body);
});

api.get('/budget/:month', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env, s.budgetId));
  return c.json(await budgetView(s, f, m));
});

api.get('/budget/:month/assign', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env, s.budgetId));
  return c.json(await assignView(s, f, m));
});

api.get('/categories/:id/sheet', async (c) => {
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env, s.budgetId));
  const m = c.req.query('month') ?? f.current;
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const sheet = await categorySheet(s, f, c.req.param('id'), m);
  if (!sheet) throw new HttpError(404, 'not_found', 'category');
  return c.json(sheet);
});

async function addAssignments(
  c: Parameters<typeof scoped>[0],
  month: Month,
  items: { categoryId: string; amount: number; set?: boolean }[],
): Promise<MutationResult> {
  const s = scoped(c);
  const now = clock(c.env);
  const ids = items.map((i) => i.categoryId);
  const known = await s.all<{ id: string }>(
    `SELECT id FROM category WHERE budget_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
    ...ids,
  );
  if (known.length !== new Set(ids).size) throw new HttpError(404, 'not_found', 'category');
  const b = await s.first<{ budget_start_month: string | null }>(
    `SELECT budget_start_month FROM budget WHERE id = ?1`,
  );
  if (!b?.budget_start_month || month < b.budget_start_month)
    throw new HttpError(422, 'before_start', 'Months before the budget start can’t be assigned');
  const stmts = items.map((i) =>
    s.q(
      i.set
        ? `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (budget_id, month, category_id) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`
        : `INSERT INTO assignment (budget_id, category_id, month, amount, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (budget_id, month, category_id) DO UPDATE SET amount = assignment.amount + excluded.amount, updated_at = excluded.updated_at`,
      i.categoryId,
      month,
      i.amount,
      now,
    ),
  );
  stmts.push(
    s.audit(items.some((i) => i.set) ? 'assign.set' : 'assign.add', 'assignment', month, null, items, now),
  );
  stmts.push(markDirty(c.env.DB, s.budgetId, month, now));
  await s.batch(stmts);
  return afterWrite(c.env, s.budgetId, now);
}

api.post('/budget/assign', async (c) => {
  const r = await parse(AssignRequest, c.req.raw);
  return c.json(await addAssignments(c, r.month as Month, r.items));
});

api.post('/budget/set', async (c) => {
  const r = await parse(SetAssignedRequest, c.req.raw);
  return c.json(
    await addAssignments(c, r.month as Month, [{ categoryId: r.categoryId, amount: r.assigned, set: true }]),
  );
});

api.post('/budget/move', async (c) => {
  const r = await parse(MoveRequest, c.req.raw);
  const items: { categoryId: string; amount: number }[] = [];
  if (r.from !== 'rta') items.push({ categoryId: r.from, amount: -r.amount });
  if (r.to !== 'rta') items.push({ categoryId: r.to, amount: r.amount });
  if (!items.length) throw new HttpError(400, 'invalid', 'nothing to move');
  return c.json(await addAssignments(c, r.month as Month, items));
});

api.put('/categories/:id/target', async (c) => {
  const r = await parse(TargetRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const t = r.target;
  const exists = await s.first(`SELECT id FROM category WHERE budget_id = ?1 AND id = ?2`, id);
  if (!exists) throw new HttpError(404, 'not_found', 'category');
  // Versioned: a new version from this month on; past months keep the target they were budgeted against.
  await s.batch([
    s.q(
      `INSERT INTO target (id, budget_id, category_id, type, amount, period_months, period_anchor, target_month, monthly_contribution, effective_from, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (category_id, effective_from) DO UPDATE SET type = excluded.type, amount = excluded.amount, period_months = excluded.period_months,
         period_anchor = excluded.period_anchor, target_month = excluded.target_month, monthly_contribution = excluded.monthly_contribution`,
      ulid(now),
      id,
      t.type,
      t.type === 'none' ? 0 : t.amount,
      t.type === 'refill' ? t.periodMonths : 1,
      t.type === 'refill' ? t.anchor : null,
      t.type === 'by_date' ? t.targetMonth : null,
      t.type === 'no_date' ? t.monthly : null,
      r.month,
      now,
    ),
    s.audit('target.set', 'category', id, null, t, now),
  ]);
  const b = await s.first<{ rta: number; summary_dirty_from: string | null }>(
    `SELECT rta, summary_dirty_from FROM budget WHERE id = ?1`,
  );
  return c.json({
    ok: true,
    rta: cents(b?.rta ?? 0),
    rtaUpdating: b?.summary_dirty_from !== null,
  } satisfies MutationResult);
});

api.route('/', activityRoutes);
api.route('/', accountRoutes);
api.route('/', settingsRoutes);
api.route('/', opsRoutes);

export { addMonths };
