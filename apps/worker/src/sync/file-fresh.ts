// Step 5 of processing (process.ts planProcessing): for new rows without your categorization, the payee, transfers
// and Waiting to match. No category is set. Payees follow docs/payee-names.md 4–6 (sync/payee-keys.ts).
import type { Stmt } from '@ledgerline/db/sql';
import { cents, detectTransfers, newPayeeName, payeeNameKey } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';
import type { BankRow } from './process.js';
import { insertKey, loadOwners, payeeSource, rowKeys } from './payee-keys.js';

const P2P = /\b(ZELLE|VENMO|CASH APP|CASHAPP|PAYPAL TRANSFER|APPLE CASH)\b/i;

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
  const keysOf = new Map<BankRow, ReturnType<typeof rowKeys>>();
  for (const r of [...fresh, ...inherited.map((i) => i.row)]) keysOf.set(r, rowKeys(r));
  const allKeys = [...keysOf.values()];
  const owners = await loadOwners(
    s,
    allKeys.flatMap((k) => k.keys),
    allKeys.map((k) => k.legacy),
  );
  const overlayChunks = await s.batch(
    chunks(overlayKeys).map((k) =>
      s.q(
        `SELECT txn_key, categorized_by, payee_id FROM txn_overlay WHERE budget_id = ?1 AND txn_key IN (${inList(k.length)})`,
        ...k,
      ),
    ),
  );
  const overlay = new Map<string, { categorized_by: string | null; payee_id: string | null }>();
  for (const r of overlayChunks)
    for (const o of r.results as {
      txn_key: string;
      categorized_by: string | null;
      payee_id: string | null;
    }[])
      overlay.set(o.txn_key, o);
  const userSet = new Set(
    [...overlay.entries()].filter(([, o]) => o.categorized_by === 'user').map(([k]) => k),
  );

  // ---- Filing (4): a filed row keeps its payee; a new row goes to the first of its keys a payee has, else (the old
  // rules' cleaned text, a fallback until every payee has its keys) a new payee. Its keys no payee has go to its payee.
  const created = new Map<string, string>();
  /** The rows of this batch on each payee, for the name of a new payee (6). */
  const batchRows = new Map<string, { key: string; row: BankRow }[]>();
  const file = (r: BankRow, key: string, current: string | null | undefined): string => {
    const { keys, legacy } = keysOf.get(r)!;
    let payee = current ?? keys.map((k) => owners.keys.get(k)).find((p) => p) ?? owners.legacy.get(legacy);
    if (!payee) {
      payee = ulid(now);
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
      if (owners.keys.has(k)) continue;
      owners.keys.set(k, payee);
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

  // History (dated before the account's budget start, and not pending at link) is shown but never budgeted, so it
  // gets no transfer or Waiting-to-match state: nothing about it needs your attention.
  const isHistory = (r: BankRow) => r.budget_from !== null && r.date < r.budget_from && r.pending !== 1;
  const transfers = new Map<string, { other: string; state: 'paired' | 'unsorted' }>();
  for (const d of detectTransfers(
    fresh
      .filter((r) => !isHistory(r))
      .map((r) => ({
        key: r.txn_key,
        accountId: r.account_id!,
        amount: cents(r.amount),
        date: r.date,
        description: r.raw_name,
        providerCategory: r.provider_category,
      })),
  )) {
    if (d.kind === 'paired') {
      const o = fresh.find((r) => r.txn_key === d.outKey)!;
      const i = fresh.find((r) => r.txn_key === d.inKey)!;
      transfers.set(d.outKey, { other: i.account_id!, state: 'paired' });
      transfers.set(d.inKey, { other: o.account_id!, state: 'paired' });
    } else {
      transfers.set(d.outKey, { other: '', state: 'unsorted' });
      for (const c of d.candidates) transfers.set(c, { other: '', state: 'unsorted' });
    }
  }
  for (const r of fresh) {
    if (userSet.has(r.txn_key)) continue;
    const payee = payeeOf.get(r.txn_key)!;
    const tr = transfers.get(r.txn_key);
    const waiting = !tr && !isHistory(r) && r.amount > 0 && P2P.test(r.raw_name) ? 'waiting' : null;
    const pendingAtLink = r.pending === 1 && r.budget_from !== null && r.date < r.budget_from ? 1 : 0;
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
           transfer_state = coalesce(txn_overlay.transfer_state, excluded.transfer_state),
           transfer_account_id = coalesce(txn_overlay.transfer_account_id, excluded.transfer_account_id),
           wtm_state = coalesce(txn_overlay.wtm_state, excluded.wtm_state),
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
        waiting,
        tr ? 'auto' : null,
        null,
        pendingAtLink,
        now,
      ),
    );
  }
  return stmts;
}

/**
 * While a payee is new (sync named it and none of its transactions has your category), its name is the name (5) of
 * the row that made it, as Plaid sends that row now (docs/payee-names.md 6). The row that made it is the payee's
 * earliest transaction (date, then arrival): the first row filed into it, both live and in the re-file job, which
 * files in date order. The name never becomes another payee's name.
 */
async function planNewNames(
  s: Scoped,
  batchRows: Map<string, { key: string; row: BankRow }[]>,
  created: Map<string, string>,
  userTaken: Set<string>,
  now: number,
): Promise<Stmt[]> {
  const ids = [...batchRows.keys()].filter((id) => !userTaken.has(id));
  if (!ids.length) return [];
  const names = new Map(created);
  const candidates = new Set(created.keys());
  const existing = ids.filter((id) => !created.has(id));
  for (const k of chunks(existing)) {
    const [payees, user] = await s.batch([
      s.q(
        `SELECT id, name, named_by, merged_into FROM payee WHERE budget_id = ?1 AND id IN (${inList(k.length)})`,
        ...k,
      ),
      s.q(
        `SELECT DISTINCT payee_id FROM txn_overlay WHERE budget_id = ?1 AND categorized_by = 'user' AND payee_id IN (${inList(k.length)})`,
        ...k,
      ),
    ]);
    const mine = new Set((user!.results as { payee_id: string }[]).map((u) => u.payee_id));
    for (const p of payees!.results as {
      id: string;
      name: string;
      named_by: string;
      merged_into: string | null;
    }[]) {
      names.set(p.id, p.name);
      if (p.named_by === 'sync' && !p.merged_into && !mine.has(p.id)) candidates.add(p.id);
    }
  }
  const look = ids.filter((id) => candidates.has(id));
  if (!look.length) return [];
  // Each payee's earliest transaction: its rows already filed, and this batch's.
  type First = { key: string; date: string; seq: number };
  const first = new Map<string, First>();
  const earlier = (a: First, b: First | undefined) =>
    !b || a.date < b.date || (a.date === b.date && (a.seq < b.seq || (a.seq === b.seq && a.key < b.key)));
  const consider = (payee: string, f: First) => {
    if (earlier(f, first.get(payee))) first.set(payee, f);
  };
  for (const k of chunks(look.filter((id) => !created.has(id))))
    for (const r of await s.all<{ payee_id: string; txn_key: string; date: string; first_apply_seq: number }>(
      `SELECT o.payee_id, b.txn_key, b.date, b.first_apply_seq FROM txn_overlay o JOIN bank_txn b ON b.txn_key = o.txn_key
       WHERE o.budget_id = ?1 AND o.payee_id IN (${inList(k.length)})`,
      ...k,
    ))
      consider(r.payee_id, { key: r.txn_key, date: r.date, seq: r.first_apply_seq });
  for (const id of look)
    for (const b of batchRows.get(id)!)
      consider(id, { key: b.key, date: b.row.date, seq: b.row.first_apply_seq });
  const out: Stmt[] = [];
  let taken: Map<string, string> | null = null;
  for (const id of look) {
    const f = first.get(id);
    // The row that made it, as it came in this batch (a posted row that took over its key counts as that row).
    const rows = batchRows.get(id)!.filter((b) => b.key === f?.key);
    const row = rows.find((b) => !b.row.pending) ?? rows[0];
    if (!row) continue;
    const want = newPayeeName(payeeSource(row.row));
    if (want === names.get(id)) continue;
    if (!taken) {
      taken = new Map<string, string>();
      for (const p of await s.all<{ id: string; name: string }>(
        `SELECT id, name FROM payee WHERE budget_id = ?1 AND merged_into IS NULL`,
      ))
        taken.set(payeeNameKey(p.name), p.id);
      for (const [pid, n] of names) taken.set(payeeNameKey(n), pid);
    }
    const holder = taken.get(payeeNameKey(want));
    if (holder && holder !== id) continue;
    const was = payeeNameKey(names.get(id) ?? '');
    if (taken.get(was) === id) taken.delete(was);
    taken.set(payeeNameKey(want), id);
    names.set(id, want);
    out.push(
      s.q(
        `UPDATE payee SET name = ?3, updated_at = ?4 WHERE budget_id = ?1 AND id = ?2 AND named_by = 'sync'`,
        id,
        want,
        now,
      ),
    );
  }
  return out;
}
