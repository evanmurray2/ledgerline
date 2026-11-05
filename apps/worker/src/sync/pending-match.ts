// Processing steps 1–4 (process.ts planProcessing), in the batch order of docs/payee-names.md 9.2: (1) the provider's
// link; (2) posted rows and bank pending rows without a link (D-47, 9.3); (3) posted rows and your entries; (4) new
// bank pending rows and your entries (a cover). Each step skips rows an earlier step claimed in the same batch, and a
// posted row tries bank pending rows before entries, so a leftover entry never takes a charge whose pending row still
// counts. A posted row that claims a covered pending row takes the covering entry's key, as if it had paired with the
// entry. Without the provider's link, rows pair only on exact evidence (Plaid's merchant id or names, or the same
// amount on the same day); otherwise "Same purchase?" asks (9.1). No bank text is compared.
import type { Stmt } from '@ledgerline/db/sql';
import {
  type BankPendingRow,
  type BankSideRow,
  type EntryRow,
  type IsoDate,
  type Merchant,
  type UnlinkedPostedRow,
  addDays,
  cents,
  pairBankPending,
  pairEntries,
  type MatchRow,
} from '@ledgerline/domain';
import { ulid } from '@ledgerline/platform';
import type { Scoped } from '../db/scoped.js';
import { chunks } from '../ledger/ledger.js';
import type { Inherited } from './file-fresh.js';
import type { BankRow } from './process.js';
import {
  askStmt,
  coverStmts,
  inheritStmts,
  loadNotSame,
  matchEntryStmts,
  ownKeyStmt,
  type Entry,
} from './pairing.js';

export function channel(r: { payment_channel: string | null; raw_name: string }): MatchRow['channel'] {
  if (/\bCHECK\b|\bCHK\b/i.test(r.raw_name)) return 'check';
  if (r.payment_channel === 'online' && /\bACH\b/i.test(r.raw_name)) return 'ach';
  return r.payment_channel === 'in store' || r.payment_channel === 'online' ? 'card' : 'other';
}

/** A bank row's Plaid fields the matcher compares (sameMerchant). */
export function merchantOf(r: {
  merchant_entity_id: string | null;
  merchant_name: string | null;
  plaid_name: string | null;
}): Merchant {
  return { merchantEntityId: r.merchant_entity_id, merchantName: r.merchant_name, plaidName: r.plaid_name };
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
  /** This batch's posted rows that took over another row's key, with that key (step 6 files those without a payee). */
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

/** An entry you added (Add pending, or an Upcoming row), unmatched, with what pairing needs. */
interface EntryDb extends Entry {
  account_id: string;
  date: string;
  payee_name: string;
  /** Its cover is still in force: the bank row it covers is listed and no posted row has claimed it. */
  covering: number;
}

/** A bank row's Plaid names as sent (docs/payee-names.md 9): `merchant_name` and `name`, else the bank text. */
function plaidNames(r: {
  merchant_name?: string | null;
  plaid_name?: string | null;
  raw_name: string;
}): string[] {
  const n = [r.merchant_name, r.plaid_name].filter((x): x is string => !!x && x.trim() !== '');
  return n.length ? n : [r.raw_name];
}

const entryRow = (m: EntryDb): EntryRow => ({
  key: m.txn_key,
  accountId: m.account_id,
  amount: cents(m.amount),
  date: m.date,
  name: m.payee_name,
  channel: /check/i.test(m.payee_name) ? 'check' : 'card',
});

/** Steps 1–4: appends the writes to `stmts`; returns what later steps need to know. */
export async function planMatches(
  s: Scoped,
  rows: BankRow[],
  live: BankRow[],
  today: IsoDate,
  now: number,
  stmts: Stmt[],
): Promise<Matches> {
  const inherited = new Set<string>();
  const tookOver: Inherited[] = [];
  const claimed = new Set<string>();
  /** Entries paired with a posted row in this batch. */
  const usedEntries = new Set<string>();
  const inherit: Matches['inherit'] = (postedId, fromKey, by, postedAmount, expected) => {
    stmts.push(...inheritStmts(s, postedId, fromKey, by, postedAmount, expected, now));
    took(postedId, fromKey);
  };
  const took = (postedId: string, key: string) => {
    inherited.add(postedId);
    claimed.add(key);
    const row = live.find((r) => r.provider_txn_id === postedId);
    if (row) tookOver.push({ row, key });
  };
  // Read once, and only when a pair could be made with an entry.
  let notSameP: ReturnType<typeof loadNotSame> | null = null;
  const notSameFor = () => (notSameP ??= loadNotSame(s));
  /** "Same purchase?" per bank row (its own key), written once at the end: steps 2 and 3 can ask about one row. */
  const asks = new Map<string, string[]>();
  const ask = (ref: string, candidates: string[]) =>
    asks.set(ref, [...new Set([...(asks.get(ref) ?? []), ...candidates])]);
  /** Posted rows step 2 left for you (asked, or ambiguous), with their pending candidates' keys. */
  const held = new Map<string, string[]>();
  /** The entry covering each pending row step 2 read (by the pending row's key). */
  const coveredBy = new Map<string, string>();
  const done = async (): Promise<Matches> => {
    // Only questions that changed: a sync (or the heal step) asking the same again writes nothing.
    const asked = new Map<string, string | null>();
    for (const k of chunks([...asks.keys()]))
      for (const a of await s.all<{ ref_key: string; data: string | null }>(
        `SELECT ref_key, data FROM alert WHERE budget_id = ?1 AND type = 'same_purchase'
           AND ref_key IN (${k.map((_, i) => `?${i + 2}`).join(',')})`,
        ...k,
      ))
        asked.set(a.ref_key, a.data);
    for (const [ref, c] of asks)
      if (asked.get(ref) !== JSON.stringify({ candidates: c })) stmts.push(askStmt(s, ref, c, now));
    return { inherited, tookOver, claimed, inherit };
  };
  /** A posted row takes your entry's key; the pending row the entry covers (`pendingKey`) is claimed with it. */
  const matchEntry = (
    postedId: string,
    postedAmount: number,
    e: Entry,
    by: 'auto' | 'user',
    pendingKey?: string,
  ) => {
    stmts.push(...matchEntryStmts(s, postedId, e, postedAmount, by, now));
    took(postedId, e.txn_key);
    usedEntries.add(e.txn_key);
    if (pendingKey) claimed.add(pendingKey);
  };
  /** The live entry covering each of these bank pending rows (by provider id), unless you said No to that pair. */
  const coverOf = async (pendingIds: string[]) => {
    const out = new Map<string, Entry>();
    for (const ids of chunks([...new Set(pendingIds)]))
      for (const m of await s.all<Entry>(
        `SELECT txn_key, amount, covers_provider_txn_id FROM manual_pending
         WHERE budget_id = ?1 AND deleted_at IS NULL AND matched_txn_key IS NULL
           AND covers_provider_txn_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
        ...ids,
      ))
        out.set(m.covers_provider_txn_id!, m);
    return out;
  };

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
  const linkCovers = pendingIds.length ? await coverOf(pendingIds) : new Map<string, Entry>();
  // The provider's link wins over a pair made without it: a posted row that claimed this pending row without the link
  // gets its own key back (and is matched again on its own).
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
    // Your entry covers the pending row: the posted row takes the entry's key, and the pending row goes with it.
    const cover = linkCovers.get(r.pending_provider_txn_id);
    if (
      cover &&
      !usedEntries.has(cover.txn_key) &&
      !(await notSameFor())(`p:${r.provider_txn_id}`, cover.txn_key)
    ) {
      if (r.txn_key === cover.txn_key) continue;
      matchEntry(r.provider_txn_id, r.amount, cover, 'auto', p.txn_key);
      continue;
    }
    for (const other of holders.get(p.txn_key) ?? []) {
      if (other === r.provider_txn_id) continue;
      stmts.push(ownKeyStmt(s, other, now));
    }
    inherit(r.provider_txn_id, p.txn_key, 'provider', r.amount, p.estimated ?? p.amount);
  }

  // ---- 2. Bank pending rows a posted row came without a link to (D-47, 9.3). Some banks send no link and keep listing
  // the pending row for hours or days after it posts, and the removal can come before or after the posted row. So
  // every batch looks again at the touched accounts' recent unmatched posted rows and unclaimed pending rows (still
  // listed or removed): whichever order they came in, they pair as soon as both are here, and earlier misses heal.
  // They pair only on exact evidence; a posted row with candidates but none with exact evidence is asked about.
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
    const COLS = `b.provider_txn_id, b.txn_key, a.id AS account_id, b.amount, b.date, b.authorized_date, b.raw_name, b.payment_channel,
         b.merchant_entity_id, b.merchant_name, b.plaid_name`;
    const POSTED = `SELECT ${COLS}
         FROM bank_txn b JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
         WHERE b.budget_id = ?1 AND b.pending = 0 AND b.removed_at IS NULL AND b.txn_key = 'p:' || b.provider_txn_id`;
    const [postedOld, pendingC, ...postedNew] = await s.batch([
      s.q(
        `${POSTED} AND b.date >= ?2 AND a.id IN (${pendAccts.map((_, i) => `?${i + 3}`).join(',') || "''"})`,
        since,
        ...pendAccts,
      ),
      s.q(
        `SELECT ${COLS},
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
      merchant_entity_id: string | null;
      merchant_name: string | null;
      plaid_name: string | null;
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
      const covers = await coverOf(pendingRows.map((r) => r.provider_txn_id));
      for (const r of pendingRows) {
        const c = covers.get(r.provider_txn_id);
        if (c) coveredBy.set(r.txn_key, c.txn_key);
      }
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
          // A covered row carries its entry: two rows covered by different entries are not interchangeable.
          ...(covers.has(r.provider_txn_id) ? { v: covers.get(r.provider_txn_id)!.txn_key } : {}),
        };
        return Object.keys(e).length ? JSON.stringify(e) : '';
      };
      const pend: BankPendingRow[] = pendingRows.map((r) => ({
        key: r.txn_key,
        accountId: r.account_id,
        amount: cents(r.amount),
        date: r.date,
        authorizedDate: r.authorized_date,
        ...merchantOf(r),
        channel: channel(r),
        edits: edits(r),
      }));
      const post: UnlinkedPostedRow[] = postedRows.map((r) => ({
        key: r.provider_txn_id,
        accountId: r.account_id,
        amount: cents(r.amount),
        date: r.date,
        authorizedDate: r.authorized_date,
        ...merchantOf(r),
        channel: channel(r),
      }));
      // A pending row your entry covers is hidden: you're asked about the entry instead, and No to the entry counts.
      const notSame = await notSameFor();
      const no = (q: string, p: string) =>
        notSame(`p:${q}`, p) || (coveredBy.has(p) && notSame(`p:${q}`, coveredBy.get(p)!));
      for (const d of pairBankPending(post, pend, no)) {
        if (d.kind === 'claim') {
          const q = postedRows.find((x) => x.provider_txn_id === d.postedKey)!;
          const p = pendingRows.find((x) => x.txn_key === d.pendingKey)!;
          const cover = covers.get(p.provider_txn_id);
          if (
            cover &&
            !usedEntries.has(cover.txn_key) &&
            !(await notSameFor())(`p:${q.provider_txn_id}`, cover.txn_key)
          )
            matchEntry(q.provider_txn_id, q.amount, cover, 'auto', p.txn_key);
          else inherit(q.provider_txn_id, p.txn_key, 'auto', q.amount, p.estimated_amount ?? p.amount);
        } else {
          held.set(d.postedKey, d.candidates);
          const candidates = [...new Set(d.candidates.map((k) => coveredBy.get(k) ?? k))];
          if (d.kind === 'ask') ask(`p:${d.postedKey}`, candidates);
          else stmts.push(alert(s, 'ambiguous_match', `p:${d.postedKey}`, { candidates }, now));
        }
      }
    }
  }

  // Your entries on the accounts this batch touches, for steps 3 and 4.
  const unlinkedPosted = live.filter(
    (r) => !r.pending && !inherited.has(r.provider_txn_id) && r.txn_key === `p:${r.provider_txn_id}`,
  );
  const newPending = live.filter((r) => r.pending && !claimed.has(r.txn_key));
  if (!unlinkedPosted.length && !newPending.length) return done();
  const entryAccts = [...new Set([...unlinkedPosted, ...newPending].map((r) => r.account_id!))];
  const entries = await s.all<EntryDb>(
    `SELECT m.txn_key, m.account_id, m.amount, m.date, m.payee_name, m.covers_provider_txn_id,
       EXISTS (SELECT 1 FROM bank_txn b WHERE b.budget_id = m.budget_id AND b.provider_txn_id = m.covers_provider_txn_id
         AND b.pending = 1 AND b.removed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)) AS covering
     FROM manual_pending m
     WHERE m.budget_id = ?1 AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL AND m.kind IN ('pending', 'upcoming')
       AND m.account_id IN (${entryAccts.map((_, i) => `?${i + 2}`).join(',')})`,
    ...entryAccts,
  );

  // ---- 3. Posted rows and your entries: exact evidence only; otherwise "Same purchase?" (9.1, 9.3: no score).
  const openEntries = () => entries.filter((m) => !usedEntries.has(m.txn_key));
  if (unlinkedPosted.length && entries.length) {
    const bank: BankSideRow[] = unlinkedPosted.map((r) => ({
      key: `p:${r.provider_txn_id}`,
      accountId: r.account_id!,
      amount: cents(r.amount),
      date: r.date,
      authorizedDate: r.authorized_date,
      names: plaidNames(r),
      channel: channel(r),
    }));
    for (const d of pairEntries(bank, openEntries().map(entryRow), await notSameFor())) {
      const r = unlinkedPosted.find((x) => `p:${x.provider_txn_id}` === d.bankKey)!;
      // Step 2 left this posted row for you: it pairs with an entry only when every pending row it was asked about
      // is one that entry covers (claimed with it); otherwise the entry joins the question.
      const wait = held.get(r.provider_txn_id);
      if (d.kind === 'pair' && !wait?.some((k) => coveredBy.get(k) !== d.entryKey)) {
        const m = entries.find((x) => x.txn_key === d.entryKey)!;
        // The pending row it covers is claimed with it (unless it's gone or another posted row has it).
        matchEntry(r.provider_txn_id, r.amount, m, 'auto');
      } else ask(d.bankKey, d.kind === 'pair' ? [d.entryKey] : d.candidates);
    }
  }

  // ---- 4. New bank pending rows and your entries: an entry covers the bank's pending row on exact evidence (9.2).
  // Only rows still counting: not claimed by a posted row, not covered already; only entries not covering one.
  const free = openEntries().filter((m) => !m.covering);
  if (newPending.length && free.length) {
    const ids = newPending.map((r) => r.provider_txn_id);
    const taken = new Set<string>();
    for (const k of chunks(ids))
      for (const t of await s.all<{ provider_txn_id: string }>(
        `SELECT b.provider_txn_id FROM bank_txn b WHERE b.budget_id = ?1 AND b.provider_txn_id IN (${k.map((_, i) => `?${i + 2}`).join(',')})
           AND (EXISTS (SELECT 1 FROM bank_txn x WHERE x.txn_key = b.txn_key AND x.pending = 0 AND x.removed_at IS NULL)
             OR EXISTS (SELECT 1 FROM manual_pending m WHERE m.budget_id = b.budget_id AND m.covers_provider_txn_id = b.provider_txn_id
               AND m.deleted_at IS NULL AND m.matched_txn_key IS NULL))`,
        ...k,
      ))
        taken.add(t.provider_txn_id);
    const open = newPending.filter((r) => !taken.has(r.provider_txn_id));
    if (open.length) {
      const bank: BankSideRow[] = open.map((r) => ({
        key: `p:${r.provider_txn_id}`,
        accountId: r.account_id!,
        amount: cents(r.amount),
        date: r.date,
        authorizedDate: r.authorized_date,
        names: plaidNames(r),
        channel: channel(r),
      }));
      for (const d of pairEntries(bank, free.map(entryRow), await notSameFor())) {
        if (d.kind === 'pair') stmts.push(...coverStmts(s, d.entryKey, d.bankKey.slice(2), now));
        else ask(d.bankKey, d.candidates);
      }
    }
  }
  return done();
}
