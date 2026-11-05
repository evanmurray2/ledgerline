// Processing steps 1–3 (process.ts planProcessing): posted rows take over the key of the row they replace, by the
// provider's link, an entry you added, or a bank pending row without a link (D-47). Each pending row is claimed once.
import type { Stmt } from '@ledgerline/db/sql';
import {
  type BankPendingRow,
  type IsoDate,
  type UnlinkedPostedRow,
  addDays,
  cents,
  cleanDescription,
  matchPosted,
  pairBankPending,
  type MatchRow,
  type PostedRow,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';
import type { Inherited } from './file-fresh.js';
import type { BankRow } from './process.js';

export function channel(r: { payment_channel: string | null; raw_name: string }): MatchRow['channel'] {
  if (/\bCHECK\b|\bCHK\b/i.test(r.raw_name)) return 'check';
  if (r.payment_channel === 'online' && /\bACH\b/i.test(r.raw_name)) return 'ach';
  return r.payment_channel === 'in store' || r.payment_channel === 'online' ? 'card' : 'other';
}

export function alert(s: Scoped, type: string, ref: string, data: unknown, now: number): Stmt {
  return s.q(
    `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6)
     ON CONFLICT (budget_id, type, ref_key) DO UPDATE SET data = excluded.data`,
    ulid(now),
    type,
    ref,
    JSON.stringify(data),
    now,
  );
}

export interface Matches {
  /** This batch's posted rows that took over another row's key. */
  inherited: Set<string>;
  /** This batch's posted rows that took over another row's key, with that key (step 5 files those without a payee). */
  tookOver: Inherited[];
  /** Pending keys claimed in this batch: each pending row is claimed once. */
  claimed: Set<string>;
  inherit: (
    postedId: string,
    fromKey: string,
    by: 'provider' | 'auto',
    postedAmount: number,
    expected: number | null,
  ) => void;
}

/** Steps 1–3: appends the writes to `stmts`; returns what later steps need to know. */
export async function planMatches(
  s: Scoped,
  rows: BankRow[],
  live: BankRow[],
  today: IsoDate,
  now: number,
  stmts: Stmt[],
): Promise<Matches> {
  // ---- 1. Provider link: a posted row naming its pending row inherits that row's txn_key (and so its overlay).
  const pendingIds = live
    .filter((r) => !r.pending && r.pending_provider_txn_id)
    .map((r) => r.pending_provider_txn_id!);
  const pendingByProvider = new Map<
    string,
    { txn_key: string; amount: number; estimated: number | null; wont: number }
  >();
  for (const ids of chunks(pendingIds)) {
    const p = await s.all<{
      provider_txn_id: string;
      txn_key: string;
      amount: number;
      estimated_amount: number | null;
      wont_clear: number | null;
    }>(
      `SELECT b.provider_txn_id, b.txn_key, b.amount, o.estimated_amount, o.wont_clear FROM bank_txn b LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
       WHERE b.budget_id = ?1 AND b.provider_txn_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
      ...ids,
    );
    for (const x of p)
      pendingByProvider.set(x.provider_txn_id, {
        txn_key: x.txn_key,
        amount: x.amount,
        estimated: x.estimated_amount,
        wont: x.wont_clear ?? 0,
      });
  }
  const inherited = new Set<string>();
  const tookOver: Inherited[] = [];
  const claimed = new Set<string>();
  const inherit = (
    postedId: string,
    fromKey: string,
    by: 'provider' | 'auto',
    postedAmount: number,
    expected: number | null,
  ) => {
    stmts.push(
      s.q(
        `UPDATE bank_txn SET txn_key = ?3, updated_at = ?4 WHERE budget_id = ?1 AND provider_txn_id = ?2`,
        postedId,
        fromKey,
        now,
      ),
    );
    // An edit made offline to the posted row's own key lands on the key it now has (docs/phone-budget.md section 12).
    stmts.push(
      s.db
        .prepare(`INSERT OR REPLACE INTO txn_key_move (old_key, new_key, at) VALUES (?1, ?2, ?3)`)
        .bind(`p:${postedId}`, fromKey, now),
    );
    inherited.add(postedId);
    claimed.add(fromKey);
    const row = live.find((r) => r.provider_txn_id === postedId);
    if (row) tookOver.push({ row, key: fromKey });
    // What you set on the posted row itself before it claimed the pending row (a category from a rule or the payee, a
    // memo) fills what the pending row leaves empty; a category you chose on the pending row always wins.
    stmts.push(
      s.q(
        `UPDATE txn_overlay SET
           category_id = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN category_id
             ELSE (SELECT o.category_id FROM txn_overlay o WHERE o.txn_key = ?3) END,
           categorized_by = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN categorized_by
             ELSE (SELECT o.categorized_by FROM txn_overlay o WHERE o.txn_key = ?3) END,
           rule_id = CASE WHEN categorized_by IS 'user' OR category_id IS NOT NULL THEN rule_id
             ELSE (SELECT o.rule_id FROM txn_overlay o WHERE o.txn_key = ?3) END,
           payee_id = coalesce((SELECT o.payee_id FROM txn_overlay o WHERE o.txn_key = ?3), payee_id),
           memo = coalesce(memo, (SELECT o.memo FROM txn_overlay o WHERE o.txn_key = ?3)),
           updated_at = ?4
         WHERE budget_id = ?1 AND txn_key = ?2 AND ?3 != ?2 AND EXISTS (SELECT 1 FROM txn_overlay o WHERE o.txn_key = ?3)`,
        fromKey,
        `p:${postedId}`,
        now,
      ),
    );
    const alerts: string[] = [];
    if (expected !== null && expected !== postedAmount)
      alerts.push(`amount_changed:${expected}:${postedAmount}`);
    // A posted charge always counts (design: the posted amount wins): won't clear is cleared on every match, whichever
    // rule made it, and flagged when it was set. The flag is read from the overlay itself, so no path can miss it.
    // A pending row removed earlier and claimed now is no longer orphaned.
    stmts.push(
      s.q(
        `INSERT INTO txn_overlay (txn_key, budget_id, alert, wont_clear, created_at, updated_at) VALUES (?2, ?1, ?3, 0, ?4, ?4)
         ON CONFLICT (txn_key) DO UPDATE SET
           alert = CASE WHEN txn_overlay.wont_clear = 1
             THEN json_insert(coalesce(excluded.alert, '[]'), '$[#]', 'cleared_despite_wont_clear')
             ELSE coalesce(excluded.alert, txn_overlay.alert) END,
           wont_clear = 0, estimated_amount = NULL, orphaned_at = NULL, updated_at = excluded.updated_at`,
        fromKey,
        alerts.length ? JSON.stringify(alerts) : null,
        now,
      ),
    );
    stmts.push(
      s.q(
        `INSERT INTO txn_link (id, budget_id, kind, from_key, to_key, created_by, created_at) VALUES (?2, ?1, 'pending_match', ?3, ?4, ?5, ?6)`,
        ulid(now),
        `p:${postedId}`,
        fromKey,
        by,
        now,
      ),
      s.q(
        `UPDATE alert SET acked_at = ?3 WHERE budget_id = ?1 AND type = 'vanished_pending' AND ref_key = ?2 AND acked_at IS NULL`,
        fromKey,
        now,
      ),
    );
  };
  // The provider's link wins over a look-alike: a posted row that claimed this pending row by likeness gets its own
  // key back (and is matched again on its own).
  const linkTargets = live
    .filter((r) => !r.pending && r.pending_provider_txn_id)
    .map((r) => pendingByProvider.get(r.pending_provider_txn_id!)?.txn_key)
    .filter((k): k is string => !!k);
  const holders = new Map<string, string[]>();
  for (const k of chunks([...new Set(linkTargets)])) {
    for (const h of await s.all<{ provider_txn_id: string; txn_key: string }>(
      `SELECT provider_txn_id, txn_key FROM bank_txn WHERE budget_id = ?1 AND pending = 0 AND removed_at IS NULL
         AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
      ...k,
    ))
      holders.set(h.txn_key, [...(holders.get(h.txn_key) ?? []), h.provider_txn_id]);
  }
  for (const r of live) {
    if (r.pending || !r.pending_provider_txn_id) continue;
    const p = pendingByProvider.get(r.pending_provider_txn_id);
    if (!p || p.txn_key === r.txn_key || claimed.has(p.txn_key)) continue;
    for (const other of holders.get(p.txn_key) ?? []) {
      if (other === r.provider_txn_id) continue;
      stmts.push(
        s.q(
          `UPDATE bank_txn SET txn_key = 'p:' || provider_txn_id, updated_at = ?3 WHERE budget_id = ?1 AND provider_txn_id = ?2`,
          other,
          now,
        ),
      );
    }
    inherit(r.provider_txn_id, p.txn_key, 'provider', r.amount, p.estimated ?? p.amount);
  }

  // ---- 2. Manual pending: same account, unmatched, dated 0–14 days before, within tolerance; unique best only.
  const unlinkedPosted = live.filter(
    (r) => !r.pending && !inherited.has(r.provider_txn_id) && r.txn_key === `p:${r.provider_txn_id}`,
  );
  if (unlinkedPosted.length) {
    const accts = [...new Set(unlinkedPosted.map((r) => r.account_id!))];
    const manual = await s.all<{
      txn_key: string;
      account_id: string;
      amount: number;
      date: string;
      payee_name: string;
    }>(
      `SELECT txn_key, account_id, amount, date, payee_name FROM manual_pending
       WHERE budget_id = ?1 AND deleted_at IS NULL AND matched_txn_key IS NULL AND kind IN ('pending', 'upcoming')
         AND account_id IN (${accts.map((_, i) => `?${i + 2}`).join(',')})`,
      ...accts,
    );
    const posted: PostedRow[] = unlinkedPosted.map((r) => ({
      key: r.provider_txn_id,
      accountId: r.account_id!,
      amount: cents(r.amount),
      date: r.date,
      payee: r.merchant_name ?? cleanDescription(r.raw_name),
      channel: channel(r),
      providerTxnId: r.provider_txn_id,
      pendingProviderTxnId: null,
    }));
    const cands: MatchRow[] = manual.map((m) => ({
      key: m.txn_key,
      accountId: m.account_id,
      amount: cents(m.amount),
      date: m.date,
      payee: m.payee_name,
      channel: /check/i.test(m.payee_name) ? 'check' : 'card',
    }));
    for (const d of matchPosted(posted, cands, new Map())) {
      if (d.kind === 'inherit') {
        const r = unlinkedPosted.find((x) => x.provider_txn_id === d.postedKey)!;
        const m = manual.find((x) => x.txn_key === d.fromKey)!;
        inherit(r.provider_txn_id, m.txn_key, 'auto', r.amount, m.amount);
        stmts.push(
          s.q(
            `UPDATE manual_pending SET matched_txn_key = ?2, matched_by = 'auto', updated_at = ?3 WHERE budget_id = ?1 AND txn_key = ?2`,
            m.txn_key,
            now,
          ),
        );
      } else if (d.kind === 'ambiguous') {
        stmts.push(alert(s, 'ambiguous_match', `p:${d.postedKey}`, { candidates: d.candidates }, now));
      }
    }
  }

  // ---- 3. Bank pending rows a posted row came without a link to (D-47). Some banks send no link and keep listing the
  // pending row for hours or days after it posts, and the removal can come before or after the posted row. So every
  // batch looks again at the touched accounts' recent unmatched posted rows and unclaimed pending rows (still listed or
  // removed): whichever order they came in, they pair as soon as both are here, and earlier misses heal.
  // To stay inside the CPU budget, older posted rows are read only for accounts where this batch brings a pending row
  // (new, changed or removed); otherwise only this batch's own posted rows look for a pending row.
  const accts = [...new Set(rows.filter((r) => r.account_id).map((r) => r.account_id!))];
  const pendAccts = [...new Set(rows.filter((r) => r.account_id && r.pending).map((r) => r.account_id!))];
  const batchPosted = live
    .filter((r) => !r.pending && !inherited.has(r.provider_txn_id) && r.txn_key === `p:${r.provider_txn_id}`)
    .map((r) => r.provider_txn_id);
  const earliest0 = rows.reduce<string>((m, r) => (r.date < m ? r.date : m), today);
  const since = addDays(earliest0 < today ? earliest0 : today, -30);
  if (accts.length && (pendAccts.length || batchPosted.length)) {
    const inAccts = accts.map((_, i) => `?${i + 3}`).join(',');
    const POSTED = `SELECT b.provider_txn_id, b.txn_key, a.id AS account_id, b.amount, b.date, b.authorized_date, b.raw_name, b.payment_channel
         FROM bank_txn b JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
         WHERE b.budget_id = ?1 AND b.pending = 0 AND b.removed_at IS NULL AND b.txn_key = 'p:' || b.provider_txn_id`;
    const [postedOld, pendingC, ...postedNew] = await s.batch([
      s.q(
        `${POSTED} AND b.date >= ?2 AND a.id IN (${pendAccts.map((_, i) => `?${i + 3}`).join(',') || "''"})`,
        since,
        ...pendAccts,
      ),
      s.q(
        `SELECT b.provider_txn_id, b.txn_key, a.id AS account_id, b.amount, b.date, b.authorized_date, b.raw_name, b.payment_channel,
           o.categorized_by, o.category_id, o.memo, o.estimated_amount, o.budget_month, o.to_rta, o.transfer_state,
           (SELECT count(*) FROM txn_split t WHERE t.txn_key = b.txn_key) AS splits
         FROM bank_txn b JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
         LEFT JOIN txn_overlay o ON o.txn_key = b.txn_key
         WHERE b.budget_id = ?1 AND b.pending = 1 AND b.date >= ?2 AND a.id IN (${inAccts})
           AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)`,
        addDays(since, -14),
        ...accts,
      ),
      ...chunks(batchPosted).map((k) =>
        s.q(`${POSTED} AND b.provider_txn_id IN (${k.map((_, i) => `?${i + 2}`).join(',')})`, ...k),
      ),
    ]);
    type Cand = {
      provider_txn_id: string;
      txn_key: string;
      account_id: string;
      amount: number;
      date: string;
      authorized_date: string | null;
      raw_name: string;
      payment_channel: string | null;
    };
    const seen = new Set<string>();
    const postedRows = [postedOld!, ...postedNew]
      .flatMap((r) => r.results as Cand[])
      .filter(
        (r) =>
          !inherited.has(r.provider_txn_id) && !seen.has(r.provider_txn_id) && seen.add(r.provider_txn_id),
      );
    const pendingRows = (
      pendingC!.results as (Cand & {
        categorized_by: string | null;
        category_id: string | null;
        memo: string | null;
        estimated_amount: number | null;
        budget_month: string | null;
        to_rta: number | null;
        transfer_state: string | null;
        splits: number;
      })[]
    ).filter((r) => !claimed.has(r.txn_key));
    if (postedRows.length && pendingRows.length) {
      const edits = (r: (typeof pendingRows)[number]) => {
        const e = {
          // A category you chose (cleared is not a choice), a transfer or Ready to Assign you set.
          ...(r.categorized_by === 'user' && r.category_id ? { c: r.category_id } : {}),
          ...(r.categorized_by === 'user' && r.transfer_state ? { t: r.transfer_state } : {}),
          ...(r.categorized_by === 'user' && r.to_rta ? { r: 1 } : {}),
          ...(r.memo ? { m: r.memo } : {}),
          ...(r.estimated_amount !== null ? { e: r.estimated_amount } : {}),
          ...(r.budget_month ? { b: r.budget_month } : {}),
          ...(r.splits ? { s: r.txn_key } : {}),
        };
        return Object.keys(e).length ? JSON.stringify(e) : '';
      };
      const pend: BankPendingRow[] = pendingRows.map((r) => ({
        key: r.txn_key,
        accountId: r.account_id,
        amount: cents(r.amount),
        date: r.date,
        authorizedDate: r.authorized_date,
        payee: r.raw_name,
        channel: channel(r),
        edits: edits(r),
      }));
      const post: UnlinkedPostedRow[] = postedRows.map((r) => ({
        key: r.provider_txn_id,
        accountId: r.account_id,
        amount: cents(r.amount),
        date: r.date,
        authorizedDate: r.authorized_date,
        payee: r.raw_name,
        channel: channel(r),
      }));
      for (const d of pairBankPending(post, pend)) {
        if (d.kind === 'claim') {
          const q = postedRows.find((x) => x.provider_txn_id === d.postedKey)!;
          const p = pendingRows.find((x) => x.txn_key === d.pendingKey)!;
          inherit(q.provider_txn_id, p.txn_key, 'auto', q.amount, p.estimated_amount ?? p.amount);
        } else {
          stmts.push(alert(s, 'ambiguous_match', `p:${d.postedKey}`, { candidates: d.candidates }, now));
        }
      }
    }
  }
  return { inherited, tookOver, claimed, inherit };
}
