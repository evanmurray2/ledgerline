// Transfer detection (design: Transfer detection, revised Oct 31, 2026). An outflow in one of your accounts with
// exactly one matching inflow of the same amount in another of your accounts within 5 days is paired
// automatically; with two or more possible other sides, or none, you're asked. Only transfer-like outflows are
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

const TRANSFER_WORDS = /\b(TRANSFER|XFER|ONLINE PMT|PAYMENT THANK YOU|AUTOPAY|DEPOSIT FROM|WITHDRAWAL TO)\b/i;

export function isTransferLike(r: TransferRow): boolean {
  return (
    (r.providerCategory?.startsWith('TRANSFER_') ?? false) ||
    r.providerCategory === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ||
    TRANSFER_WORDS.test(r.description)
  );
}

export function detectTransfers(
  rows: readonly TransferRow[],
  alreadyPaired: ReadonlySet<string> = new Set(),
): TransferDecision[] {
  const open = rows.filter((r) => !alreadyPaired.has(r.key));
  const inflows = open.filter((r) => r.amount > 0);
  const out: TransferDecision[] = [];
  const used = new Set<string>();
  for (const o of open) {
    if (o.amount >= 0 || !isTransferLike(o)) continue;
    const cands = inflows.filter(
      (i) =>
        !used.has(i.key) &&
        i.accountId !== o.accountId &&
        i.amount === -o.amount &&
        Math.abs(daysBetween(o.date, i.date)) <= 5,
    );
    if (cands.length === 1) {
      used.add(cands[0]!.key);
      out.push({ kind: 'paired', outKey: o.key, inKey: cands[0]!.key });
    } else {
      out.push({ kind: 'unclear', outKey: o.key, candidates: cands.map((c) => c.key) });
    }
  }
  return out;
}
