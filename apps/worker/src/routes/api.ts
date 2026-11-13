import { newId } from '../http/ids.js';
import type { Result } from '@ledgerline/db/sql';
import { type Context, Hono } from 'hono';
import { editNow } from '../http/clock.js';
import { z } from 'zod';
import {
  AssignRequest,
  MoveRequest,
  SetAssignedRequest,
  TargetRequest,
  type MutationAck,
  type Session,
} from '@ledgerline/contracts';
import { type Month, addMonths, currentMonth, isMonth, monthsBetween } from '@ledgerline/domain';

import type { AppEnv } from '../http/context.js';
import { csrf } from '../http/security.js';
import { bumpOnChange } from '../http/version.js';
import { Scoped } from '../db/scoped.js';
import { budgetView } from '../views/budget.js';
import { fresh, monthLong } from '../views/common.js';
import { usageToday, classifyUsage, dailyLimits } from '../sync/breaker.js';
import { activityRoutes } from './activity.js';
import { transferRoutes } from './transfers.js';
import { activityViewRoutes } from './activity-view.js';
import { samePurchaseRoutes } from './same-purchase.js';
import { notSameUndoRoutes } from './not-same-undo.js';
import { activityUndoRoutes } from './activity-undo.js';
import { transactionRoutes } from './transactions.js';
import { accountRoutes } from './accounts.js';
import { accountCloseRoutes } from './account-close.js';
import { registerRoutes } from './account-register.js';
import { reportRoutes } from './reports.js';
import { settingsRoutes } from './settings.js';
import { categorySheet, assignView } from '../views/category.js';
import { canLinkBanks } from '../http/context.js';

/**
 * One budget's API: every screen and every change of the budget. Every budget is locked (D-102), so these routes
 * run only on the device, in the engine (local/engine.ts), over the device's own copy.
 */
export const budgetApi = new Hono<AppEnv>();

budgetApi.use('*', csrf);

/** Every change bumps the budget's data version (http/version.ts). */
budgetApi.use('*', bumpOnChange);

/** Writes are refused when the account is at 90% of a daily limit (Sync spec F8). */
budgetApi.use('*', async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD') return next();
  // Inside a budget's Durable Object, account usage comes from the Directory (USAGE); elsewhere, from usage_day.
  const ask = c.env.USAGE_FOR_WRITE ?? c.env.USAGE;
  const u = ask ? await ask() : await usageToday(c.env);
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
  checkBodyAmounts(r.data);
  return r.data;
}

/** The fields of a request body that hold money, wherever they sit (a split line, an owed share, a balance). */
const AMOUNT_KEYS = new Set(['amount', 'assigned', 'monthly', 'estimatedAmount', 'startingBalance']);
/** Every money field in a request body is held to MAX_AMOUNT, so no route can store a sum the phone can't add up. */
function checkBodyAmounts(v: unknown): void {
  if (Array.isArray(v)) for (const x of v) checkBodyAmounts(x);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' && AMOUNT_KEYS.has(k)) checkAmounts(x);
      else checkBodyAmounts(x);
    }
}

/** A missing thing, said so the reader can act (docs/copy.md rule 7). */
export const GONE = 'This was changed or removed. Check it and try again.';
/** A change made against an older copy of the data. */
export const CHANGED = 'This changed. Check it and try again.';
export const TRY_AGAIN = 'Something went wrong. Try again.';
export const BAD_MONTH = 'That month isn’t in your budget. Pick another month.';
/**
 * The largest amount any money field in a request may hold: $99,999,999.99. Larger ones would let sums pass
 * JavaScript's safe integers, and the phone could no longer work the budget out.
 */
export const MAX_AMOUNT = 9_999_999_999;
export const TOO_LARGE = 'Enter an amount up to $99,999,999.99.';
function checkAmounts(...amounts: (number | null | undefined)[]): void {
  if (amounts.some((a) => a != null && Math.abs(a) > MAX_AMOUNT))
    throw new HttpError(422, 'too_large', TOO_LARGE);
}

export const FAR_DATE = 'Pick a date within 10 years of today.';
export const FAR_MONTH = 'Pick a month within 10 years of this one.';

/**
 * How far from this month a budget month may be. The phone works out every month from the budget start to the last
 * month anything is in, so a month thousands of years away (`9999-12`) would never finish and the app would stop.
 */
export const MONTHS_IN_REACH = 120;
export function inReach(m: string, current: Month): boolean {
  return isMonth(m) && Math.abs(monthsBetween(current, m as Month)) <= MONTHS_IN_REACH;
}

/** This month in the budget's time zone. */
export async function thisMonth(s: Scoped, now: number): Promise<Month> {
  const b = await s.first<{ time_zone: string }>(`SELECT time_zone FROM budget WHERE id = ?1`);
  return currentMonth(now, b?.time_zone ?? 'America/Los_Angeles');
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
  return c.json({ error: 'internal', message: TRY_AGAIN }, 500);
};
budgetApi.onError(onError);

// ---------------------------------------------------------------- session and budget

budgetApi.get('/session', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const f = await fresh(s, now);
  const [accounts, cats, settings] = await s.batch([
    s.q(`SELECT count(*) AS n FROM account WHERE budget_id = ?1`),
    s.q(`SELECT count(*) AS n FROM category WHERE budget_id = ?1 AND kind != 'cc_payment'`),
    s.q(`SELECT key, value FROM setting WHERE budget_id = ?1`),
  ]);
  const n = (r: Result | undefined) => (r?.results[0] as { n: number } | undefined)?.n ?? 0;
  // Not every setting is JSON: a sealed budget's filing notes (local/sealed-filing.ts) are plain text. One that
  // doesn't read is left out; the session reads only its own keys.
  const setting = new Map<string, unknown>();
  for (const r of settings!.results as { key: string; value: string }[]) {
    try {
      setting.set(r.key, JSON.parse(r.value));
    } catch {
      // Not JSON: not a setting the session reads.
    }
  }
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
    // Always: banks are linked on Plaid's own site. An app from before the script was removed still reads this.
    hostedLink: true,
  };
  return c.json(body);
});

budgetApi.get('/budget/:month', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  if (!inReach(m, f.current)) throw new HttpError(400, 'invalid', BAD_MONTH);
  return c.json(await budgetView(s, f, m));
});

budgetApi.get('/budget/:month/assign', async (c) => {
  const m = c.req.param('month');
  if (!isMonth(m)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  if (!inReach(m, f.current)) throw new HttpError(400, 'invalid', BAD_MONTH);
  return c.json(await assignView(s, f, m));
});

budgetApi.get('/categories/:id/sheet', async (c) => {
  const s = scoped(c);
  const f = await fresh(s, editNow(c));
  const m = c.req.query('month') ?? f.current;
  if (!isMonth(m) || !inReach(m, f.current)) throw new HttpError(400, 'invalid', BAD_MONTH);
  const sheet = await categorySheet(s, f, c.req.param('id'), m);
  if (!sheet) throw new HttpError(404, 'not_found', GONE);
  return c.json(sheet);
});

async function addAssignments(
  c: Context<AppEnv>,
  month: Month,
  items: { categoryId: string; amount: number; set?: boolean; was?: number | undefined }[],
): Promise<MutationAck> {
  checkAmounts(...items.map((i) => i.amount));
  const s = scoped(c);
  const now = editNow(c);
  const ids = items.map((i) => i.categoryId);
  const known = await s.all<{ id: string }>(
    `SELECT id FROM category WHERE budget_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
    ...ids,
  );
  if (known.length !== new Set(ids).size) throw new HttpError(404, 'not_found', GONE);
  const b = await s.first<{ budget_start_month: string | null; time_zone: string }>(
    `SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`,
  );
  if (!b?.budget_start_month || month < b.budget_start_month)
    throw new HttpError(422, 'before_start', 'Months before your budget starts can’t be assigned.');
  if (!inReach(month, currentMonth(now, b.time_zone))) throw new HttpError(422, 'too_far', FAR_MONTH);
  // What each category holds now: an add sent with what the device saw (`was`) goes ahead only if that is still
  // so, and no category may end up past MAX_AMOUNT, which an add of allowed amounts could otherwise reach.
  const held = new Map(
    (
      await s.all<{ category_id: string; amount: number }>(
        `SELECT category_id, amount FROM assignment WHERE budget_id = ?1 AND month = ?2 AND category_id IN (${ids.map((_, i) => `?${i + 3}`).join(',')})`,
        month,
        ...ids,
      )
    ).map((r) => [r.category_id, r.amount]),
  );
  if (items.some((i) => i.was !== undefined && i.was !== (held.get(i.categoryId) ?? 0)))
    throw new HttpError(409, 'changed', CHANGED);
  const after = new Map(held);
  for (const i of items) after.set(i.categoryId, (i.set ? 0 : (after.get(i.categoryId) ?? 0)) + i.amount);
  checkAmounts(...after.values());
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
  const now = editNow(c);
  const id = c.req.param('id');
  const t = r.target;
  if (t.type !== 'none') checkAmounts(t.amount, t.type === 'no_date' ? t.monthly : null);
  // A balance by a date that has already gone by asks for nothing and reads as funded.
  if (t.type === 'by_date' && t.targetMonth < r.month)
    throw new HttpError(
      422,
      'past_month',
      `Choose a month from ${monthLong(r.month)} ${r.month.slice(0, 4)} on.`,
    );
  const exists = await s.first(`SELECT id FROM category WHERE budget_id = ?1 AND id = ?2`, id);
  if (!exists) throw new HttpError(404, 'not_found', GONE);
  // Versioned: a new version from this month on; past months keep the target they were budgeted against.
  await s.batch([
    s.q(
      `INSERT INTO target (id, budget_id, category_id, type, amount, period_months, period_anchor, target_month, monthly_contribution, effective_from, created_at)
       VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (category_id, effective_from) DO UPDATE SET type = excluded.type, amount = excluded.amount, period_months = excluded.period_months,
         period_anchor = excluded.period_anchor, target_month = excluded.target_month, monthly_contribution = excluded.monthly_contribution`,
      newId(c),
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

budgetApi.route('/', activityViewRoutes);
budgetApi.route('/', activityRoutes);
budgetApi.route('/', transferRoutes);
budgetApi.route('/', samePurchaseRoutes);
budgetApi.route('/', notSameUndoRoutes);
budgetApi.route('/', activityUndoRoutes);
budgetApi.route('/', transactionRoutes);
budgetApi.route('/', accountRoutes);
budgetApi.route('/', accountCloseRoutes);
budgetApi.route('/', registerRoutes);
budgetApi.route('/', reportRoutes);
budgetApi.route('/', settingsRoutes);

export { addMonths };
