// Accounts (net worth, cash and cards, registers, repair and sync problems) and Reports.
import { editNow } from '../http/clock.js';
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
  localDate,
  localTime,
  monthName,
  owedList,
  owedOut,
  statementCovered,
} from '@ledgerline/domain';
import type { AppEnv } from '../http/context.js';
import { HttpError, parse, scoped, GONE, BAD_MONTH, inReach } from './api.js';
import { cards as loadCards, fresh, monthResult, shortDate, structure } from '../views/common.js';
import { hiddenFromLists, listRow } from '../views/rows.js';
import { TX_COLUMNS, needsCategory, uncovered, type TxRow } from '../ledger/ledger.js';
import { monthTotals } from '../ledger/totals.js';
import { DIFF_WAIT_MS, accountLedger, bankDiff } from '../ledger/bank-diff.js';
import type { Scoped } from '../db/scoped.js';
import { type Adjustments, startSheet } from '../ledger/start-part.js';
import { FINAL_ROWS_BY_MONTH, closeBlocked } from './account-close.js';

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
  drift_since: number | null;
  closed_at: number | null;
  /** When its bank was removed (D-87): the account stays, not linked. */
  unlinked_at: number | null;
}

/** Every account's row; closed ones too when `withClosed` (their own list on Accounts, and their register). */
async function accountRows(
  s: Scoped,
  today: string,
  timeZone: string,
  now: number,
  withClosed = false,
): Promise<{ rows: AccountRow[]; raw: AcctDb[]; recent: Adjustments['recent'] }> {
  const raw = await s.all<AcctDb>(
    `SELECT a.id, a.name, a.kind, a.budget_from, a.starting_balance, a.provider_account_id, pa.mask, pa.current_balance AS bank,
       pa.drift_since, c.institution_name AS institution, c.status, c.last_synced_at, c.id AS connection_id, a.closed_at,
       c.removed_at AS unlinked_at
     FROM account a
     LEFT JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
     LEFT JOIN connection c ON c.id = pa.connection_id
     WHERE a.budget_id = ?1 AND (?2 = 1 OR a.closed_at IS NULL) ORDER BY a.kind = 'credit', a.sort, a.name`,
    withClosed ? 1 : 0,
  );
  const ledger = await accountLedger(s, raw, today, now);
  const startAdjust = ledger.startAdjust;
  const cardInfo = new Map((await loadCards(s, today, ledger, now)).map((c) => [c.accountId, c]));
  const rows = raw.map((a): AccountRow => {
    const credit = a.kind === 'credit';
    const ledgerPosted = ledger.posted.get(a.id) ?? a.starting_balance;
    // Bank-reported balance; cards report the amount owed. Manual accounts use the ledger.
    const bank = a.bank ?? (credit ? -ledgerPosted : ledgerPosted);
    const p = ledger.pending.get(a.id) ?? 0;
    // Pending the bank balance already took in counts once (D-68); what pending can't explain is the difference.
    const diff =
      a.bank === null ? { inBank: 0, left: 0 } : bankDiff(credit ? -a.bank : a.bank, ledgerPosted, p);
    const signedWorking = (credit ? -bank : bank) + p - diff.inBank;
    const working = credit ? -signedWorking : signedWorking;
    // Shown only once it has lasted a day (provider_account.drift_since, set by each sync): most are timing.
    const lasted = a.drift_since !== null && now - a.drift_since >= DIFF_WAIT_MS;
    // An account whose bank was removed has nothing to compare with (D-87): no difference line.
    const unlinked = a.unlinked_at !== null;
    const drift = diff.left !== 0 && lasted && !unlinked ? (credit ? -diff.left : diff.left) : null;
    const ci = cardInfo.get(a.id);
    const statement = ci?.statement
      ? { balance: ci.statement.balance, due: ci.statement.due, covered: true }
      : null;
    // A closed account is $0 (D-73). The bank's last balance and the pending rows that stayed (D-93) add up to that, and
    // the bank sends no more: show the $0, not the parts.
    const closed = a.closed_at !== null;
    const synced = a.last_synced_at
      ? `synced ${syncedWhen(a.last_synced_at, today, timeZone)}`
      : 'not synced yet';
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      institution: a.institution ?? 'Manual',
      mask: a.mask,
      bank: cents(closed ? working : bank),
      pending: cents(closed ? 0 : credit ? -p : p),
      working: cents(working),
      syncedAt: a.last_synced_at,
      connectionStatus:
        a.status === 'login_required' ? 'login_required' : a.status === 'error' ? 'error' : 'ok',
      drift: drift === null || closed ? null : cents(drift),
      pendingInBank: cents(closed ? 0 : Math.abs(diff.inBank)),
      statement,
      meta: `${a.institution ?? 'Manual'}${a.mask ? ` · ending ${a.mask}` : ''} · ${
        a.closed_at !== null
          ? `closed ${shortDate(localDate(a.closed_at, timeZone))}`
          : unlinked
            ? 'not linked'
            : a.status === 'login_required'
              ? 'sign in again'
              : synced
      }`,
      closed,
    };
  });
  return { rows, raw, recent: startAdjust.recent };
}

/** A sync time in the budget's time zone: "9:42 AM" today, "Nov 12" on an earlier day. */
function syncedWhen(at: number, today: string, timeZone: string): string {
  const day = localDate(at, timeZone);
  return day === today ? localTime(at, timeZone) : shortDate(day);
}

accountRoutes.get('/accounts', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const f = await fresh(s, now);
  const { rows: all } = await accountRows(s, f.today, f.budget.time_zone, now, true);
  const rows = all.filter((r) => !r.closed);
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
  // Net worth counts pending, like the Cash and Credit cards totals below (D-76), so the three numbers add up.
  const netWorth = cash.reduce((a, r) => a + r.working, 0) - credit.reduce((a, r) => a + r.working, 0);
  const netWorthAtBank = cash.reduce((a, r) => a + r.bank, 0) - credit.reduce((a, r) => a + r.bank, 0);
  const [monthPosted, conns, health, hist, owedI, owedL, finals] = await s.batch([
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
      `SELECT id, type, ref_key, data FROM alert WHERE budget_id = ?1 AND acked_at IS NULL
         AND type IN ('history_changed', 'possible_reissue', 'identity')
       ORDER BY created_at`,
    ),
    s.q(
      `SELECT id, txn_key, amount, expect_by, closed_at, canceled_at FROM expected_reimbursement e WHERE budget_id = ?1 AND NOT EXISTS (SELECT 1 FROM manual_pending mp WHERE mp.budget_id = e.budget_id AND mp.txn_key = e.txn_key AND mp.kind = 'upcoming' AND mp.matched_txn_key IS NULL)`,
    ),
    s.q(
      `SELECT from_key, to_key, amount FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL`,
    ),
    s.q(FINAL_ROWS_BY_MONTH),
  ]);
  // Pending rows that stayed in a closed account are final (D-93): this month's count with the posted rows.
  const finalNow =
    (finals!.results as { month: string; a: number }[]).find((r) => r.month === f.current)?.a ?? 0;
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
    alerts.push({ kind: 'monitor', text: 'Ledgerline hasn’t checked your banks in over a day.' });
  for (const cn of connRows)
    if (cn.status === 'ok' && cn.last_synced_at && now - cn.last_synced_at > 24 * 3_600_000)
      alerts.push({ kind: 'sync', text: `${cn.institution_name} hasn’t synced in over a day.` });
  for (const a of hist!.results as StoredAlert[]) alerts.push(storedAlert(a));
  const view: AccountsView = {
    netWorth: cents(netWorth),
    // Posted this month, plus pending (the gap between net worth and the bank's balances): the same step as the
    // Reports chart from last month's end to now.
    netWorthChange: cents(
      ((monthPosted!.results[0] as { p: number | null }).p ?? 0) + finalNow + netWorth - netWorthAtBank,
    ),
    month: f.current,
    owedOut: owed,
    groups: [
      { name: 'Cash', total: cents(cash.reduce((a, r) => a + r.working, 0)), accounts: cash },
      { name: 'Credit cards', total: cents(credit.reduce((a, r) => a + r.working, 0)), accounts: credit },
    ].filter((g) => g.accounts.length),
    closed: all.filter((r) => r.closed),
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

interface StoredAlert {
  id: string;
  type: string;
  ref_key: string;
  data: string | null;
}

/** An alert the sync, the daily scan or a phone saved (the `alert` table), as one line on Accounts. */
export function storedAlert(a: StoredAlert): AccountsView['alerts'][number] {
  const d = (a.data ? JSON.parse(a.data) : {}) as Record<string, unknown>;
  const base = { id: a.id };
  switch (a.type) {
    case 'history_changed':
      return {
        ...base,
        kind: 'history_changed',
        text: `A posted ${formatCents(Number(d.amount))} transaction in ${isMonth(String(d.month)) ? monthName(String(d.month) as Month, true) : 'a past month'} was removed or re-issued. Check for a double.`,
      };
    case 'ambiguous_match':
      return {
        ...base,
        kind: 'ambiguous_match',
        txnKey: a.ref_key,
        text: 'A posted charge matched one of several pending charges. Check that it’s the right one.',
      };
    case 'possible_reissue':
      return {
        ...base,
        kind: 'possible_reissue',
        text: 'The bank removed a posted transaction and added new ones. Check for a double.',
      };
    default:
      return {
        ...base,
        kind: 'identity',
        text: `Ready to Assign for ${isMonth(String(d.month)) ? monthName(String(d.month) as Month, true) : 'a past month'} was off by ${formatCents(Math.abs(Number(d.difference)))} on a device. Pull down to sync again.`,
      };
  }
}

/** Dismiss a stored alert. It stays in the table, marked as seen. */
accountRoutes.post('/alerts/:id/dismiss', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const a = await s.first<{ id: string }>(`SELECT id FROM alert WHERE budget_id = ?1 AND id = ?2`, id);
  if (!a) throw new HttpError(404, 'not_found', GONE);
  await s.batch([
    s.q(`UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND id = ?2 AND acked_at IS NULL`, id, now),
    s.audit('alert.dismiss', 'alert', id, null, null, now),
  ]);
  return c.json({ ok: true as const });
});

/** Rename an account. A card's payment category follows the new name. Syncs never change a name. */
accountRoutes.post('/accounts/:id/name', async (c) => {
  const r = await parse(RenameAccount, c.req.raw);
  const s = scoped(c);
  const now = editNow(c);
  const id = c.req.param('id');
  const a = await s.first<{ name: string }>(`SELECT name FROM account WHERE budget_id = ?1 AND id = ?2`, id);
  if (!a) throw new HttpError(404, 'not_found', GONE);
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
  const now = editNow(c);
  const f = await fresh(s, now);
  const id = c.req.param('id');
  const show = c.req.query('show') ?? 'all';
  const { rows, raw, recent } = await accountRows(s, f.today, f.budget.time_zone, now, true);
  const account = rows.find((r) => r.id === id);
  const rawAccount = raw.find((r) => r.id === id);
  if (!account || !rawAccount) throw new HttpError(404, 'not_found', GONE);
  const { categories } = await structure(s);
  const cats = new Map(categories.map((x) => [x.id, x.name]));
  const accts = new Map(rows.map((r) => [r.id, r.name]));
  const txs = await s.all<TxRow>(
    `SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND account_id = ?2 AND ${uncovered('v_transaction')}
       ORDER BY date DESC, seq DESC LIMIT 300`,
    id,
  );
  // "Before your budget" rows are never listed (D-62), but the running balance still walks through them.
  const keep = (t: TxRow) =>
    !hiddenFromLists(t) &&
    (show === 'all' ||
      (show === 'pending' && !dated(t)) ||
      (show === 'needs' && needsCategory(t)) ||
      (show === 'transfers' && t.transfer_state !== null));
  const credit = account.kind === 'credit';
  const days: RegisterView['days'] = [];
  // In a closed account pending rows are final (D-93): listed on their day, in the running balance.
  const dated = (t: TxRow) => t.status === 'posted' || (account.closed && t.status === 'pending');
  const pend = txs.filter((t) => !dated(t) && keep(t));
  if (pend.length)
    days.push({ label: 'Pending', balance: null, rows: pend.map((t) => listRow(t, accts, cats)) });
  // Running balance backwards from the bank balance, over posted rows.
  let bal = account.bank;
  const byDay = new Map<string, TxRow[]>();
  for (const t of txs.filter(dated)) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  for (const [d, ts] of byDay) {
    const dayBal = bal;
    for (const t of ts.filter((x) => !x.wont_clear)) bal = credit ? bal + t.amount : bal - t.amount;
    const shown = ts.filter(keep);
    if (shown.length)
      days.push({
        // The year too when it isn't this year: two days a year apart would read (and key) the same.
        label: d.slice(0, 4) === f.today.slice(0, 4) ? shortDate(d) : `${shortDate(d)}, ${d.slice(0, 4)}`,
        balance: cents(dayBal),
        rows: shown.map((t) => listRow(t, accts, cats)),
      });
  }
  let note: string | null = null;
  let cardAvailable: number | null = null;
  if (credit) {
    const start = (f.budget.budget_start_month ?? f.current) as Month;
    const mr = await monthResult(s, f.current, start);
    cardAvailable = mr?.cards[id]?.available ?? 0;
    const over = Object.entries(mr?.categories ?? {}).filter(([, v]) => (v.creditOverspent[id] ?? 0) > 0);
    if (over.length) {
      const amt = over.reduce((a, [, v]) => a + (v.creditOverspent[id] ?? 0), 0);
      const names = over.map(([k]) => cats.get(k) ?? k).join(', ');
      note = `${names} is overspent by ${formatCents(amt)} on this card. Cover it on Budget to fix the card payment too.`;
    }
  }
  const start = await startSheet(s, rawAccount, recent.get(id) ?? null, now, f.budget.time_zone);
  const closeBlock = account.closed
    ? null
    : closeBlocked(
        account,
        {
          pending: txs.some((t) => t.status === 'pending'),
          upcoming: txs.some((t) => t.status === 'upcoming'),
        },
        cardAvailable,
      );
  return c.json({
    account,
    days,
    note,
    start,
    closeBlock,
    cardAvailable: cardAvailable === null ? null : cents(cardAvailable),
  } satisfies RegisterView);
});

accountRoutes.get('/reports', async (c) => {
  const s = scoped(c);
  const now = editNow(c);
  const f = await fresh(s, now);
  const m = (c.req.query('month') ?? f.current) as Month;
  if (!isMonth(m) || !inReach(m, f.current)) throw new HttpError(400, 'invalid', BAD_MONTH);
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
       WHERE l.budget_id = ?1 AND l.kind = 'rta' AND l.card = 0 AND l.txn_key NOT LIKE 'start:%' AND l.line != 'start' AND coalesce(o.income_tag, '') != 'rewards'
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
  // Net worth at each month end: the bank's balances today minus everything posted after that month. This month's
  // point counts pending, as Accounts does (D-76); a finished month's pending has posted since, so it's in the bank.
  const { rows } = await accountRows(s, f.today, f.budget.time_zone, now);
  const nwNow = rows.reduce((a, r) => a + (r.kind === 'credit' ? -r.bank : r.bank), 0);
  const nwWorking = rows.reduce((a, r) => a + (r.kind === 'credit' ? -r.working : r.working), 0);
  // Posted totals per month over the last 13 months (ledger/totals.ts: stored for finished months).
  const totals = await monthTotals(s, addMonths(f.current, -12), f.current, now);
  const posted = [...totals].map(([mm, accts]) => ({
    m: mm,
    a: [...accts.values()].reduce((x, v) => x + v.all, 0),
  }));
  // Pending rows that stayed in closed accounts are final (D-93): they count in their month, as posted rows do.
  const finals = new Map(
    (await s.all<{ month: string; a: number }>(FINAL_ROWS_BY_MONTH)).map((r) => [r.month, r.a]),
  );
  const netWorth: ReportsView['netWorth'] = [];
  let after = 0;
  for (let i = 0; i < 12; i++) {
    const mm = addMonths(f.current, -i);
    netWorth.unshift({ month: mm, value: cents(i === 0 ? nwWorking : nwNow - after) });
    after += (posted.find((p) => p.m === mm)?.a ?? 0) + (finals.get(mm) ?? 0);
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
