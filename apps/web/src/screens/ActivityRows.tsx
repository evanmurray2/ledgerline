// Activity's rows: one transaction row (also used by an account's register) and a titled card of them.
import { Link } from '@tanstack/react-router';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { badgeClass, cx, SectionTitle, useIsDesktop } from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta } from '../lib/common';

export type NeedsRow = ActivityView['needsCategory'][number];
/** A row categorized while on Activity: it stays in place with its new category. */
export type Chosen = { row: NeedsRow; categoryId: string | null; toRta?: boolean; name: string };

export function sheetPath(base: string, r: Pick<TxnListRow, 'key' | 'sheet'>): string {
  const seg =
    r.sheet === 'transfer'
      ? 'transfer'
      : r.sheet === 'match'
        ? 'match'
        : r.sheet === 'checkPending'
          ? 'check'
          : 'txn';
  return `${base}/${seg}/${encodeURIComponent(r.key)}`;
}

function amountClass(r: TxnListRow) {
  if (r.wontClear) return 'text-faint line-through';
  return r.amount > 0 ? 'text-funded-fg' : 'text-ink';
}

export function TxnRow({
  r,
  base,
  style = 'list',
  action,
}: {
  r: TxnListRow;
  base: string;
  style?: 'list' | 'posted' | 'register';
  action?: React.ReactNode;
}) {
  const desktop = useIsDesktop();
  // On a phone a row with a button stacks: the text gets the full width, and the badge and button share a line.
  const stacked = !!action && !desktop;
  const badge = r.badge && (
    <span className={cx('self-start rounded-sm px-2 py-0.5 text-xs font-bold', badgeClass(r.badgeKind))}>
      {r.badge}
    </span>
  );
  return (
    <div
      className={cx(
        'flex gap-2.5 border-t border-divider px-3 py-2 first:border-t-0',
        stacked ? 'flex-col' : 'items-center',
        desktop && 'hover:bg-surface-2',
      )}
    >
      {/* The sheet keeps the list's search (month, filter), so the list under it doesn't change. */}
      <Link
        to={sheetPath(base, r)}
        search={true}
        data-track="activity.row"
        className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2.5 text-ink no-underline"
      >
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className={cx('text-base font-semibold', r.wontClear && 'text-faint line-through')}>
            {r.payee}
          </span>
          <span className={cx('text-muted', desktop ? 'text-sm' : 'text-xs')}>{rowMeta(r, style)}</span>
          {!stacked && badge}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={cx('tnum text-base font-bold', amountClass(r))}>
            {r.sheet === 'txn' && r.badge === 'Transfer'
              ? formatCents(Math.abs(r.amount))
              : formatCents(r.amount, { plus: true })}
          </span>
          {r.sub && style !== 'register' && <span className="text-xs text-muted">{r.sub}</span>}
        </span>
      </Link>
      {stacked ? (
        <div className="flex items-center justify-between gap-2.5">
          {badge || <span />}
          {action}
        </div>
      ) : (
        action
      )}
    </div>
  );
}

export function Section({
  title,
  note,
  children,
  action,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <SectionTitle note={note} action={action}>
        {title}
      </SectionTitle>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">{children}</div>
    </section>
  );
}

export interface Picking {
  keys: string[];
  row: NeedsRow | null;
}
