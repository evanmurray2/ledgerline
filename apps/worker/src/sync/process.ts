// Post-apply work driven by the watermark (Sync spec F3). Each step reads up to CHUNK.process events after
// budget.processed_through, decides matches, categorization, transfers and Waiting to match with the pure domain
// functions, and writes everything plus the new watermark in one batch behind a watermark fence. Reprocessing is
// harmless: rules never overwrite a user's categorization.
import {
  type BankPendingRow,
  type IsoDate,
  type Month,
  type UnlinkedPostedRow,
  addDays,
  type Rule,
  cents,
  cleanDescription,
  currentMonth,
  detectTransfers,
  evaluateRules,
  localDate,
  matchPosted,
  matchReissues,
  pairBankPending,
  payeeKey,
  titleCase,
  type MatchRow,
  type PostedRow,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Env } from '../env.js';
import { Scoped } from '../db/scoped.js';
import { conditionFence, isFenceAbort } from './lease.js';
import type { StepContext } from './steps.js';
import { CHUNK } from './steps.js';
import { budgetMeta, chunks } from '../ledger/ledger.js';
import { makeProvider, connectionToken } from './provider.js';

const MAX_WATERMARK_RETRIES = 3;
const P2P = /\b(ZELLE|VENMO|CASH APP|CASHAPP|PAYPAL TRANSFER|APPLE CASH)\b/i;

export interface ProcessResult {
  caughtUp: boolean;
  processed: number;
}

interface EventRow {
  id: number;
  kind: 'added' | 'modified' | 'removed';
  provider_txn_id: string;
}

interface BankRow {
  provider_txn_id: string;
  txn_key: string;
  account_id: string | null;
  account_kind: string | null;
  budget_from: string | null;
  amount: number;
  date: string;
  pending: number;
  pending_provider_txn_id: string | null;
  raw_name: string;
  merchant_name: string | null;
  merchant_entity_id: string | null;
  provider_category: string | null;
  payment_channel: string | null;
  removed_at: number | null;
  first_apply_seq: number;
  linked_at: number | null;
}

function channel(r: { payment_channel: string | null; raw_name: string }): MatchRow['channel'] {
  if (/\bCHECK\b|\bCHK\b/i.test(r.raw_name)) return 'check';
  if (r.payment_channel === 'online' && /\bACH\b/i.test(r.raw_name)) return 'ach';
  return r.payment_channel === 'in store' || r.payment_channel === 'online' ? 'card' : 'other';
}

export async function processPending(env: Env, budgetId: string, now = Date.now()): Promise<ProcessResult> {
  const s = new Scoped(env.DB, budgetId, 'system');
  for (let attempt = 0; attempt < MAX_WATERMARK_RETRIES; attempt++) {
    const b = await s.first<{
      processed_through: number;
      time_zone: string;
      budget_start_month: string | null;
    }>(`SELECT processed_through, time_zone, budget_start_month FROM budget WHERE id = ?1`);
    if (!b) return { caughtUp: true, processed: 0 };
    const expected = b.processed_through;
    const evs = await s.all<EventRow>(
      `SELECT id, kind, provider_txn_id FROM bank_event WHERE budget_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`,
      expected,
      CHUNK.process,
    );
    if (evs.length === 0) return { caughtUp: true, processed: 0 };
    const through = evs[evs.length - 1]!.id;
    const today = localDate(now, b.time_zone);
    const meta = await budgetMeta(s);
    const plan = meta ? await planProcessing(s, evs, today, now) : { stmts: [] };
    const fence = () =>
      conditionFence(env.DB, `SELECT processed_through = ?1 FROM budget WHERE id = ?2`, expected, budgetId);
    try {
      // 1. Matches, categorization and transfers (idempotent: reprocessing the same events writes the same rows).
      if (plan.stmts.length) await env.DB.batch([fence(), ...plan.stmts]);
      // 2. The new watermark, behind the same fence.
      await env.DB.batch([
        fence(),
        s.q(`UPDATE budget SET processed_through = ?2, updated_at = ?3 WHERE id = ?1`, through, now),
      ]);
      return { caughtUp: evs.length < CHUNK.process, processed: evs.length };
    } catch (e) {
      if (!isFenceAbort(e)) throw e;
      // Another processor moved the watermark first: re-read and continue.
    }
  }
  return { caughtUp: false, processed: 0 };
}

/**
 * After every sync of a connection, whether or not the bank sent anything: its accounts' pending rows that no posted
 * row has claimed are matched again (D-47 step 3), so a pairing missed earlier, or by an older release, heals on the
 * next sync instead of waiting for the bank to send news about that row. Behind the same watermark fence as
 * processing, so the two never claim a row twice; on a lost race it simply waits for the next sync.
 */
export async function healPending(
  env: Env,
  budgetId: string,
  connectionId: string,
  now = Date.now(),
): Promise<{ changed: boolean }> {
  const s = new Scoped(env.DB, budgetId, 'system');
  const b = await s.first<{ processed_through: number; time_zone: string }>(
    `SELECT processed_through, time_zone FROM budget WHERE id = ?1`,
  );
  const meta = b ? await budgetMeta(s) : null;
  if (!b || !meta) return { changed: false };
  const today = localDate(now, b.time_zone);
  const open = await s.all<{ provider_txn_id: string }>(
    `SELECT b.provider_txn_id FROM bank_txn b
     WHERE b.budget_id = ?1 AND b.connection_id = ?2 AND b.pending = 1 AND b.date >= ?3
       AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)
     ORDER BY b.date DESC LIMIT ?4`,
    connectionId,
    addDays(today, -44),
    CHUNK.process,
  );
  if (!open.length) return { changed: false };
  const evs: EventRow[] = open.map((r, i) => ({
    id: i,
    kind: 'modified',
    provider_txn_id: r.provider_txn_id,
  }));
  const plan = await planProcessing(s, evs, today, now, true);
  if (!plan.stmts.length) return { changed: false };
  const fence = () =>
    conditionFence(
      env.DB,
      `SELECT processed_through = ?1 FROM budget WHERE id = ?2`,
      b.processed_through,
      budgetId,
    );
  try {
    await env.DB.batch([fence(), ...plan.stmts]);
  } catch (e) {
    if (!isFenceAbort(e)) throw e;
    return { changed: false };
  }
  return { changed: true };
}

/** Decides what the new events mean and returns the overlay writes. */
async function planProcessing(
  s: Scoped,
  evs: EventRow[],
  today: IsoDate,
  now: number,
  /** Healing (healPending): only the matching steps, for rows nothing new arrived for. */
  matchOnly = false,
): Promise<{ stmts: D1PreparedStatement[] }> {
  const ids = [...new Set(evs.map((e) => e.provider_txn_id))];
  const ph = ids.map((_, i) => `?${i + 2}`).join(',');
  const rows: BankRow[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    rows.push(
      ...(await s.all<BankRow>(
        `SELECT b.provider_txn_id, b.txn_key, a.id AS account_id, a.kind AS account_kind, a.budget_from, b.amount, b.date, b.pending,
           b.pending_provider_txn_id, b.raw_name, b.merchant_name, b.merchant_entity_id, b.provider_category, b.payment_channel,
           b.removed_at, b.first_apply_seq, c.linked_at
         FROM bank_txn b
         LEFT JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
         LEFT JOIN connection c ON c.id = b.connection_id
         WHERE b.budget_id = ?1 AND b.provider_txn_id IN (${chunk.map((_, j) => `?${j + 2}`).join(',')})`,
        ...chunk,
      )),
    );
  }
  void ph;
  const stmts: D1PreparedStatement[] = [];
  const live = rows.filter((r) => r.removed_at === null && r.account_id);
  const removed = rows.filter((r) => r.removed_at !== null && r.account_id);

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
  /** Pending keys claimed in this batch: each pending row is claimed once. */
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

  if (matchOnly) return { stmts };

  // ---- 4. Re-issued posted rows, and removed pending rows nothing has claimed.
  const removedPosted = removed.filter((r) => !r.pending);
  const addedPosted = live.filter(
    (r) => !r.pending && !inherited.has(r.provider_txn_id) && r.txn_key === `p:${r.provider_txn_id}`,
  );
  const asRow = (r: BankRow): MatchRow => ({
    key: r.provider_txn_id,
    accountId: r.account_id!,
    amount: cents(r.amount),
    date: r.date,
    payee: r.merchant_name ?? r.raw_name,
    channel: channel(r),
  });
  for (const d of matchReissues(removedPosted.map(asRow), addedPosted.map(asRow))) {
    const old = removedPosted.find((r) => r.provider_txn_id === d.removedKey)!;
    if (d.kind === 'inherit') {
      const add = addedPosted.find((r) => r.provider_txn_id === d.addedKey)!;
      inherit(add.provider_txn_id, old.txn_key, 'auto', add.amount, null);
    } else stmts.push(alert(s, 'possible_reissue', old.txn_key, { added: d.addedKeys }, now));
    // A posted row in an earlier month that is removed or re-issued: History changed.
    const cm = currentMonth(now, 'America/Los_Angeles');
    if (old.date.slice(0, 7) < cm)
      stmts.push(
        alert(s, 'history_changed', old.txn_key, { month: old.date.slice(0, 7), amount: old.amount }, now),
      );
  }
  const removedPending = removed.filter((x) => x.pending && !claimed.has(x.txn_key));
  if (removedPending.length) {
    // Already claimed by a posted row (by the provider's link, or earlier by likeness): nothing to hold.
    const held = new Set<string>();
    for (const k of chunks(removedPending.map((r) => r.txn_key)))
      for (const h of await s.all<{ txn_key: string }>(
        `SELECT txn_key FROM bank_txn WHERE budget_id = ?1 AND pending = 0 AND removed_at IS NULL
           AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
        ...k,
      ))
        held.add(h.txn_key);
    for (const r of removedPending) {
      if (held.has(r.txn_key)) continue;
      // Removed with no posted successor yet: hold its edits (14 days) and flag a vanished pending after 5 days (daily
      // scan). A posted row that arrives later still claims it (step 3).
      stmts.push(
        s.q(
          `UPDATE txn_overlay SET orphaned_at = coalesce(orphaned_at, ?3) WHERE budget_id = ?1 AND txn_key = ?2`,
          r.txn_key,
          now,
        ),
      );
    }
  }

  // ---- 5. Categorization for rows without your categorization: payee, rules, payee default; transfers; Waiting to match.
  const fresh = live.filter((r) => !inherited.has(r.provider_txn_id));
  if (fresh.length) {
    const freshChunks = chunks(fresh.map((r) => r.txn_key));
    const [ruleRows, aliases, ...overlayChunks] = await s.batch([
      s.q(`SELECT * FROM rule WHERE budget_id = ?1 AND enabled = 1 ORDER BY sort`),
      s.q(
        `SELECT a.pattern, a.merchant_entity_id, p.id, p.name, p.remember_category, p.default_category_id FROM payee_alias a JOIN payee p ON p.id = a.payee_id WHERE a.budget_id = ?1`,
      ),
      ...freshChunks.map((k) =>
        s.q(
          `SELECT txn_key, categorized_by FROM txn_overlay WHERE budget_id = ?1 AND txn_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
          ...k,
        ),
      ),
    ]);
    const overlays = { results: overlayChunks.flatMap((r) => r.results) };
    const rules: Rule[] = (
      ruleRows!.results as {
        id: string;
        name: string;
        conditions: string;
        actions: string;
        apply_to_pending: number;
        stop_after: number;
        enabled: number;
      }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      conditions: JSON.parse(r.conditions),
      actions: JSON.parse(r.actions),
      applyToPending: r.apply_to_pending === 1,
      stopAfter: r.stop_after === 1,
      enabled: r.enabled === 1,
    }));
    const userSet = new Set(
      (overlays.results as { txn_key: string; categorized_by: string | null }[])
        .filter((o) => o.categorized_by === 'user')
        .map((o) => o.txn_key),
    );
    const byKey = new Map<string, { id: string; name: string; remember: number; def: string | null }>();
    for (const a of aliases!.results as {
      pattern: string | null;
      merchant_entity_id: string | null;
      id: string;
      name: string;
      remember_category: number;
      default_category_id: string | null;
    }[]) {
      const v = { id: a.id, name: a.name, remember: a.remember_category, def: a.default_category_id };
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
        payee = { id, name, remember: 0, def: null };
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
      const res = evaluateRules(
        {
          payeeId: payee.id,
          payeeName: payee.name,
          description: r.raw_name,
          accountId: r.account_id!,
          amount: cents(r.amount),
          date: r.date,
          pending: r.pending === 1,
          providerCategory: r.provider_category,
        },
        rules,
        payee.def ? { categoryId: payee.def, remember: payee.remember === 1 } : null,
      );
      const waiting =
        !tr && !isHistory(r) && r.amount > 0 && res.categoryId === undefined && P2P.test(r.raw_name)
          ? 'waiting'
          : null;
      const pendingAtLink = r.pending === 1 && r.budget_from !== null && r.date < r.budget_from ? 1 : 0;
      const by = res.by === 'payee' ? 'payee' : res.by ? 'rule' : null;
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
          tr ? null : (res.categoryId ?? null),
          res.memo ?? null,
          res.budgetMonth ?? null,
          tr ? tr.state : res.transferTo ? 'paired' : null,
          tr ? tr.other || null : (res.transferTo ?? null),
          waiting,
          tr ? 'auto' : by,
          res.by && res.by !== 'payee' ? res.by.ruleId : null,
          pendingAtLink,
          now,
        ),
      );
      if (res.split) {
        stmts.push(s.q(`DELETE FROM txn_split WHERE budget_id = ?1 AND txn_key = ?2`, r.txn_key));
        res.split.forEach((l, i) =>
          stmts.push(
            s.q(
              `INSERT INTO txn_split (id, budget_id, txn_key, category_id, amount, absorbs_remainder, sort, created_at) VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8)`,
              `${r.txn_key}:s${i}`,
              r.txn_key,
              l.categoryId,
              l.amount,
              l.absorbsRemainder ? 1 : 0,
              i,
              now,
            ),
          ),
        );
      }
      if (res.owed) {
        stmts.push(
          s.q(
            `INSERT OR IGNORE INTO expected_reimbursement (id, budget_id, txn_key, amount, fraction_num, fraction_den, expect_by, rule_id, created_at, updated_at)
             VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
            `${r.txn_key}:owed`,
            r.txn_key,
            res.owed.amount,
            res.owed.num ?? null,
            res.owed.den ?? null,
            res.owed.expectBy,
            res.by && res.by !== 'payee' ? res.by.ruleId : null,
            now,
          ),
        );
      }
    }
  }
  return { stmts };
}

function alert(s: Scoped, type: string, ref: string, data: unknown, now: number): D1PreparedStatement {
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

/** After the watermark catches up: refresh balances and card liabilities, mark the sync done. */
export async function finalizeConnection(env: Env, c: StepContext, runId: string): Promise<void> {
  const now = Date.now();
  try {
    const provider = makeProvider(env);
    const token = await connectionToken(env, c.connectionId);
    const conn = { id: c.connectionId, accessToken: token, providerItemId: null };
    const accounts = await provider.getAccounts(conn);
    const stmts: D1PreparedStatement[] = accounts.map((a) =>
      env.DB.prepare(
        `UPDATE provider_account SET current_balance = ?3, available_balance = ?4, credit_limit = ?5, balance_as_of = ?6, updated_at = ?6
         WHERE connection_id = ?1 AND provider_account_id = ?2`,
      ).bind(c.connectionId, a.providerAccountId, a.currentBalance, a.availableBalance, a.creditLimit, now),
    );
    if (provider.getLiabilities) {
      const liab = await provider.getLiabilities(conn).catch(() => []);
      for (const l of liab) {
        stmts.push(
          env.DB.prepare(
            // One snapshot per card per day: a later sync the same day replaces it (liability_day index).
            `INSERT INTO liability_snapshot (id, budget_id, provider_account_id, as_of, statement_balance, statement_date, due_date, minimum_payment, apr_bp, data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '{}', ?10)
             ON CONFLICT (budget_id, provider_account_id, as_of) DO UPDATE SET statement_balance = excluded.statement_balance,
               statement_date = excluded.statement_date, due_date = excluded.due_date, minimum_payment = excluded.minimum_payment,
               apr_bp = excluded.apr_bp, created_at = excluded.created_at`,
          ).bind(
            ulid(now),
            c.budgetId,
            l.providerAccountId,
            new Date(now).toISOString().slice(0, 10),
            l.statementBalance,
            l.statementDate,
            l.dueDate,
            l.minimumPayment,
            l.aprBasisPoints,
            now,
          ),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  } catch {
    // Balances refresh on the next sync; the transactions are already applied.
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE sync_run SET phase = 'done', finished_at = ?2, updated_at = ?2 WHERE id = ?1`,
    ).bind(runId, now),
    env.DB.prepare(`DELETE FROM sync_page WHERE sync_run_id = ?1`).bind(runId),
    env.DB.prepare(
      `UPDATE connection SET last_synced_at = ?2, last_attempt_at = ?2, error_code = NULL, status = 'ok' WHERE id = ?1`,
    ).bind(c.connectionId, now),
  ]);
}

export type { Month };
