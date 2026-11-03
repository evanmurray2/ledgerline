import { Hono, type MiddlewareHandler } from 'hono';
import { clock } from '../http/clock.js';
import { z } from 'zod';
import {
  AssignRequest,
  MoveRequest,
  SetAssignedRequest,
  TargetRequest,
  type MutationAck,
  type Session,
} from '@ledgerline/contracts';
import { type Month, addMonths, cents, isMonth } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { OPS_PATHS, REAUTH_MS, identify, needsRecentPasskey } from '../http/auth.js';
import { securityRoutes } from './security.js';
import { csrf } from '../http/security.js';
import { bumpOnChange, etags } from '../http/etag.js';
import { Scoped, membership } from '../db/scoped.js';
import { markDirty, recompute } from '../budget/recompute.js';
import { budgetView } from '../views/budget.js';
import { fresh } from '../views/common.js';
import { usageToday, classifyUsage } from '../sync/breaker.js';
import { activityRoutes } from './activity.js';
import { accountRoutes } from './accounts.js';
import { settingsRoutes } from './settings.js';
import { opsRoutes } from './ops.js';
import { categorySheet, assignView } from '../views/category.js';
import { derived } from '../budget/derived.js';
import { syncRoutes, editOnce } from './sync.js';

/**
 * One budget's API (docs/multi-user.md 5.1). It runs inside the budget's own Durable Object, which trusts the caller
 * the Worker passes it after the Directory has checked who is asking (store/router.ts).
 */
export const budgetApi = new Hono<AppEnv>();

/** Settings → Sign-in in the Directory: a signed-in session (or the ops token), then membership in a budget. */
export const identity: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  const path = new URL(c.req.url).pathname;
  if (path === '/api/webhooks/plaid' || path.startsWith('/api/auth/')) return next();
  const now = clock(c.env);
  const who = await identify(c.req.raw, c.env, now);
  if (!who) return c.json({ error: 'unauthenticated', message: 'Sign in with your passkey' }, 401);
  if (who.kind === 'ops') {
    // The ops token reaches only the health endpoint.
    if (!OPS_PATHS.has(`${c.req.method} ${path}`))
      return c.json({ error: 'forbidden', message: 'ops token' }, 403);
    c.set('userId', 'service');
    c.set('email', '');
    c.set('sessionId', '');
    const b = await c.env.DB.prepare(`SELECT id FROM budget ORDER BY created_at LIMIT 1`).first<{
      id: string;
    }>();
    c.set('budgetId', b?.id ?? '');
    return next();
  }
  if (needsRecentPasskey(c.req.method, path) && now - who.verifiedAt > REAUTH_MS)
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey' }, 401);
  const m = await membership(c.env.DB, who.userId);
  if (!m) return c.json({ error: 'forbidden', message: 'Not a member of this budget' }, 403);
  c.set('sessionId', who.sessionId ?? '');
  c.set('userId', m.userId);
  c.set('email', m.email);
  c.set('budgetId', m.budgetId);
  return next();
};
budgetApi.use('*', csrf);

/**
 * Screens are built on the phone from its own copy (D-44). On the server only these reads remain: the session, the
 * sync itself, bank connections (they need the Directory's link slots), exports and the ops health check.
 */
const SERVER_READS = [
  /^\/api\/session$/,
  /^\/api\/sync(\/|$)/,
  /^\/api\/health$/,
  /^\/api\/settings\/connections$/,
  /^\/api\/settings\/rules\/export$/,
  /^\/api\/export\//,
];
budgetApi.use('*', async (c, next) => {
  if (derived.enabled || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return next();
  const path = new URL(c.req.url).pathname;
  if (SERVER_READS.some((r) => r.test(path))) return next();
  return c.json({ error: 'on_device', message: 'This screen is worked out on your phone' }, 404);
});
/** A change made offline and sent again after a dropped answer is applied once (routes/sync.ts). */
budgetApi.use('*', editOnce);
/** Unchanged screens answer 304; every change bumps the version (http/etag.ts). */
budgetApi.use('*', etags);
budgetApi.use('*', bumpOnChange);

/** Writes are refused when the account is at 90% of a daily limit (Sync spec F8). */
budgetApi.use('*', async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD') return next();
  // Inside a budget's Durable Object, account usage comes from the Directory (USAGE); on D1, from usage_day.
  const u = c.env.USAGE ? await c.env.USAGE() : await usageToday(c.env);
  const st = classifyUsage(u.written, u.read, u.do, u.workers);
  if (st === 'readonly' || st === 'rest')
    return c.json({ error: 'readonly', message: 'Daily database limit reached' }, 503);
  return next();
});

export function scoped(c: { env: AppEnv['Bindings']; get: (k: 'budgetId' | 'userId') => string }): Scoped {
  return new Scoped(c.env.DB, c.get('budgetId'), c.get('userId'));
}

/** Continues an older edit's recompute in the store's jobs (decisions.md D-22). */
export async function startRecompute(env: AppEnv['Bindings']): Promise<void> {
  await env.JOBS?.recompute();
}

/** After a write: recompute before responding (one chunk), continue older months in a job. */
export async function afterWrite(
  env: AppEnv['Bindings'],
  budgetId: string,
  now: number,
): Promise<MutationAck> {
  // The server keeps nothing derived (D-44): the phone works out Ready to Assign after it syncs this change.
  if (!derived.enabled) return { ok: true };
  const r = await recompute(env.DB, budgetId, now);
  if (!r.done) await startRecompute(env);
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

const onError = (e: Error, c: Parameters<Parameters<typeof budgetApi.onError>[0]>[1]) => {
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
};
budgetApi.onError(onError);

// ---------------------------------------------------------------- session and budget

budgetApi.get('/session', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(c.env, s, now, () => startRecompute(c.env));
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
  const ws = classifyUsage(u.written, u.read, u.do, u.workers);
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  const body: Session = {
    // `login` was the GitHub name from before passkeys (D-27); nothing sets it any more. Users live in the
    // Directory, so the budget's routes don't read the user table.
    user: { email: c.get('email'), login: null },
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
    readOnlyUntil: ws === 'readonly' || ws === 'rest' ? tomorrow.toISOString() : null,
    readsPaused: ws === 'rest',
    settings: { tracking: setting.get('tracking') !== false, noteButton: setting.get('noteButton') === true },
  };
  return c.json(body);
});

budgetApi.get('/budget/:month', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env));
  return c.json(await budgetView(s, f, m));
});

budgetApi.get('/budget/:month/assign', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env));
  return c.json(await assignView(s, f, m));
});

budgetApi.get('/categories/:id/sheet', async (c) => {
  const s = scoped(c);
  const f = await fresh(c.env, s, clock(c.env), () => startRecompute(c.env));
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
): Promise<MutationAck> {
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

budgetApi.post('/budget/assign', async (c) => {
  const r = await parse(AssignRequest, c.req.raw);
  return c.json(await addAssignments(c, r.month as Month, r.items));
});

budgetApi.post('/budget/set', async (c) => {
  const r = await parse(SetAssignedRequest, c.req.raw);
  return c.json(
    await addAssignments(c, r.month as Month, [{ categoryId: r.categoryId, amount: r.assigned, set: true }]),
  );
});

budgetApi.post('/budget/move', async (c) => {
  const r = await parse(MoveRequest, c.req.raw);
  const items: { categoryId: string; amount: number }[] = [];
  if (r.from !== 'rta') items.push({ categoryId: r.from, amount: -r.amount });
  if (r.to !== 'rta') items.push({ categoryId: r.to, amount: r.amount });
  if (!items.length) throw new HttpError(400, 'invalid', 'nothing to move');
  return c.json(await addAssignments(c, r.month as Month, items));
});

budgetApi.put('/categories/:id/target', async (c) => {
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
  if (!derived.enabled) return c.json({ ok: true } satisfies MutationAck);
  const b = await s.first<{ rta: number; summary_dirty_from: string | null }>(
    `SELECT rta, summary_dirty_from FROM budget WHERE id = ?1`,
  );
  return c.json({
    ok: true,
    rta: cents(b?.rta ?? 0),
    rtaUpdating: b?.summary_dirty_from !== null,
  } satisfies MutationAck);
});

budgetApi.route('/', syncRoutes);
budgetApi.route('/', activityRoutes);
budgetApi.route('/', accountRoutes);
budgetApi.route('/', settingsRoutes);
budgetApi.route('/', opsRoutes);
budgetApi.route('/', securityRoutes);

export { addMonths };
