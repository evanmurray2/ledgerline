// Pieces every transaction sheet shares: the path of the screen under a sheet, closing back to it, the
// amount-led header and the "Bank says" lines with Rename payee.
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { cx } from '../components/ui';
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
  return () => void navigate({ to: parent });
}

const TAG: Record<TxnSheet['kind'], string> = {
  pending: 'Pending',
  posted: 'Posted',
  income: 'Income · posted',
  refund: 'Refund · posted',
  paidBack: 'Paid back',
  transfer: 'Transfer',
  manual: 'Added by you',
  upcoming: 'Upcoming',
};

export function TxnHeader({ t }: { t: TxnSheet }) {
  const est = t.kind === 'pending' && t.estimatedAmount !== null;
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cx(
          'text-[13px] font-bold',
          est ? 'text-info-fg' : t.kind === 'paidBack' ? 'text-owed-fg' : 'text-muted',
        )}
      >
        {est ? 'Pending · your estimate' : t.wontClear ? 'Pending · won’t clear' : TAG[t.kind]}
      </span>
      <h1 className={cx('tnum m-0 text-[28px] font-bold', t.amount > 0 && 'text-funded-fg')}>
        {t.kind === 'transfer' ? formatCents(Math.abs(t.amount)) : formatCents(t.amount, { plus: true })}
      </h1>
      <span className="text-[14px] text-muted">
        {t.payee} · {t.accountName} · {dayLabel(t.date)}
      </span>
    </div>
  );
}

export function BankSays({ t, extra, ruleLink }: { t: TxnSheet; extra?: string; ruleLink?: boolean }) {
  const parent = useParentPath();
  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted">
      <span>Bank says: {t.rawName}</span>
      {extra && <span>{extra}</span>}
      <div className="flex gap-4">
        <Link
          to={`${parent}/txn/${encodeURIComponent(t.key)}/rename`}
          data-track="txn.rename"
          className="flex min-h-9 items-center font-bold no-underline"
        >
          Rename payee
        </Link>
        {ruleLink && t.categorizedBy?.startsWith('rule') && (
          <Link
            to="/settings/rules"
            data-track="txn.see_rule"
            className="flex min-h-9 items-center font-bold no-underline"
          >
            See {t.categorizedBy}
          </Link>
        )}
      </div>
    </div>
  );
}
