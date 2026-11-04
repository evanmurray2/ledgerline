// Pieces every transaction sheet shares: the path of the screen under a sheet, closing back to it, the
// amount-led header and the "Bank says" lines with Rename payee.
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { SheetTitle } from '../components/Sheet';
import { cx, inputClass, textLinkClass } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';

/** Path of the screen under a sheet: /activity/txn/x → /activity, /accounts/chk/txn/x/split → /accounts/chk. */
export function useParentPath(): string {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return path.replace(/\/(txn|transfer|match|check|close|add)(\/.*)?$/, '') || '/activity';
}

export function useClose() {
  const navigate = useNavigate();
  const parent = useParentPath();
  // Back to the screen as it was: its month, filter and search stay.
  return () => void navigate({ to: parent, search: true });
}

/** The one amount box in the transaction sheets: inputClass at 18 px bold, as in the category sheet. */
export const AMOUNT_INPUT = cx(inputClass, 'tnum text-[18px] font-bold');

const TAG: Record<TxnSheet['kind'], string> = {
  pending: 'Pending',
  posted: 'Posted',
  income: 'Income · posted',
  refund: 'Refund · posted',
  paidBack: 'Paid back',
  transfer: 'Transfer',
  manual: 'Added by you',
  upcoming: 'Upcoming',
  history: 'Before your budget',
};

export function TxnHeader({ t }: { t: TxnSheet }) {
  const est = t.kind === 'pending' && t.estimatedAmount !== null;
  return (
    <SheetTitle
      tag={est ? 'Pending · your estimate' : t.wontClear ? 'Pending · won’t clear' : TAG[t.kind]}
      tagClass={est ? 'text-info-fg' : t.kind === 'paidBack' ? 'text-owed-fg' : undefined}
      amount={t.kind === 'transfer' ? formatCents(Math.abs(t.amount)) : formatCents(t.amount, { plus: true })}
      amountClass={t.amount > 0 ? 'text-funded-fg' : undefined}
      sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
    />
  );
}

export function BankSays({ t, extra }: { t: TxnSheet; extra?: string }) {
  const parent = useParentPath();
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted">
      <span>Bank says: {t.rawName}</span>
      {extra && <span>{extra}</span>}
      <div className="flex gap-4">
        <Link
          to={`${parent}/txn/${encodeURIComponent(t.key)}/rename`}
          data-track="txn.rename"
          className={textLinkClass}
        >
          Rename payee
        </Link>
      </div>
    </div>
  );
}
