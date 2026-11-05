// Each linked account's bank link, and the role a row has toward its starting balance (packages/domain start.ts,
// D-67). No import of ledger.ts at run time: ledger.ts uses this file.
import { type LinkInfo, type StartRole, startRole } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import type { TxRow } from './ledger.js';

/** CSV history rows (routes/ops.ts) are stored as bank rows of a 'csv' connection with these ids; they have no link. */
const isCsv = (t: Pick<TxRow, 'provider_txn_id'>) => !!t.provider_txn_id?.startsWith('csv_');

export interface Links {
  /** Each linked account's link (by account id). */
  accounts: ReadonlyMap<string, LinkInfo>;
  /**
   * Posted rows the bank removed, by account, amount and posted date: the earliest arrival. A new row that matches
   * one is the bank sending the same purchase again (a reissue, `possible_reissue`), so it keeps that arrival: a row
   * in the balance at link stays there.
   */
  removed: ReadonlyMap<string, number>;
}

const reissueKey = (account: string, amount: number, postedDate: string) =>
  `${account}|${amount}|${postedDate}`;

/**
 * Each linked account's link: when its bank connection was linked, and when that connection's first row arrived
 * (the first sync, through bank_txn_connection_created), with the removed posted rows.
 */
export async function linkInfo(s: Scoped): Promise<Links> {
  const [acc, gone] = await s.batch([
    s.q(
      `SELECT a.id, c.linked_at, a.starting_balance_confirmed_at AS confirmed_at,
         (SELECT min(b.created_at) FROM bank_txn b WHERE b.budget_id = ?1 AND b.connection_id = c.id) AS first_seen
       FROM account a
       JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
       JOIN connection c ON c.id = pa.connection_id
       WHERE a.budget_id = ?1 AND c.provider IN ('plaid', 'fake')`,
    ),
    s.q(
      `SELECT a.id AS account_id, b.amount, b.date, min(b.created_at) AS at FROM bank_txn b
       JOIN account a ON a.budget_id = b.budget_id AND a.provider_account_id = b.provider_account_id
       WHERE b.budget_id = ?1 AND b.removed_at IS NOT NULL AND b.pending = 0 GROUP BY a.id, b.amount, b.date`,
    ),
  ]);
  const accounts = new Map(
    (
      acc!.results as {
        id: string;
        linked_at: number;
        confirmed_at: number | null;
        first_seen: number | null;
      }[]
    ).map((r) => [
      r.id,
      {
        linkedAt: r.linked_at,
        balanceAt: Math.max(r.linked_at, r.confirmed_at ?? 0),
        firstSeen: r.first_seen,
      },
    ]),
  );
  const removed = new Map(
    (gone!.results as { account_id: string; amount: number; date: string; at: number }[]).map((r) => [
      reissueKey(r.account_id, r.amount, r.date),
      r.at,
    ]),
  );
  return { accounts, removed };
}

/** No links: for a read with no bank rows. */
export const NO_LINKS: Links = { accounts: new Map(), removed: new Map() };

export function roleOf(
  t: Pick<
    TxRow,
    | 'source'
    | 'status'
    | 'date'
    | 'seq'
    | 'pending_at_link'
    | 'budget_from'
    | 'account_id'
    | 'provider_txn_id'
    | 'bank_amount'
    | 'posted_date'
  >,
  links: Links,
): StartRole | null {
  if (!t.budget_from) return null;
  const again =
    t.status === 'posted' && t.bank_amount !== null && t.posted_date
      ? links.removed.get(reissueKey(t.account_id, t.bank_amount, t.posted_date))
      : undefined;
  return startRole(
    {
      source: t.source,
      status: t.status,
      date: t.date,
      firstSeenAt: again !== undefined ? Math.min(t.seq, again) : t.seq,
      pendingAtLink: t.pending_at_link === 1,
    },
    t.budget_from,
    isCsv(t) ? null : (links.accounts.get(t.account_id) ?? null),
  );
}
