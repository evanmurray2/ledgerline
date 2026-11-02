import { Hono } from 'hono';
import { clock } from '../http/clock.js';
import { SettingsPatch, SetupStart, StartingBalances } from '@ledgerline/contracts';
import type { AppEnv } from '../http/context.js';
import { HttpError, afterWrite, parse, scoped } from './api.js';
import { budgetMeta, planStartLines, toLedgerAccount, type AccountRowDb } from '../ledger/ledger.js';

import { categoriesRoutes } from './settings/categories.js';
import { rulesRoutes } from './settings/rules.js';
import { payeesRoutes } from './settings/payees.js';
import { connectionsRoutes } from './settings/connections.js';

/** Settings: each section has its own routes in settings/; first run and preferences are here. */
export const settingsRoutes = new Hono<AppEnv>();
settingsRoutes.route('/', categoriesRoutes);
settingsRoutes.route('/', rulesRoutes);
settingsRoutes.route('/', payeesRoutes);
settingsRoutes.route('/', connectionsRoutes);

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
