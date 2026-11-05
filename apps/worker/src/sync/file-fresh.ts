// Step 5 of processing (process.ts planProcessing): for new rows without your categorization, the payee, transfers
// and Waiting to match. No category is set.
import type { Stmt } from '@ledgerline/db/sql';
import { cents, cleanDescription, detectTransfers, payeeKey, titleCase } from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';
import type { BankRow } from './process.js';

const P2P = /\b(ZELLE|VENMO|CASH APP|CASHAPP|PAYPAL TRANSFER|APPLE CASH)\b/i;

/** The overlay writes (and new payees) for live rows that no earlier step gave another row's key. */
export async function planFresh(s: Scoped, fresh: BankRow[], now: number): Promise<Stmt[]> {
  const stmts: Stmt[] = [];
  const freshChunks = chunks(fresh.map((r) => r.txn_key));
  const [aliases, ...overlayChunks] = await s.batch([
    s.q(
      `SELECT a.pattern, a.merchant_entity_id, p.id, p.name FROM payee_alias a JOIN payee p ON p.id = a.payee_id WHERE a.budget_id = ?1`,
    ),
    ...freshChunks.map((k) =>
      s.q(
        `SELECT txn_key, categorized_by FROM txn_overlay WHERE budget_id = ?1 AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
        ...k,
      ),
    ),
  ]);
  const overlays = { results: overlayChunks.flatMap((r) => r.results) };
  const userSet = new Set(
    (overlays.results as { txn_key: string; categorized_by: string | null }[])
      .filter((o) => o.categorized_by === 'user')
      .map((o) => o.txn_key),
  );
  const byKey = new Map<string, { id: string; name: string }>();
  for (const a of aliases!.results as {
    pattern: string | null;
    merchant_entity_id: string | null;
    id: string;
    name: string;
  }[]) {
    const v = { id: a.id, name: a.name };
    if (a.merchant_entity_id) byKey.set(`m:${a.merchant_entity_id}`, v);
    if (a.pattern) byKey.set(`d:${a.pattern}`, v);
  }
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
    const pk = payeeKey(r.raw_name, r.merchant_entity_id);
    let payee = byKey.get(pk) ?? byKey.get(`d:${cleanDescription(r.raw_name).replace(/\s/g, '')}`);
    if (!payee) {
      // First sight of this payee: create it and its alias, so later imports resolve through it.
      const id = ulid(now);
      const name = r.merchant_name ?? titleCase(cleanDescription(r.raw_name) || r.raw_name);
      payee = { id, name };
      byKey.set(pk, payee);
      stmts.push(
        s.q(
          `INSERT INTO payee (id, budget_id, name, created_at, updated_at) VALUES (?2, ?1, ?3, ?4, ?4)`,
          id,
          name,
          now,
        ),
        s.q(
          `INSERT INTO payee_alias (id, budget_id, pattern, merchant_entity_id, payee_id, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
          ulid(now),
          pk.startsWith('d:') ? pk.slice(2) : null,
          r.merchant_entity_id,
          id,
          now,
        ),
      );
    }
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
        payee.id,
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
