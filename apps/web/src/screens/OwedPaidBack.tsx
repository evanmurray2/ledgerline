// Owed to you · Paid back recently: the money in that paid items back (OwedView.paidBack), newest first. A row opens
// that money's transaction; its second line names what it paid back.
import { Link } from '@tanstack/react-router';
import type { OwedView } from '@ledgerline/contracts';
import { Card, SectionTitle } from '../components/ui';
import { useHere } from '../lib/back';
import { dayLabel } from '../lib/dates';
import { formatCents } from '../lib/money';

/** "Paid back Rent" · "Paid back Rent and United" · "Paid back Rent, United and 1 more". */
export function paidFor(items: OwedView['paidBack'][number]['items']): string {
  const names = [...new Set(items.map((i) => i.label).filter(Boolean))];
  if (!names.length) return 'Paid back';
  if (names.length <= 2) return `Paid back ${names.join(' and ')}`;
  return `Paid back ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function PaidBackRecently({ paidBack }: { paidBack: OwedView['paidBack'] }) {
  const here = useHere();
  if (!paidBack.length) return null;
  return (
    <>
      <SectionTitle>Paid back recently</SectionTitle>
      <Card>
        {paidBack.map((p) => (
          <Link
            key={p.key}
            to={`/activity/txn/${p.key}`}
            search={{ close: here }}
            data-track="owed.paid_back"
            className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-1.5 text-ink no-underline first:border-t-0"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-base font-semibold wrap-anywhere">{p.payee || 'Money in'}</span>
              <span className="text-xs text-muted">
                {dayLabel(p.date)} · {paidFor(p.items)}
              </span>
            </span>
            <span className="tnum shrink-0 text-base font-bold text-funded-fg">
              {formatCents(p.matched, { plus: true })}
            </span>
          </Link>
        ))}
      </Card>
    </>
  );
}
