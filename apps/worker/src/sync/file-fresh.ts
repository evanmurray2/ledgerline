// Step 6 of processing (process.ts planProcessing): for new rows without your categorization, the payee, transfers
// and transfers. No category is set. Payees follow docs/payee-names.md 4–6 (sync/payee-keys.ts).
import type { Stmt } from '@ledgerline/db/sql';
import { cents, detectTransfers, newPayeeName, payeeNameKey } from '@ledgerline/domain';
import { seededUlid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';
import { chunks, uncovered } from '../ledger/ledger.js';
import type { BankRow } from './process.js';
import { insertKey, loadOwners, payeeSource, rowKeys } from './payee-keys.js';

/** A posted row that took over another row's key in this batch (process.ts inherit), and that key. */
export interface Inherited {
  row: BankRow;
  key: string;
}

const inList = (n: number, from = 2) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

/**
 * The overlay writes (and new payees and keys) for live rows that no earlier step gave another row's key, and the
 * payees of rows that took over an overlay with none (an entry's).
 */
export async function planFresh(
  s: Scoped,
  fresh: BankRow[],
  now: number,
  inherited: readonly Inherited[] = [],
): Promise<Stmt[]> {
  const stmts: Stmt[] = [];
  // Rows are filed as they arrived.
  fresh = [...fresh].sort((a, b) => a.first_apply_seq - b.first_apply_seq);
  const overlayKeys = [
    ...new Set([
      ...fresh.map((r) => r.txn_key),
      ...inherited.flatMap((i) => [i.key, `p:${i.row.provider_txn_id}`]),
    ]),
  ];
  const keysOf = new Map<BankRow, string[]>();
  for (const r of [...fresh, ...inherited.map((i) => i.row)]) keysOf.set(r, rowKeys(r));
  const owners = await loadOwners(s, [...keysOf.values()].flat());
  const overlayChunks = await s.batch(
    chunks(overlayKeys).map((k) =>
      s.q(
        `SELECT txn_key, categorized_by, payee_id, transfer_state FROM txn_overlay WHERE +budget_id = ?1 AND txn_key IN (${inList(k.length)})`,
        ...k,
      ),
    ),
  );
  const overlay = new Map<
    string,
    { categorized_by: string | null; payee_id: string | null; transfer_state: string | null }
  >();
  for (const r of overlayChunks)
    for (const o of r.results as {
      txn_key: string;
      categorized_by: string | null;
      payee_id: string | null;
      transfer_state: string | null;
    }[])
      overlay.set(o.txn_key, o);
  const userSet = new Set(
    [...overlay.entries()].filter(([, o]) => o.categorized_by === 'user').map(([k]) => k),
  );

  // ---- Filing (4): a filed row keeps its payee; a new row goes to the first of its keys a payee has, else to a new
  // payee. Its keys no payee has go to its payee.
  const created = new Map<string, string>();
  /** The rows of this batch on each payee, for the name of a new payee (6). */
  const batchRows = new Map<string, { key: string; row: BankRow }[]>();
  const file = (r: BankRow, key: string, current: string | null | undefined): string => {
    const keys = keysOf.get(r)!;
    let payee = current ?? keys.map((k) => owners.get(k)).find((p) => p);
    if (!payee) {
      // Named from the row's first key and the update's time, never at random (docs/privacy.md 5.3: ids are an
      // input): a device that files the same update makes the same payee.
      payee = seededUlid(now, `payee:${keys[0] ?? r.provider_txn_id}`, 0);
      const name = newPayeeName(payeeSource(r));
      created.set(payee, name);
      // Sync chose its name (named_by 'sync', docs/payee-names.md 5).
      stmts.push(
        s.q(
          `INSERT INTO payee (id, budget_id, name, named_by, created_at, updated_at) VALUES (?2, ?1, ?3, 'sync', ?4, ?4)`,
          payee,
          name,
          now,
        ),
      );
    }
    for (const k of keys) {
      if (owners.has(k)) continue;
      owners.set(k, payee);
      stmts.push(insertKey(s, k, payee, now));
    }
    const l = batchRows.get(payee) ?? [];
    l.push({ key, row: r });
    batchRows.set(payee, l);
    return payee;
  };
  const payeeOf = new Map<string, string>();
  for (const r of fresh) {
    if (userSet.has(r.txn_key)) continue;
    payeeOf.set(r.txn_key, file(r, r.txn_key, overlay.get(r.txn_key)?.payee_id));
  }
  // A posted row that took over an overlay keeps that overlay's payee (or the one it had itself); one with neither,
  // like an entry's, is filed now.
  const userTaken = new Set<string>();
  for (const i of inherited) {
    const had = overlay.get(i.key)?.payee_id ?? overlay.get(`p:${i.row.provider_txn_id}`)?.payee_id;
    const payee = file(i.row, i.key, had);
    if (overlay.get(i.key)?.categorized_by === 'user') userTaken.add(payee);
    if (!had)
      stmts.push(
        s.q(
          `UPDATE txn_overlay SET payee_id = ?3, updated_at = ?4 WHERE budget_id = ?1 AND txn_key = ?2 AND payee_id IS NULL`,
          i.key,
          payee,
          now,
        ),
      );
  }
  stmts.push(...(await planNewNames(s, batchRows, created, userTaken, now)));

  // A row dated before the account's budget start (history, or part of the starting balance, D-67) is never budgeted,
  // so it gets no transfer state: nothing about it needs your attention. The date is the one
  // the budget uses: the authorized date for a card purchase (v_txn_bank).
  const budgetDate = (r: BankRow) =>
    r.account_kind === 'credit' && r.amount < 0 && r.authorized_date ? r.authorized_date : r.date;
  const isHistory = (r: BankRow) => r.budget_from !== null && budgetDate(r) < r.budget_from;
  // Transfers (D-90). The rows of this batch that can still pair: not history, not sorted by hand, and not already
  // a transfer (a row the bank sent again keeps what it has). A new row can also pair with an earlier row that has no
  // partner (`earlierOpen`), by the same rule.
  const open = fresh.filter(
    (r) =>
      !isHistory(r) &&
      !userSet.has(r.txn_key) &&
      [null, undefined, 'unsorted'].includes(overlay.get(r.txn_key)?.transfer_state),
  );
  const asRow = (
    r: { txn_key: string; account_id: string | null; amount: number; date: string } & NameOf,
  ) => ({
    key: r.txn_key,
    accountId: r.account_id!,
    amount: cents(r.amount),
    date: r.date,
    description: r.raw_name,
    providerCategory: r.provider_category,
  });
  const earlier = await earlierOpen(s, open);
  const accountOf = new Map<string, string>();
  for (const r of [...earlier, ...open]) accountOf.set(r.txn_key, r.account_id!);
  const freshKeys = new Set(fresh.map((r) => r.txn_key));
  const transfers = new Map<string, { other: string; state: 'paired' | 'unsorted' }>();
  for (const d of detectTransfers(open.map(asRow), new Set(), earlier.map(asRow))) {
    if (d.kind === 'paired') {
      transfers.set(d.outKey, { other: accountOf.get(d.inKey)!, state: 'paired' });
      transfers.set(d.inKey, { other: accountOf.get(d.outKey)!, state: 'paired' });
    } else {
      transfers.set(d.outKey, { other: '', state: 'unsorted' });
      for (const c of d.candidates) transfers.set(c, { other: '', state: 'unsorted' });
    }
  }
  // An earlier row this batch gave a partner, or a rival. It was filed before, so its overlay exists. A row the person
  // sorted by hand since the read is left alone.
  for (const [key, tr] of transfers) {
    if (freshKeys.has(key)) continue;
    stmts.push(
      tr.state === 'paired'
        ? s.q(
            `UPDATE txn_overlay SET transfer_state = 'paired', transfer_account_id = ?3, categorized_by = 'auto', updated_at = ?4
             WHERE budget_id = ?1 AND txn_key = ?2 AND categorized_by IS NOT 'user'
               AND (transfer_state IS NULL OR transfer_state = 'unsorted')`,
            key,
            tr.other,
            now,
          )
        : s.q(
            `UPDATE txn_overlay SET transfer_state = 'unsorted', categorized_by = 'auto', updated_at = ?3
             WHERE budget_id = ?1 AND txn_key = ?2 AND categorized_by IS NOT 'user' AND transfer_state IS NULL`,
            key,
            now,
          ),
    );
  }
  for (const r of fresh) {
    if (userSet.has(r.txn_key)) continue;
    const payee = payeeOf.get(r.txn_key)!;
    const tr = transfers.get(r.txn_key);
    const pendingAtLink = r.pending === 1 && isHistory(r) ? 1 : 0;
    stmts.push(
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, payee_id, category_id, memo, budget_month, transfer_state, transfer_account_id,
           wtm_state, categorized_by, rule_id, pending_at_link, created_at, updated_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT (txn_key) DO UPDATE SET
           payee_id = coalesce(txn_overlay.payee_id, excluded.payee_id),
           category_id = CASE WHEN txn_overlay.categorized_by = 'user' THEN txn_overlay.category_id ELSE coalesce(excluded.category_id, txn_overlay.category_id) END,
           memo = coalesce(txn_overlay.memo, excluded.memo),
           budget_month = coalesce(txn_overlay.budget_month, excluded.budget_month),
           -- A row that was asked about ('unsorted') becomes paired when its partner arrives; any other state stays.
           transfer_state = CASE WHEN excluded.transfer_state = 'paired' AND txn_overlay.transfer_state IS 'unsorted' THEN 'paired'
             ELSE coalesce(txn_overlay.transfer_state, excluded.transfer_state) END,
           transfer_account_id = CASE WHEN excluded.transfer_state = 'paired' AND txn_overlay.transfer_state IS 'unsorted' THEN excluded.transfer_account_id
             ELSE coalesce(txn_overlay.transfer_account_id, excluded.transfer_account_id) END,
           categorized_by = CASE WHEN txn_overlay.categorized_by = 'user' THEN 'user' ELSE coalesce(excluded.categorized_by, txn_overlay.categorized_by) END,
           rule_id = CASE WHEN txn_overlay.categorized_by = 'user' THEN txn_overlay.rule_id ELSE coalesce(excluded.rule_id, txn_overlay.rule_id) END,
           pending_at_link = max(txn_overlay.pending_at_link, excluded.pending_at_link),
           updated_at = excluded.updated_at`,
        r.txn_key,
        payee,
        null,
        null,
        null,
        tr ? tr.state : null,
        tr ? tr.other || null : null,
        null,
        tr ? 'auto' : null,
        null,
        pendingAtLink,
        now,
      ),
    );
  }
  return stmts;
}

type NameOf = { raw_name: string; provider_category: string | null };

/**
 * The rows filed before this batch that a row of it could pair with (D-90): another row of the same amount, with the
 * other sign, dated within 5 days, that has no partner and that the person has not sorted by hand. Only rows the
 * budget counts: not removed, not a pending row a posted row or an entry stands for, not history. The dates and
 * amounts are the bank's own (`posted_date`, `bank_amount`), as for the rows of the batch.
 */
async function earlierOpen(
  s: Scoped,
  open: readonly BankRow[],
): Promise<({ txn_key: string; account_id: string; amount: number; date: string } & NameOf)[]> {
  if (open.length === 0) return [];
  const amounts = [...new Set(open.map((r) => -r.amount))];
  const dates = open.map((r) => r.date).sort();
  const keys = open.map((r) => r.txn_key);
  const out: ({ txn_key: string; account_id: string; amount: number; date: string } & NameOf)[] = [];
  const seen = new Set(keys);
  // Bound parameters: ?1 the budget, ?2 and ?3 the dates, then the amounts.
  for (const part of chunks(amounts, 80)) {
    const r = await s.all<{ txn_key: string; account_id: string; amount: number; date: string } & NameOf>(
      `SELECT v.key AS txn_key, v.account_id, v.bank_amount AS amount, v.posted_date AS date, v.raw_name, v.provider_category
       FROM v_txn_bank v
       WHERE v.budget_id = ?1 AND v.posted_date BETWEEN date(?2, '-5 days') AND date(?3, '+5 days')
         AND v.bank_amount IN (${inList(part.length, 4)})
         AND (v.transfer_state IS NULL OR v.transfer_state = 'unsorted')
         AND v.categorized_by IS NOT 'user' AND v.category_id IS NULL AND coalesce(v.to_rta, 0) = 0
         AND v.wtm_state IS NULL
         AND (v.budget_from IS NULL OR v.date >= v.budget_from)
         AND ${uncovered('v')}`,
      dates[0]!,
      dates.at(-1)!,
      ...part,
    );
    for (const row of r)
      if (!seen.has(row.txn_key)) {
        seen.add(row.txn_key);
        out.push(row);
      }
  }
  return out;
}

/**
 * While a payee is new (sync named it and none of its transactions has your category), its name is the name (5) of
 * the row that made it, as Plaid sends that row now (docs/payee-names.md 6). The row that made it is the payee's
 * earliest transaction (date, then arrival): the first row filed into it, both live and in the re-file job, which
 * files in date order. The name never becomes another payee's name. Only a batch row whose name differs from its
 * payee's is looked at further, so a batch that changes no name reads only its payees' rows.
 */
async function planNewNames(
  s: Scoped,
  batchRows: Map<string, { key: string; row: BankRow }[]>,
  created: Map<string, string>,
  userTaken: Set<string>,
  now: number,
): Promise<Stmt[]> {
  // Each payee's earliest row in this batch (a posted row that took over a key stands for that key).
  const firstIn = new Map<string, { key: string; row: BankRow }>();
  const before = (a: { key: string; row: BankRow }, b: { key: string; row: BankRow }) =>
    a.row.date < b.row.date ||
    (a.row.date === b.row.date &&
      (a.row.first_apply_seq < b.row.first_apply_seq ||
        (a.row.first_apply_seq === b.row.first_apply_seq && !a.row.pending && !!b.row.pending)));
  for (const [id, rows] of batchRows) {
    if (userTaken.has(id)) continue;
    for (const r of rows) {
      const had = firstIn.get(id);
      if (!had || before(r, had)) firstIn.set(id, r);
    }
  }
  const names = new Map(created);
  const existing = [...firstIn.keys()].filter((id) => !created.has(id));
  const isSync = new Set(created.keys());
  for (const k of chunks(existing))
    for (const p of await s.all<{ id: string; name: string; named_by: string; merged_into: string | null }>(
      `SELECT id, name, named_by, merged_into FROM payee WHERE +budget_id = ?1 AND id IN (${inList(k.length)})`,
      ...k,
    )) {
      names.set(p.id, p.name);
      if (p.named_by === 'sync' && !p.merged_into) isSync.add(p.id);
    }
  const want = new Map<string, string>();
  for (const [id, f] of firstIn) {
    if (!isSync.has(id)) continue;
    const n = newPayeeName(payeeSource(f.row));
    if (n !== names.get(id)) want.set(id, n);
  }
  if (!want.size) return [];
  // Still new, and that row is its earliest transaction: no row filed before has your category or comes first.
  const look = [...want.keys()];
  const stays = new Set<string>();
  for (const k of chunks(
    look.filter((id) => !created.has(id)),
    30,
  )) {
    const checks = k.map((id) => {
      const f = firstIn.get(id)!;
      return s.q(
        `SELECT ?2 AS id WHERE EXISTS (SELECT 1 FROM txn_overlay o WHERE o.budget_id = ?1 AND o.payee_id = ?2 AND o.categorized_by = 'user')
           OR EXISTS (SELECT 1 FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key
             WHERE o.budget_id = ?1 AND o.payee_id = ?2 AND o.txn_key != ?3
               AND (b.date < ?4 OR (b.date = ?4 AND b.first_apply_seq < ?5)))`,
        id,
        f.key,
        f.row.date,
        f.row.first_apply_seq,
      );
    });
    for (const r of await s.batch(checks)) for (const x of r.results as { id: string }[]) stays.add(x.id);
  }
  const out: Stmt[] = [];
  let taken: Map<string, string> | null = null;
  for (const id of look) {
    if (stays.has(id)) continue;
    const name = want.get(id)!;
    if (!taken) {
      taken = new Map<string, string>();
      for (const p of await s.all<{ id: string; name: string }>(
        `SELECT id, name FROM payee WHERE budget_id = ?1 AND merged_into IS NULL`,
      ))
        taken.set(payeeNameKey(p.name), p.id);
      for (const [pid, n] of names) taken.set(payeeNameKey(n), pid);
    }
    const holder = taken.get(payeeNameKey(name));
    if (holder && holder !== id) continue;
    const was = payeeNameKey(names.get(id) ?? '');
    if (taken.get(was) === id) taken.delete(was);
    taken.set(payeeNameKey(name), id);
    names.set(id, name);
    out.push(
      s.q(
        `UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2 AND named_by = 'sync'`,
        id,
        name,
        now,
      ),
    );
  }
  return out;
}
