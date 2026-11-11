// Transfer detection (design: Transfer detection, revised Oct 31, 2026). An outflow in one of your accounts with
// exactly one matching inflow of the same amount in another of your accounts within 5 days is paired
// automatically, as long as that inflow could not also be the other side of another outflow; with two or more
// possible other sides, or none, you're asked, so the answer never depends on the order the rows arrive in. Only transfer-like outflows are
// considered (the provider marks them as transfers, or the description says so).
import { type Cents } from './money.js';
import { type IsoDate, daysBetween } from './month.js';

export interface TransferRow {
  key: string;
  accountId: string;
  amount: Cents;
  date: IsoDate;
  description: string;
  providerCategory: string | null;
}

export type TransferDecision =
  | { kind: 'paired'; outKey: string; inKey: string }
  | { kind: 'unclear'; outKey: string; candidates: string[] };

/** The words that mark a transfer in a bank's description (also used to build a looser SQL test). */
export const TRANSFER_WORD_LIST = [
  'TRANSFER',
  'XFER',
  'ONLINE PMT',
  'PAYMENT THANK YOU',
  'AUTOPAY',
  'DEPOSIT FROM',
  'WITHDRAWAL TO',
] as const;
const TRANSFER_WORDS = new RegExp(`\\b(${TRANSFER_WORD_LIST.join('|')})\\b`, 'i');

export function isTransferLike(r: Pick<TransferRow, 'description' | 'providerCategory'>): boolean {
  return (
    (r.providerCategory?.startsWith('TRANSFER_') ?? false) ||
    r.providerCategory === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ||
    TRANSFER_WORDS.test(r.description)
  );
}

/**
 * The transfers among `rows`, the rows of one bank update.
 *
 * `earlier` (D-86 A2, D-90) are rows filed before this update that have no partner and that the person has not
 * sorted by hand: an outflow nobody answered for, an inflow that came alone. A new row can pair with one of them, by
 * the same rule: the same amount, another account, dates at most 5 days apart, and exactly one possible partner on
 * each side. When each row arrived does not matter. Two earlier rows never pair with each other here: every decision
 * holds a row of this update, so rows from before the rule are not paired in bulk. A pair made before is not in
 * `earlier`, so it stays, and a later row that could have been its partner is asked about.
 */
export function detectTransfers(
  rows: readonly TransferRow[],
  alreadyPaired: ReadonlySet<string> = new Set(),
  earlier: readonly TransferRow[] = [],
): TransferDecision[] {
  const fresh = rows.filter((r) => !alreadyPaired.has(r.key));
  const isNew = new Set(fresh.map((r) => r.key));
  const open = [...earlier.filter((r) => !alreadyPaired.has(r.key) && !isNew.has(r.key)), ...fresh];
  const inflows = open.filter((r) => r.amount > 0);
  const outflows = open.filter((o) => o.amount < 0 && isTransferLike(o));
  const matches = (o: TransferRow, i: TransferRow) =>
    i.accountId !== o.accountId && i.amount === -o.amount && Math.abs(daysBetween(o.date, i.date)) <= 5;
  // How many outflows each inflow could belong to.
  const claims = new Map<string, number>();
  for (const o of outflows)
    for (const i of inflows) if (matches(o, i)) claims.set(i.key, (claims.get(i.key) ?? 0) + 1);
  const out: TransferDecision[] = [];
  for (const o of outflows) {
    const cands = inflows.filter((i) => matches(o, i));
    // An earlier outflow is looked at again only when this update brought it a possible partner.
    if (!isNew.has(o.key) && !cands.some((c) => isNew.has(c.key))) continue;
    if (cands.length === 1 && claims.get(cands[0]!.key) === 1)
      out.push({ kind: 'paired', outKey: o.key, inKey: cands[0]!.key });
    else out.push({ kind: 'unclear', outKey: o.key, candidates: cands.map((c) => c.key) });
  }
  return out;
}
