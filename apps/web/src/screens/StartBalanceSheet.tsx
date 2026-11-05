// An account's starting balance, step by step (D-?): the bank's balance at link, the rows from before the budget
// start that came in later, the link day's rows the budget counts instead, and the total the budget uses.
import type { StartBalance } from '@ledgerline/contracts';
import { Sheet, SheetTitle } from '../components/Sheet';
import { Label, PrimaryButton } from '../components/ui';
import { formatCents } from '../lib/money';
import { dayLabel } from '../lib/dates';

/** What the account page shows: money for checking and savings, the debt (positive) for a card. */
export const shownBalance = (v: number, credit: boolean) => (credit ? -v : v);

function signed(v: number) {
  return `${v < 0 ? '−' : '+'} ${formatCents(Math.abs(v))}`;
}

export function StartBalanceSheet({
  start,
  credit,
  close,
}: {
  start: StartBalance;
  credit: boolean;
  close: () => void;
}) {
  const word = credit ? 'starting debt' : 'starting balance';
  const title = credit ? 'Starting debt' : 'Starting balance';
  const from = dayLabel(start.from);
  // How each row changes the figure shown: on a card a purchase adds to the debt.
  const change = (r: StartBalance['rows'][number]) =>
    shownBalance(r.role === 'before' ? r.amount : -r.amount, credit);
  const before = start.rows.filter((r) => r.role === 'before');
  const linkDay = start.rows.filter((r) => r.role === 'linkDay');
  const row = (r: StartBalance['rows'][number]) => (
    <div key={r.key} className="flex items-baseline justify-between gap-3 text-md">
      <span className="min-w-0 truncate text-ink">
        {r.payee}
        <span className="text-muted">
          {' · '}
          {dayLabel(r.date)}
          {r.pending ? ' · pending' : ''}
        </span>
      </span>
      <span className="tnum shrink-0 text-ink">{signed(change(r))}</span>
    </div>
  );
  return (
    <Sheet
      label={title}
      track="account.start"
      onClose={close}
      gap="auto"
      header={<SheetTitle title={title} />}
      footer={
        <PrimaryButton track="account.start.done" onClick={close}>
          Done
        </PrimaryButton>
      }
    >
      <p className="m-0 text-md leading-snug text-ink-2">
        Your budget for this account starts on {from}. Purchases from before {from} are part of the {word},
        not a category.
      </p>
      <div className="flex flex-col gap-2" data-testid="start-sheet">
        <div className="flex items-baseline justify-between gap-3 text-md">
          <span className="text-muted">{credit ? 'Owed when you linked' : 'Balance when you linked'}</span>
          <span className="tnum font-semibold text-ink">
            {formatCents(shownBalance(start.atLink, credit))}
          </span>
        </div>
        {before.length > 0 && (
          <>
            <Label>From before {from}, came in later</Label>
            {before.map(row)}
          </>
        )}
        {linkDay.length > 0 && (
          <>
            <Label>Dated {from}, counted in your budget</Label>
            {linkDay.map(row)}
          </>
        )}
        <div className="flex items-baseline justify-between gap-3 border-t border-divider pt-2 text-base">
          <span className="font-semibold text-ink">{title}</span>
          <span className="tnum font-bold text-ink">{formatCents(shownBalance(start.total, credit))}</span>
        </div>
      </div>
      <p className="m-0 text-sm leading-snug text-muted">
        {start.settling && start.settlesOn
          ? `Settling. Final on ${dayLabel(start.settlesOn)}. Until then, a purchase from before ${from} that comes in late is added here.`
          : 'Final.'}
      </p>
    </Sheet>
  );
}
