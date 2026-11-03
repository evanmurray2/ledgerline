// Loads logical transactions (v_transaction + splits, owed marks and links) into the domain's LogicalTxn shape,
// and keeps budget_line in step with them: every write that changes a transaction rebuilds that transaction's
// lines and marks the budget dirty from the earliest month affected.
import type { Stmt } from '@ledgerline/db/sql';
import {
  type AccountKind,
  type BudgetLine,
  type IsoDate,
  type LedgerAccount,
  type LogicalTxn,
  type Month,
  type OwedMark,
  type TxnUse,
  cents,
  linesForTxn,
  monthOfDate,
  startLines,
} from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import { markDirty } from '../budget/recompute.js';

export interface TxRow {
  key: string;
  source: 'bank' | 'manual';
  account_id: string;
  account_kind: 'checking' | 'savings' | 'credit';
  account_name: string;
  budget_from: string;
  amount: number;
  bank_amount: number | null;
  date: string;
  posted_date: string | null;
  status: 'pending' | 'posted' | 'upcoming';
  payee: string;
  raw_name: string;
  merchant_entity_id: string | null;
  provider_category: string | null;
  payment_channel: string | null;
  provider_txn_id: string | null;
  pending_provider_txn_id: string | null;
  seq: number;
  repeats: string | null;
  category_id: string | null;
  to_rta: number | null;
  income_tag: string | null;
  memo: string | null;
  budget_month: string | null;
  estimated_amount: number | null;
  wont_clear: number;
  transfer_state: string | null;
  transfer_account_id: string | null;
  wtm_state: string | null;
  categorized_by: string | null;
  rule_id: string | null;
  reviewed_at: number | null;
  pending_at_link: number;
  alert: string | null;
  payee_id: string | null;
}

export const TX_COLUMNS = `key, source, account_id, account_kind, account_name, budget_from, amount, bank_amount, date, posted_date,
  status, payee, raw_name, merchant_entity_id, provider_category, payment_channel, provider_txn_id, pending_provider_txn_id,
  seq, repeats, category_id, to_rta, income_tag, memo, budget_month, estimated_amount, wont_clear, transfer_state,
  transfer_account_id, wtm_state, categorized_by, rule_id, reviewed_at, pending_at_link, alert, payee_id`;

/** The earliest account budget start: rows posted before it are history for every account. */
const MIN_FROM = `(SELECT min(budget_from) FROM account WHERE budget_id = ?1)`;

/**
 * v_transaction narrowed to the rows the budget can count, read through indexes so older history is never read:
 * bank rows posted on or after the earliest budget start (bank_txn_budget_date), bank rows still pending from before
 * it, which can be pending at link (bank_txn_pending; the unary + keeps the planner on that index), and all manual
 * rows. Callers still apply their own budget_from conditions. Binds ?1 (budget id).
 */
export const RECENT_TX = `(SELECT * FROM v_txn_bank WHERE budget_id = ?1 AND posted_date >= ${MIN_FROM}
  UNION ALL SELECT * FROM v_txn_bank WHERE budget_id = ?1 AND bank_pending = 1 AND +posted_date < ${MIN_FROM}
  UNION ALL SELECT * FROM v_txn_manual WHERE budget_id = ?1)`;

/**
 * One column of the transaction with this key, looked up through an index (bank_txn_key, then manual_pending's
 * txn_key). Joining v_transaction instead reads every transaction, since a UNION ALL can't be joined by index.
 */
export const txnCol = (key: string, col: string) =>
  `coalesce((SELECT ${col} FROM v_txn_bank WHERE key = ${key}), (SELECT ${col} FROM v_txn_manual WHERE key = ${key}))`;

export interface SplitRow {
  id: string;
  txn_key: string;
  category_id: string | null;
  amount: number;
  memo: string | null;
  absorbs_remainder: number;
  sort: number;
}

export interface OwedRow {
  id: string;
  txn_key: string;
  split_id: string | null;
  amount: number;
  fraction_num: number | null;
  fraction_den: number | null;
  expect_by: string | null;
  memo: string | null;
  closed_at: number | null;
  closed_month: string | null;
  closed_amount: number | null;
  canceled_at: number | null;
}

export interface LinkRow {
  id: string;
  kind: 'transfer' | 'refund_of' | 'reimbursement_of' | 'pending_match' | 'reissue';
  from_key: string;
  to_key: string;
  amount: number | null;
  created_by: string;
  created_at: number;
}

export interface AccountRowDb {
  id: string;
  name: string;
  kind: AccountKind;
  budget_from: string;
  starting_balance: number;
  provider_account_id: string | null;
  closed_at: number | null;
  stale_pending_days: number;
  sort: number;
}

export function toLedgerAccount(a: AccountRowDb): LedgerAccount {
  return { id: a.id, kind: a.kind, budgetFrom: a.budget_from, startingBalance: cents(a.starting_balance) };
}

export function useOf(t: TxRow, splits: SplitRow[], matched = 0): TxnUse {
  if (t.wtm_state === 'waiting' || t.wtm_state === 'send_back')
    return matched > 0 ? { type: 'waiting', matched: cents(matched) } : { type: 'waiting' };
  if (t.transfer_state === 'paired' && t.transfer_account_id)
    return { type: 'transfer', otherAccountId: t.transfer_account_id };
  if (t.transfer_state === 'unsorted') return { type: 'unsorted' };
  if (t.transfer_state === 'manual') return { type: 'offbudget' };
  if (splits.length) {
    return {
      type: 'split',
      lines: [...splits]
        .sort((a, b) => a.sort - b.sort)
        .map((s) => ({ id: s.id, categoryId: s.category_id, amount: cents(s.amount) })),
    };
  }
  if (t.to_rta === 1 || t.wtm_state === 'matched' || t.wtm_state === 'income') return { type: 'rta' };
  if (t.category_id) return { type: 'category', categoryId: t.category_id };
  return { type: 'uncategorized' };
}

export function toLogical(
  t: TxRow,
  splits: SplitRow[],
  owed: OwedRow[],
  refundOf: string | undefined,
  matched = 0,
): LogicalTxn {
  const marks: OwedMark[] = owed.map((o) => ({
    itemId: o.id,
    amount: cents(o.amount),
    ...(o.split_id ? { splitLineId: o.split_id } : {}),
    ...(o.canceled_at ? { canceled: true } : {}),
    ...(o.closed_at && o.closed_month && o.closed_amount !== null
      ? {
          closed: {
            month: o.closed_month as Month,
            date: `${o.closed_month}-01`,
            amount: cents(o.closed_amount),
          },
        }
      : {}),
  }));
  return {
    key: t.key,
    accountId: t.account_id,
    date: t.date,
    amount: cents(t.amount),
    status: t.status,
    wontClear: t.wont_clear === 1,
    seq: t.seq,
    ...(t.budget_month ? { budgetMonth: t.budget_month as Month } : {}),
    ...(t.pending_at_link ? { pendingAtLink: true } : {}),
    use: useOf(t, splits, matched),
    ...(refundOf ? { refundOf } : {}),
    ...(marks.length ? { owed: marks } : {}),
  };
}

function inList(keys: readonly string[], first: number): string {
  return keys.map((_, i) => `?${first + i}`).join(',');
}

/** SQLite in a Durable Object allows at most 100 bound parameters per statement; IN lists are split into chunks of this size. */
export const IN_CHUNK = 90;

export function chunks<T>(xs: readonly T[], n = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Loads the given transactions (by key) with their splits, owed marks and refund links. */
export async function loadTxns(
  s: Scoped,
  keys: readonly string[],
): Promise<{
  rows: TxRow[];
  logical: Map<string, LogicalTxn>;
  splits: Map<string, SplitRow[]>;
  owed: Map<string, OwedRow[]>;
}> {
  const rows: TxRow[] = [];
  const splitsBy = new Map<string, SplitRow[]>();
  const owedBy = new Map<string, OwedRow[]>();
  const refund = new Map<string, string>();
  const matched = new Map<string, number>();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const ph = inList(chunk, 2);
    const [t, sp, ow, ln, mt] = await s.batch([
      s.q(`SELECT ${TX_COLUMNS} FROM v_transaction WHERE budget_id = ?1 AND key IN (${ph})`, ...chunk),
      s.q(`SELECT * FROM txn_split WHERE budget_id = ?1 AND txn_key IN (${ph})`, ...chunk),
      s.q(`SELECT * FROM expected_reimbursement WHERE budget_id = ?1 AND txn_key IN (${ph})`, ...chunk),
      s.q(
        `SELECT from_key, to_key FROM txn_link WHERE budget_id = ?1 AND kind = 'refund_of' AND undone_at IS NULL AND from_key IN (${ph})`,
        ...chunk,
      ),
      s.q(
        `SELECT from_key, sum(amount) AS m FROM txn_link WHERE budget_id = ?1 AND kind = 'reimbursement_of' AND undone_at IS NULL AND from_key IN (${ph}) GROUP BY from_key`,
        ...chunk,
      ),
    ]);
    for (const r of mt!.results as { from_key: string; m: number }[]) matched.set(r.from_key, r.m);
    rows.push(...(t!.results as TxRow[]));
    for (const r of sp!.results as SplitRow[])
      splitsBy.set(r.txn_key, [...(splitsBy.get(r.txn_key) ?? []), r]);
    for (const r of ow!.results as OwedRow[]) owedBy.set(r.txn_key, [...(owedBy.get(r.txn_key) ?? []), r]);
    for (const r of ln!.results as { from_key: string; to_key: string }[]) refund.set(r.from_key, r.to_key);
  }
  const logical = new Map<string, LogicalTxn>();
  for (const r of rows)
    logical.set(
      r.key,
      toLogical(
        r,
        splitsBy.get(r.key) ?? [],
        owedBy.get(r.key) ?? [],
        refund.get(r.key),
        matched.get(r.key) ?? 0,
      ),
    );
  return { rows, logical, splits: splitsBy, owed: owedBy };
}

export interface BudgetMeta {
  startMonth: Month;
  timeZone: string;
}

export async function budgetMeta(s: Scoped): Promise<BudgetMeta | null> {
  const b = await s.first<{ budget_start_month: string | null; time_zone: string }>(
    `SELECT budget_start_month, time_zone FROM budget WHERE id = ?1`,
  );
  if (!b?.budget_start_month) return null;
  return { startMonth: b.budget_start_month as Month, timeZone: b.time_zone };
}

type LineRow = [
  string,
  string,
  string,
  string,
  number,
  string,
  string,
  number,
  string | null,
  number,
  string | null,
];

function rowsFor(
  key: string,
  lines: BudgetLine[],
  extra: { waiting: number; unsorted: number; uncategorized: number },
  t: LogicalTxn,
): LineRow[] {
  const out: LineRow[] = [];
  for (const l of lines) {
    const suffix = l.id.slice(key.length + 1);
    switch (l.kind) {
      case 'rta':
        out.push([
          key,
          suffix,
          l.month,
          l.date,
          l.seq,
          'rta',
          l.accountId,
          l.card ? 1 : 0,
          null,
          l.amount,
          null,
        ]);
        break;
      case 'cat':
        out.push([
          key,
          suffix,
          l.month,
          l.date,
          l.seq,
          'cat',
          l.accountId,
          l.card ? 1 : 0,
          l.categoryId,
          l.amount,
          l.refundOf ?? null,
        ]);
        break;
      case 'owed':
        out.push([
          key,
          suffix,
          l.month,
          l.date,
          l.seq,
          'owed',
          l.accountId,
          l.card ? 1 : 0,
          null,
          l.amount,
          l.itemId,
        ]);
        break;
      case 'close':
        out.push([
          key,
          suffix,
          l.month,
          l.date,
          l.seq,
          'close',
          t.accountId,
          0,
          l.categoryId,
          l.amount,
          l.itemId,
        ]);
        break;
      case 'payment':
        out.push([key, suffix, l.month, l.date, l.seq, 'payment', l.cardAccountId, 1, null, l.amount, null]);
        break;
      case 'debt':
        out.push([key, suffix, l.month, l.date, l.seq, 'debt', l.cardAccountId, 1, null, l.amount, null]);
        break;
    }
  }
  const m = lines[0]?.month ?? monthOfDate(t.date);
  if (extra.waiting)
    out.push([key, 'wait', m, t.date, t.seq, 'wait', t.accountId, 0, null, extra.waiting, null]);
  if (extra.unsorted)
    out.push([key, 'unsorted', m, t.date, t.seq, 'unsorted', t.accountId, 0, null, extra.unsorted, null]);
  if (extra.uncategorized)
    out.push([key, 'uncat', m, t.date, t.seq, 'uncat', t.accountId, 0, null, extra.uncategorized, null]);
  return out;
}

/**
 * Rebuilds budget lines for the given transactions and returns the statements to run (in the caller's batch, after
 * its own writes): delete the old lines, insert the new ones, and mark the budget dirty from the earliest month
 * either touches. Reads happen first (old lines' months, the transactions).
 */
export async function planLineRebuild(
  s: Scoped,
  keys: readonly string[],
  meta: BudgetMeta,
  today: IsoDate,
  now: number,
  /** Pending edits not yet written, applied on top of what's stored (the caller writes them in the same batch). */
  override?: (t: LogicalTxn) => LogicalTxn | null,
): Promise<{ stmts: Stmt[]; dirtyFrom: Month | null }> {
  if (keys.length === 0) return { stmts: [], dirtyFrom: null };
  const keyChunks = chunks(keys);
  const [accts, ...oldMonths] = await s.batch([
    s.q(`SELECT id, kind FROM account WHERE budget_id = ?1`),
    ...keyChunks.map((k) =>
      s.q(
        `SELECT min(month) AS m FROM budget_line WHERE budget_id = ?1 AND txn_key IN (${inList(k, 2)})`,
        ...k,
      ),
    ),
  ]);
  const kinds = new Map((accts!.results as { id: string; kind: AccountKind }[]).map((a) => [a.id, a.kind]));
  const accountRows = await s.all<AccountRowDb>(`SELECT * FROM account WHERE budget_id = ?1`);
  const acctMap = new Map(accountRows.map((a) => [a.id, toLedgerAccount(a)]));
  const loaded = await loadTxns(s, keys);
  let dirty: string | null = null;
  for (const r of oldMonths) {
    const m = (r.results[0] as { m: string | null } | undefined)?.m ?? null;
    if (m && (!dirty || m < dirty)) dirty = m;
  }
  const stmts: Stmt[] = keyChunks.map((k) =>
    s.q(`DELETE FROM budget_line WHERE budget_id = ?1 AND txn_key IN (${inList(k, 2)})`, ...k),
  );
  const rows: LineRow[] = [];
  for (const key of keys) {
    let t = loaded.logical.get(key) ?? null;
    if (override && t) t = override(t);
    if (!t) continue;
    const acct = acctMap.get(t.accountId);
    if (!acct) continue;
    const e = linesForTxn(t, acct, kinds, meta.startMonth, today);
    if (!e.counts) continue;
    const r = rowsFor(key, e.lines, e, t);
    for (const x of r) if (!dirty || x[2] < dirty) dirty = x[2];
    rows.push(...r);
  }
  for (let i = 0; i < rows.length; i += 8) {
    const chunk = rows.slice(i, i + 8);
    stmts.push(
      s.q(
        `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref) VALUES ${chunk
          .map((_, j) => `(?1, ${Array.from({ length: 11 }, (_, k) => `?${2 + j * 11 + k}`).join(', ')})`)
          .join(', ')}`,
        ...chunk.flat(),
      ),
    );
  }
  if (dirty)
    stmts.push(
      markDirty(s.db, s.budgetId, (dirty < meta.startMonth ? meta.startMonth : dirty) as Month, now),
    );
  return { stmts, dirtyFrom: dirty as Month | null };
}

/** Starting-balance lines for one account (rule 8), rebuilt when the account or its starting balance changes. */
export function planStartLines(s: Scoped, a: LedgerAccount, meta: BudgetMeta, now: number): Stmt[] {
  const lines = startLines(a, meta.startMonth);
  const stmts = [s.q(`DELETE FROM budget_line WHERE budget_id = ?1 AND txn_key = ?2`, `start:${a.id}`)];
  for (const l of lines) {
    const isDebt = l.kind === 'debt';
    stmts.push(
      s.q(
        `INSERT INTO budget_line (budget_id, txn_key, line, month, date, seq, kind, account_id, card, category_id, amount, ref)
         VALUES (?1, ?2, 'start', ?3, ?4, -1, ?5, ?6, ?7, NULL, ?8, NULL)`,
        `start:${a.id}`,
        l.month,
        l.date,
        l.kind,
        a.id,
        isDebt ? 1 : 0,
        l.amount,
      ),
    );
  }
  stmts.push(markDirty(s.db, s.budgetId, lines[0]?.month ?? meta.startMonth, now));
  return stmts;
}
