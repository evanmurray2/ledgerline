// Pieces every transaction sheet shares: the path of the screen under a sheet, closing back to it, the
// amount-led header and the bank's name with Rename payee.
import { useEffect } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import type { TxnSheet } from '@ledgerline/contracts';
import { SheetTitle } from '../components/Sheet';
import { textLinkClass } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';
import { useCloseTo } from '../lib/back';

/** Path of the screen under a sheet: /activity/txn/x → /activity, /accounts/chk/txn/x/split → /accounts/chk. */
export function useParentPath(): string {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return path.replace(/\/(txn|transfer|match|check|close|add)(\/.*)?$/, '') || '/activity';
}

export function useClose() {
  const navigate = useNavigate();
  const parent = useParentPath();
  // Opened from another tab (a category, Owed to you, an alert on Accounts): back there.
  const closeTo = useCloseTo();
  // Back to the screen as it was: its month, filter and search stay.
  return closeTo ? closeTo.go : () => void navigate({ to: parent, search: true });
}

/** Where closing the sheet goes, as a path: for a link that leaves the sheet, so Back returns there. */
export function useCloseHref(): string {
  const parent = useParentPath();
  const closeTo = useCloseTo();
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  return closeTo?.to ?? parent + searchStr;
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
  history: 'Before your budget',
};

/** `amount`: what the sheet holds before Save (your own entry's amount and direction), instead of the saved one. */
export function TxnHeader({ t, amount = t.amount }: { t: TxnSheet; amount?: number }) {
  const est = t.kind === 'pending' && t.estimatedAmount !== null;
  return (
    <SheetTitle
      tag={est ? 'Pending · your estimate' : t.wontClear ? 'Pending · won’t clear' : TAG[t.kind]}
      tagClass={
        est
          ? 'text-info-fg'
          : t.kind === 'paidBack'
            ? 'text-owed-fg'
            : t.kind === 'transfer'
              ? 'text-transfer-fg'
              : undefined
      }
      amount={t.kind === 'transfer' ? formatCents(Math.abs(amount)) : formatCents(amount, { plus: true })}
      amountClass={amount > 0 ? 'text-funded-fg' : undefined}
      sub={`${t.payee} · ${t.accountName} · ${dayLabel(t.date)}`}
    />
  );
}

export function BankSays({ t, extra }: { t: TxnSheet; extra?: string }) {
  const parent = useParentPath();
  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      {/* Your own entry has no bank name: its raw name is the one you typed. */}
      {t.kind !== 'manual' && t.kind !== 'upcoming' && <span>Bank name: {t.rawName}</span>}
      {extra && <span>{extra}</span>}
      {/* A transfer has no payee to rename (D-107). */}
      {!t.transfer && (
        <div className="flex gap-4">
          <Link
            to={`${parent}/txn/${encodeURIComponent(t.key)}/rename`}
            search
            data-track="txn.rename"
            className={textLinkClass}
          >
            Rename payee
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * A transaction opened over another account's register (a link with the wrong account): it moves to its own
 * account's register, so the list under the sheet is the one it belongs to. True while it moves.
 */
export function useOwnRegister(t: TxnSheet | undefined): boolean {
  const parent = useParentPath();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const acct = /^\/accounts\/([^/]+)$/.exec(parent)?.[1];
  const own = t ? `/accounts/${encodeURIComponent(t.accountId)}` : '';
  const wrong = !!t && !!acct && parent !== own;
  useEffect(() => {
    if (wrong) void navigate({ to: own + path.slice(parent.length), search: true, replace: true });
  }, [wrong, navigate, own, path, parent]);
  return wrong;
}
