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
  categoryMenu,
}: {
  r: TxnListRow;
  base: string;
  style?: 'list' | 'posted' | 'register';
  action?: React.ReactNode;
  /**
   * Shown in place of the category tag: desktop Activity's category menu (ActivityRowPick.tsx). The amount then
   * keeps its place at the right edge, in line with every other row.
   */
  categoryMenu?: React.ReactNode;
}) {
  const desktop = useIsDesktop();
  // On a phone a row with a button stacks: the text gets the full width, and the badge and button share a line.
  const stacked = !!action && !desktop;
  // Tags: the status first (filled), then the category as plain text. An outline would read as a button, and the
  // category isn't one: the row opens the transaction.
  const category = !categoryMenu && r.categoryLabel && r.categoryLabel !== r.badge ? r.categoryLabel : null;
  const badge = (r.badge || category || categoryMenu) && (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {r.badge && (
        <span className={cx('rounded-sm px-2 py-0.5 text-xs font-bold', badgeClass(r.badgeKind))}>
          {r.badge}
        </span>
      )}
      {category && (
        // A transfer's chip takes the transfer color, so it reads as one even under another tag ("Added by you").
        <span
          className={cx('text-xs font-semibold', category === 'Transfer' ? 'text-transfer-fg' : 'text-ink-2')}
        >
          {category}
        </span>
      )}
      {categoryMenu}
    </span>
  );
  const meta = rowMeta(r, style);
  // The grey line under the amount only when it adds a number ("bank $31.40"); words such as "held" or
  // "pending" repeat the tag.
  const sub = r.sub && /\d/.test(r.sub) ? r.sub : null;
  const amount =
    // A register's running balance needs the sign: money in or out of this account.
    r.sheet === 'txn' && r.badge === 'Transfer' && style !== 'register'
      ? formatCents(Math.abs(r.amount))
      : formatCents(r.amount, { plus: true });
  const payeeClass = cx('text-base font-semibold break-words', r.wontClear && 'text-faint line-through');
  const metaEl = meta && <span className={cx('text-muted', desktop ? 'text-sm' : 'text-xs')}>{meta}</span>;
  const amountEl = (
    <span className="flex shrink-0 flex-col items-end gap-0.5">
      <span className={cx('tnum text-base font-bold whitespace-nowrap', amountClass(r))}>{amount}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </span>
  );
  const rowClass = cx(
    'flex gap-2.5 border-t border-divider px-3 py-2 first:border-t-0',
    desktop && 'hover:bg-surface-2',
  );
  // The sheet keeps the list's search (month, filter), so the list under it doesn't change.
  const to = sheetPath(base, r);

  if (categoryMenu) {
    // A button can't sit inside a link, so the link holds only the payee and stretches over the whole row
    // (its ::after); the menu sits above it. The link's name still reads the whole row.
    const name = [r.payee, meta, r.badge, amount, sub].filter(Boolean).join(', ');
    return (
      <div className={cx(rowClass, 'relative items-center')}>
        <div className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2.5">
          <span className="flex min-w-0 flex-col gap-[3px]">
            <Link
              to={to}
              search={true}
              data-track="activity.row"
              aria-label={name}
              className={cx(
                payeeClass,
                'text-ink no-underline after:absolute after:inset-0 after:content-[""]',
                'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent',
              )}
            >
              {r.payee}
            </Link>
            {metaEl}
            {badge}
          </span>
          {amountEl}
        </div>
        {action}
      </div>
    );
  }

  return (
    <div className={cx(rowClass, stacked ? 'flex-col' : 'items-center')}>
      <Link
        to={to}
        search={true}
        data-track="activity.row"
        className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2.5 text-ink no-underline"
      >
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className={payeeClass}>{r.payee}</span>
          {metaEl}
          {!stacked && badge}
        </span>
        {amountEl}
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
