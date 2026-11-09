import type { Result } from '@ledgerline/db/sql';
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
import { type Month, addMonths, isMonth } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { AppEnv } from '../http/context.js';
import { OPS_PATHS, REAUTH_MS, identify, needsRecentPasskey } from '../http/auth.js';
import { securityRoutes } from './security.js';
import { csrf } from '../http/security.js';
import { bumpOnChange } from '../http/version.js';
import { Scoped, membership } from '../db/scoped.js';
import { budgetView } from '../views/budget.js';
import { fresh } from '../views/common.js';
import { usageToday, classifyUsage, dailyLimits } from '../sync/breaker.js';
import { activityRoutes } from './activity.js';
import { activityViewRoutes } from './activity-view.js';
import { samePurchaseRoutes } from './same-purchase.js';
import { transactionRoutes } from './transactions.js';
import { accountRoutes } from './accounts.js';
import { accountCloseRoutes } from './account-close.js';
import { settingsRoutes } from './settings.js';
import { opsRoutes } from './ops.js';
import { categorySheet, assignView } from '../views/category.js';
import { syncRoutes, editOnce } from './sync.js';
import { canLinkBanks } from '../http/context.js';

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
  if (!who) return c.json({ error: 'unauthenticated', message: 'Sign in again with your passkey.' }, 401);
  if (who.kind === 'ops') {
    // The ops token reaches only the health endpoint.
    if (!OPS_PATHS.has(`${c.req.method} ${path}`))
      return c.json({ error: 'forbidden', message: 'You can’t open this.' }, 403);
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
    return c.json({ error: 'reauth', message: 'Confirm it’s you with your passkey, then try again.' }, 401);
  const m = await membership(c.env.DB, who.userId);
  if (!m) return c.json({ error: 'forbidden', message: 'You don’t have access to this budget.' }, 403);
  c.set('sessionId', who.sessionId ?? '');
  c.set('userId', m.userId);
  c.set('email', m.email);
  c.set('budgetId', m.budgetId);
  c.set('isAdmin', m.isAdmin);
  return next();
};
budgetApi.use('*', csrf);

/**
 * Screens are built on the phone from its own copy (D-45). On the server only these reads remain: the session, the
 * sync itself, bank connections (they need the Directory's link slots), exports and the ops health check.
 */
export const SERVER_READS = [
  /^\/api\/session$/,
  /^\/api\/sync(\/|$)/,
  /^\/api\/health$/,
  /^\/api\/settings\/connections$/,
  /^\/api\/export\//,
];
/** Mounted in front of budgetApi by the store (not by the phone's engine, which answers every screen). */
export const serverReadsOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
  const path = new URL(c.req.url).pathname;
  if (SERVER_READS.some((r) => r.test(path))) return next();
  return c.json({ error: 'on_device', message: 'This screen is worked out on your device.' }, 404);
};
/** A change made offline and sent again after a dropped answer is applied once (routes/sync.ts). */
budgetApi.use('*', editOnce);
/** Every change bumps the budget's data version (http/version.ts). */
budgetApi.use('*', bumpOnChange);

/** Writes are refused when the account is at 90% of a daily limit (Sync spec F8). */
budgetApi.use('*', async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD') return next();
  // Inside a budget's Durable Object, account usage comes from the Directory (USAGE); elsewhere, from usage_day.
  const u = c.env.USAGE ? await c.env.USAGE() : await usageToday(c.env);
  const st = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
  if (st === 'readonly' || st === 'rest')
    return c.json(
      { error: 'readonly', message: 'View only until the daily limit resets. Nothing is lost.' },
      503,
    );
  return next();
});

export function scoped(c: { env: AppEnv['Bindings']; get: (k: 'budgetId' | 'userId') => string }): Scoped {
  return new Scoped(c.env.DB, c.get('budgetId'), c.get('userId'));
}

/**
 * What a change answers. Nothing derived is worked out in a route (D-45): the phone's engine rebuilds lines and
 * Ready to Assign afterwards (local/engine.ts derive()), on the server or in its own copy.
 */
export const ACK: MutationAck = { ok: true };

export async function parse<T extends z.ZodType>(schema: T, req: Request): Promise<z.infer<T>> {
  const body = await req.json().catch(() => {
    throw new HttpError(400, 'bad_json', TRY_AGAIN);
  });
  const r = schema.safeParse(body);
  if (!r.success)
    // The field-by-field text is for logs, never the screen.
    throw new HttpError(400, 'invalid', 'Check what you entered, then try again.');
  return r.data;
}

/** A missing thing, said so the reader can act (docs/copy.md rule 7). */
export const GONE = 'This was changed or removed. Pull down to refresh.';
/** A change made against an older copy of the data. */
export const CHANGED = 'This changed. Pull down to refresh.';
export const TRY_AGAIN = 'Something went wrong. Try again.';
export const BAD_MONTH = 'That month isn’t in your budget. Pick another month.';

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
  return c.json({ error: 'internal', message: TRY_AGAIN }, 500);
};
budgetApi.onError(onError);

// ---------------------------------------------------------------- session and budget

budgetApi.get('/session', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(s, now);
  const [accounts, cats, settings] = await s.batch([
    s.q(`SELECT count(*) AS n FROM account WHERE budget_id = ?1`),
    s.q(`SELECT count(*) AS n FROM category WHERE budget_id = ?1 AND kind != 'cc_payment'`),
    s.q(`SELECT key, value FROM setting WHERE budget_id = ?1`),
  ]);
  const n = (r: Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0;
  const setting = new Map(
    (settings!.results as { key: string; value: string }[]).map((r) => [
      r.key,
      JSON.parse(r.value) as unknown,
    ]),
  );
  const setupStep: Session['budget']['setupStep'] = !f.budget.budget_start_month
    ? 'start'
    : n(accounts) === 0 && !setting.get('setup.skipLink') && canLinkBanks(c)
      ? 'link'
      : n(cats) === 0
        ? 'categories'
        : 'done';
  const u = await usageToday(c.env, now);
  const ws = classifyUsage(u.written, u.read, u.do, u.workers, dailyLimits(c.env));
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
    canLinkBanks: canLinkBanks(c),
    recoveryNoticeAt: c.get('recoveryNoticeAt') ? new Date(c.get('recoveryNoticeAt')!).toISOString() : null,
  };
  return c.json(body);
});

budgetApi.get('/budget/:month', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  return c.json(await budgetView(s, f, m));
});

budgetApi.get('/budget/:month/assign', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  return c.json(await assignView(s, f, m));
});

budgetApi.get('/categories/:id/sheet', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, clock(c.env));
  const m = c.req.query('month') ?? f.current;
  if (!isMonth(m)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const sheet = await categorySheet(s, f, c.req.param('id'), m);
  if (!sheet) throw new HttpError(404, 'not_found', GONE);
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
  if (known.length !== new Set(ids).size) throw new HttpError(404, 'not_found', GONE);
  const b = await s.first<{ budget_start_month: string | null }>(
    `SELECT budget_start_month FROM budget WHERE id = ?1`,
  );
  if (!b?.budget_start_month || month < b.budget_start_month)
    throw new HttpError(422, 'before_start', 'Months before your budget starts can’t be assigned.');
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
  await s.batch(stmts);
  return ACK;
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
  if (!items.length) throw new HttpError(400, 'invalid', 'Enter an amount to move.');
  return c.json(await addAssignments(c, r.month as Month, items));
});

budgetApi.put('/categories/:id/target', async (c) => {
  const r = await parse(TargetRequest, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const t = r.target;
  const exists = await s.first(`SELECT id FROM category WHERE budget_id = ?1 AND id = ?2`, id);
  if (!exists) throw new HttpError(404, 'not_found', GONE);
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
  return c.json(ACK);
});

budgetApi.route('/', syncRoutes);
budgetApi.route('/', activityViewRoutes);
budgetApi.route('/', activityRoutes);
budgetApi.route('/', samePurchaseRoutes);
budgetApi.route('/', transactionRoutes);
budgetApi.route('/', accountRoutes);
budgetApi.route('/', accountCloseRoutes);
budgetApi.route('/', settingsRoutes);
budgetApi.route('/', opsRoutes);
budgetApi.route('/', securityRoutes);

export { addMonths };
