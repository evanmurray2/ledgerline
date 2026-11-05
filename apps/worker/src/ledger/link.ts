// Each linked account's bank link, and the role a row has toward its starting balance (packages/domain start.ts,
// D-?). No import of ledger.ts at run time: ledger.ts uses this file.
import { type LinkInfo, type StartRole, startRole } from '@ledgerline/domain';
import type { Scoped } from '../db/scoped.js';
import type { TxRow } from './ledger.js';

/** CSV history rows (routes/ops.ts) are stored as bank rows of a 'csv' connection with these ids; they have no link. */
const isCsv = (t: Pick<TxRow, 'provider_txn_id'>) => !!t.provider_txn_id?.startsWith('csv_');

/**
 * Each linked account's link: when its bank connection was linked, and when that connection's first row arrived
 * (the first sync). The first row is read over the connection's rows: a few thousand, once per call.
 */
export async function linkInfo(s: Scoped): Promise<Map<string, LinkInfo>> {
  const rows = await s.all<{
    id: string;
    linked_at: number;
    confirmed_at: number | null;
    first_seen: number | null;
  }>(
    `SELECT a.id, c.linked_at, a.starting_balance_confirmed_at AS confirmed_at, (SELECT min(b.created_at) FROM bank_txn b WHERE b.budget_id = ?1 AND b.connection_id = c.id) AS first_seen
     FROM account a
     JOIN provider_account pa ON pa.budget_id = a.budget_id AND pa.provider_account_id = a.provider_account_id
     JOIN connection c ON c.id = pa.connection_id
     WHERE a.budget_id = ?1 AND c.provider IN ('plaid', 'fake')`,
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        linkedAt: r.linked_at,
        balanceAt: Math.max(r.linked_at, r.confirmed_at ?? 0),
        firstSeen: r.first_seen,
      },
    ]),
  );
}

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
  >,
  links: ReadonlyMap<string, LinkInfo>,
): StartRole | null {
  if (!t.budget_from) return null;
  return startRole(
    {
      source: t.source,
      status: t.status,
      date: t.date,
      firstSeenAt: t.seq,
      pendingAtLink: t.pending_at_link === 1,
    },
    t.budget_from,
    isCsv(t) ? null : (links.get(t.account_id) ?? null),
  );
}
