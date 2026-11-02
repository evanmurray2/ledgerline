// Accounts (net worth, cash and cards, registers, repair and sync problems) and Reports.
import { clock } from '../http/clock.js';
import { Hono } from 'hono';
import {
  RenameAccount,
  type AccountRow,
  type AccountsView,
  type RegisterView,
  type ReportsView,
} from '@ledgerline/contracts';
import {
  type Month,
  addMonths,
  cents,
  formatCents,
  isMonth,
  owedList,
  owedOut,
  statementCovered,
} from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped, startRecompute } from './api.js';
import { cards as loadCards, fresh, monthResult, shortDate, structure } from '../views/common.js';
import { listRow } from '../views/rows.js';
import { RECENT_TX, TX_COLUMNS, type TxRow } from '../ledger/ledger.js';
import { inBudgetByAccount, monthTotals } from '../ledger/totals.js';
import type { Scoped } from '../db/scoped.js';

export const accountRoutes = new Hono<AppEnv>();

interface AcctDb {
  id: string;
  name: string;
  kind: 'checking' | 'savings' | 'credit';
  budget_from: string;
  starting_balance: number;
  provider_account_id: string | null;
  mask: string | null;
  bank: number | null;
  institution: string | null;
  status: string | null;
  last_synced_at: number | null;
  connection_id: string | null;
}

async function accountRows(s: Scoped, today: string): Promise<{ rows: AccountRow[]; raw: AcctDb[] }> {
  const [acc, pend] = await s.batch([
    s.q(
      `SELECT a.id, a.name, a.kind, a.budget_from, a.starting_balance, a.provider_account_id, pa.mask, pa.current_balance AS bank,
         c.institution_name AS institution, c.status, c.last_synced_at, c.id AS connection_id
       FROM account a
       LEFT JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
       LEFT JOIN connection c ON c.id = pa.connection_id
       WHERE a.budget_id = ?1 AND a.closed_at IS NULL ORDER BY a.kind = 'credit', a.sort, a.name`,
    ),
    s.q(
      `SELECT account_id, sum(amount) AS p FROM ${RECENT_TX} WHERE budget_id = ?1 AND status IN ('pending', 'upcoming') AND wont_clear = 0
         AND (status != 'upcoming' OR date <= ?2) GROUP BY account_id`,
      today,
    ),
  ]);
  const pending = new Map(
    (pend!.results as { account_id: string; p: number }[]).map((r) => [r.account_id, r.p]),
  );
  // Posted rows the budget counts, per account: stored totals for finished months plus the current month live
  // (ledger/totals.ts). From two months before the earliest budget start, for rows pending at link.
  const raw0 = acc!.results as AcctDb[];
  const earliest = raw0.reduce((m, a) => (a.budget_from < m ? a.budget_from : m), today);
  const postedSum = inBudgetByAccount(
    await monthTotals(
      s,
      addMonths(earliest.slice(0, 7) as Month, -2),
      today.slice(0, 7) as Month,
      Date.now(),
    ),
  );
  const cardInfo = new Map((await loadCards(s, today)).map((c) => [c.accountId, c]));
  const raw = acc!.results as AcctDb[];
  const rows = raw.map((a): AccountRow => {
    const credit = a.kind === 'credit';
    const ledgerPosted = a.starting_balance + (postedSum.get(a.id) ?? 0);
    // Bank-reported balance; cards report the amount owed. Manual accounts use the ledger.
    const bank = a.bank ?? (credit ? -ledgerPosted : ledgerPosted);
    const p = pending.get(a.id) ?? 0;
    const working = credit ? bank - p : bank + p;
    const drift = a.bank === null ? null : credit ? a.bank + ledgerPosted : a.bank - ledgerPosted;
    const ci = cardInfo.get(a.id);
    const statement = ci?.statement
      ? { balance: ci.statement.balance, due: ci.statement.due, covered: true }
      : null;
    const synced = a.last_synced_at
      ? `synced ${new Date(a.last_synced_at).toISOString().slice(11, 16)} UTC`
      : 'not synced yet';
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      institution: a.institution ?? 'Manual',
      mask: a.mask,
      bank: cents(bank),
      pending: cents(credit ? -p : p),
      working: cents(working),
      syncedAt: a.last_synced_at,
      connectionStatus:
        a.status === 'login_required' ? 'login_required' : a.status === 'error' ? 'error' : 'ok',
      drift: drift === null || drift === 0 ? null : cents(drift),
      statement,
      meta: `${a.institution ?? 'Manual'}${a.mask ? ` · ending ${a.mask}` : ''} · ${a.status === 'login_required' ? 'sign in again' : synced}`,
    };
  });
  return { rows, raw };
}

accountRoutes.get('/accounts', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(c.env, s, now, () => startRecompute(c.env, s.budgetId));
  const { rows } = await accountRows(s, f.today);
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const mr = await monthResult(s, f.current, start);
  for (const r of rows) {
    if (r.statement)
      r.statement.covered = statementCovered(
        mr?.cards[r.id]?.available ?? cents(0),
        cents(r.statement.balance),
      );
  }
  const cash = rows.filter((r) => r.kind !== 'credit');
  const credit = rows.filter((r) => r.kind === 'credit');
  const netWorth = cash.reduce((a, r) => a + r.bank, 0) - credit.reduce((a, r) => a + r.bank, 0);
  const [monthPosted, conns, health, hist, owedI, owedL] = await s.batch([
    s.q(
      `SELECT sum(amount) AS p FROM v_txn_bank WHERE budget_id = ?1 AND status = 'posted'
         AND posted_date >= date(?2 || '-01', '-1 month') AND substr(date, 1, 7) = ?2`,
      f.current,
    ),
    s.q(
      `SELECT id, institution_name, status, last_synced_at, last_attempt_at FROM connection WHERE budget_id = ?1 AND removed_at IS NULL`,
    ),
    s.q(`SELECT key, value, at FROM health_status WHERE budget_id = ?1`),
    s.q(
      `SELECT ref_key, data FROM alert WHERE budget_id = ?1 AND type = 'history_changed' AND acked_at IS NULL`,
    ),
    s.q(
      `SELECT id, txn_key, amount, expect_by, closed_at, canceled_at FROM expected_reimbursement e WHERE budget_id = ?1 AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
  ]);
  const owed = owedOut(
    owedList(
      (
        owedI!.results as {
          id: string;
          txn_key: string;
          amount: number;
          expect_by: string | null;
          closed_at: number | null;
          canceled_at: number | null;
        }[]
      ).map((o) => ({
        id: o.id,
        txnKey: o.txn_key,
        amount: cents(o.amount),
        expectBy: o.expect_by,
        closedAt: o.closed_at ? 'x' : null,
        canceledAt: o.canceled_at ? 'x' : null,
      })),
      (owedL!.results as { from_key: string; to_key: string; amount: number }[]).map((l) => ({
        inflowKey: l.from_key,
        itemId: l.to_key,
        amount: cents(l.amount),
      })),
      f.today,
    ),
  );
  const connRows = conns!.results as {
    id: string;
    institution_name: string;
    status: string;
    last_synced_at: number | null;
    last_attempt_at: number | null;
  }[];
  const alerts: AccountsView['alerts'] = [];
  const h = new Map(
    (health!.results as { key: string; value: string | null; at: number }[]).map((r) => [r.key, r]),
  );
  const hours = (k: string) => {
    const v = h.get(k)?.value;
    return v ? (now - Number(v)) / 3_600_000 : null;
  };
  // Only once the GitHub monitor has checked in at least once: it is optional (decisions.md D-29).
  const monitorAge = hours('last_monitor_check_at');
  if (h.has('watchdog_ran_at') && monitorAge !== null && monitorAge > 24)
    alerts.push({ kind: 'monitor', text: 'Monitoring stopped: no health check in the last 24 hours' });
  for (const cn of connRows)
    if (cn.status === 'ok' && cn.last_synced_at && now - cn.last_synced_at > 24 * 3_600_000)
      alerts.push({ kind: 'sync', text: `${cn.institution_name} hasn’t synced in over a day` });
  for (const a of hist!.results as { ref_key: string; data: string }[]) {
    const d = JSON.parse(a.data) as { month: string; amount: number };
    alerts.push({
      kind: 'history_changed',
      text: `History changed in ${d.month}: a posted transaction of ${formatCents(d.amount)} was removed or re-issued`,
    });
  }
  const view: AccountsView = {
    netWorth: cents(netWorth),
    netWorthChange: cents((monthPosted!.results[0] as { p: number | null }).p ?? 0),
    month: f.current,
    owedOut: owed,
    groups: [
      { name: 'Cash', total: cents(cash.reduce((a, r) => a + r.working, 0)), accounts: cash },
      { name: 'Credit cards', total: cents(credit.reduce((a, r) => a + r.working, 0)), accounts: credit },
    ].filter((g) => g.accounts.length),
    repairs: connRows
      .filter((x) => x.status === 'login_required')
      .map((x) => ({ connectionId: x.id, institution: x.institution_name, lastSynced: x.last_synced_at })),
    failures: connRows
      .filter((x) => x.status === 'error')
      .map((x) => ({
        connectionId: x.id,
        institution: x.institution_name,
        lastGood: x.last_synced_at,
        nextRetry: (x.last_attempt_at ?? now) + 4 * 3_600_000,
      })),
    alerts,
  };
  return c.json(view);
});

/** Rename an account. A card's payment category follows the new name. Syncs never change a name. */
accountRoutes.post('/accounts/:id/name', async (c) => {
  const r = await parse(RenameAccount, c.req.raw);
  const s = scoped(c);
  const now = clock(c.env);
  const id = c.req.param('id');
  const a = await s.first<{ name: string }>(`SELECT name FROM account WHERE budget_id = ?1 AND id = ?2`, id);
  if (!a) throw new HttpError(404, 'not_found', 'account');
  await s.batch([
    s.q(`UPDATE account SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2`, id, r.name, now),
    s.q(
      `UPDATE category SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND card_account_id = ?2 AND kind = 'cc_payment'`,
      id,
      r.name,
      now,
    ),
    s.audit('account.rename', 'account', id, { name: a.name }, r, now),
  ]);
  return c.json({ ok: true as const });
});

accountRoutes.get('/accounts/:id/register', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(c.env, s, now);
  const id = c.req.param('id');
  const show = c.req.query('show') ?? 'all';
  const { rows } = await accountRows(s, f.today);
  const account = rows.find((r) => r.id === id);
  if (!account) throw new HttpError(404, 'not_found', 'account');
  const { categories } = await structure(s);
  const cats = new Map(categories.map((x) => [x.id, x.name]));
  const accts = new Map(rows.map((r) => [r.id, r.name]));
  const txs = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2 ORDER BY date DESC, seq DESC LIMIT 300`,
    id,
  );
  const keep = (t: TxRow) =>
    show === 'all' ||
    (show === 'pending' && t.status !== 'posted') ||
    (show === 'needs' && !t.category_id && !t.to_rta && !t.transfer_state && !t.wtm_state) ||
    (show === 'transfers' && t.transfer_state !== null);
  const credit = account.kind === 'credit';
  const days: RegisterView['days'] = [];
  const pend = txs.filter((t) => t.status !== 'posted' && keep(t));
  if (pend.length)
    days.push({ label: 'Pending', balance: null, rows: pend.map((t) => listRow(t, accts, cats)) });
  // Running balance backwards from the bank balance, over posted rows.
  let bal = account.bank;
  const byDay = new Map<string, TxRow[]>();
  for (const t of txs.filter((x) => x.status === 'posted'))
    byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [d, ts] of byDay) {
    const dayBal = bal;
    for (const t of ts) bal = credit ? bal + t.amount : bal - t.amount;
    const shown = ts.filter(keep);
    if (shown.length)
      days.push({
        label: shortDate(d),
        balance: cents(dayBal),
        rows: shown.map((t) => listRow(t, accts, cats)),
      });
  }
  let note: string | null = null;
  if (credit) {
    const start = (f.budget.budget_start_month ?? f.current) as Month;
    const mr = await monthResult(s, f.current, start);
    const over = Object.entries(mr?.categories ?? {}).filter(([, v]) => (v.creditOverspent[id] ?? 0) > 0);
    if (over.length) {
      const amt = over.reduce((a, [, v]) => a + (v.creditOverspent[id] ?? 0), 0);
      const names = over.map(([k]) => cats.get(k) ?? k).join(', ');
      note = `${names} is ${formatCents(amt)} overspent on this card, so the payment category is ${formatCents(amt)} short of the card spending. Cover ${names} on the Budget to fix both.`;
    }
  }
  return c.json({ account, days, note } satisfies RegisterView);
});

accountRoutes.get('/reports', async (c) => {
  const s = scoped(c);
  const now = clock(c.env);
  const f = await fresh(c.env, s, now, () => startRecompute(c.env, s.budgetId));
  const m = (c.req.query('month') ?? f.current) as Month;
  if (!isMonth(m)) throw new HttpError(400, 'invalid', 'month');
  const start = (f.budget.budget_start_month ?? f.current) as Month;
  const { categories } = await structure(s);
  const kinds = new Map(categories.map((x) => [x.id, x]));
  const months: Month[] = [];
  for (let i = 5; i >= 0; i--) {
    const mm = addMonths(m, -i);
    if (mm >= start) months.push(mm);
  }
  const results = new Map<Month, Awaited<ReturnType<typeof monthResult>>>();
  for (const mm of months) results.set(mm, await monthResult(s, mm, start));
  const [inc, rew, owedI, owedL] = await s.batch([
    s.q(
      `SELECT l.month, sum(l.amount) AS a FROM budget_line l LEFT JOIN txn_overlay o ON o.txn_key = l.txn_key
       WHERE l.budget_id = ?1 AND l.kind = 'rta' AND l.card = 0 AND l.txn_key NOT LIKE 'start:%' AND coalesce(o.income_tag, '') != 'rewards'
         AND l.txn_key NOT IN (SELECT from_key FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL)
         AND l.month >= ?2 AND l.month <= ?3 GROUP BY l.month`,
      months[0] ?? m,
      m,
    ),
    s.q(
      `SELECT l.month, sum(l.amount) AS a FROM budget_line l LEFT JOIN txn_overlay o ON o.txn_key = l.txn_key
       WHERE l.budget_id = ?1 AND l.kind = 'rta' AND (l.card = 1 OR o.income_tag = 'rewards') AND l.month >= ?2 AND l.month <= ?3 GROUP BY l.month`,
      months[0] ?? m,
      m,
    ),
    s.q(
      `SELECT id, txn_key, amount, expect_by, closed_at, canceled_at FROM expected_reimbursement e WHERE budget_id = ?1 AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
  ]);
  const income = new Map((inc!.results as { month: string; a: number }[]).map((r) => [r.month, r.a]));
  const rewards = new Map((rew!.results as { month: string; a: number }[]).map((r) => [r.month, r.a]));
  const spentOf = (mm: Month, kind: 'spending' | 'saving') =>
    Object.entries(results.get(mm)?.categories ?? {}).reduce(
      (a, [id, v]) => a + ((kinds.get(id)?.kind ?? 'spending') === kind ? v.spent : 0),
      0,
    );
  const cur = results.get(m);
  const byCategory = Object.entries(cur?.categories ?? {})
    .filter(([id, v]) => (kinds.get(id)?.kind ?? 'spending') === 'spending' && v.spent > 0)
    .map(([id, v]) => ({ categoryId: id, name: kinds.get(id)?.name ?? id, spent: v.spent }))
    .sort((a, b) => b.spent - a.spent);
  // Net worth at each month end: today's figure minus everything posted after that month.
  const { rows } = await accountRows(s, f.today);
  const nwNow = rows.reduce((a, r) => a + (r.kind === 'credit' ? -r.bank : r.bank), 0);
  // Posted totals per month over the last 13 months (ledger/totals.ts: stored for finished months).
  const totals = await monthTotals(s, addMonths(f.current, -12), f.current, Date.now());
  const posted = [...totals].map(([mm, accts]) => ({
    m: mm,
    a: [...accts.values()].reduce((x, v) => x + v.all, 0),
  }));
  const netWorth: ReportsView['netWorth'] = [];
  let after = 0;
  for (let i = 0; i < 12; i++) {
    const mm = addMonths(f.current, -i);
    netWorth.unshift({ month: mm, value: cents(nwNow - after) });
    after += posted.find((p) => p.m === mm)?.a ?? 0;
  }
  const stillOwed = owedOut(
    owedList(
      (
        owedI!.results as {
          id: string;
          txn_key: string;
          amount: number;
          expect_by: string | null;
          closed_at: number | null;
          canceled_at: number | null;
        }[]
      ).map((o) => ({
        id: o.id,
        txnKey: o.txn_key,
        amount: cents(o.amount),
        expectBy: o.expect_by,
        closedAt: o.closed_at ? 'x' : null,
        canceledAt: o.canceled_at ? 'x' : null,
      })),
      (owedL!.results as { from_key: string; to_key: string; amount: number }[]).map((l) => ({
        inflowKey: l.from_key,
        itemId: l.to_key,
        amount: cents(l.amount),
      })),
      f.today,
    ),
  );
  const view: ReportsView = {
    month: m,
    monthToDate: m === f.current,
    tiles: {
      spent: cents(spentOf(m, 'spending')),
      invested: cents(spentOf(m, 'saving')),
      income: cents(income.get(m) ?? 0),
      rewards: cents(rewards.get(m) ?? 0),
    },
    byCategory,
    stillOwed,
    trend: months.map((mm) => ({
      month: mm,
      spent: cents(spentOf(mm, 'spending')),
      income: cents(income.get(mm) ?? 0),
      invested: cents(spentOf(mm, 'saving')),
    })),
    netWorth,
  };
  return c.json(view);
});
