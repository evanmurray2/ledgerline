// The header of the four tabs (docs/month-header.md): ‹ November 2026 › in the same place on Budget, Activity and
// Reports, and the tab's name in that place on Accounts.
// - Phone: 56 px, three fixed columns (44 px | middle | 44 px), so the middle is centered on the screen whatever
//   the tab's buttons; each side holds at most one 44 px icon button.
// - Desktop: the 64 px DesktopHeader, the month on the left edge of the content column, actions on the right.
// The month label has a fixed width (as wide as "September 2026") so the chevrons never move. Off this month,
// "Back to November" sits under it (phone) or beside it (desktop), and the label itself goes back too.
// Previous and Next are disabled at the first and last month there is; on a computer "[" / "]" step and "t"
// goes to this month.
import type { ReactNode } from 'react';
import { addMonths, compareMonths, monthLabel, monthName, monthShort } from '../lib/dates';
import { DesktopHeader } from './headers';
import { cx, Icon, useIsDesktop, useShortcuts } from './ui';

export function TabHeader({
  name,
  month,
  left,
  right,
  below,
}: {
  /** The tab's name: a hidden h1 when the month is shown, else the visible title. */
  name: string;
  /** The month bar; without it the tab's name takes its place. */
  month?: ReactNode;
  /** Phone only: one 44 px button on the left. */
  left?: ReactNode;
  right?: ReactNode;
  /** Search and filter chips under the bar. */
  below?: ReactNode;
}) {
  const desktop = useIsDesktop();
  const heading = month ? (
    <h1 className="sr-only">{name}</h1>
  ) : (
    <h1 className={cx('m-0 truncate font-bold', desktop ? 'text-3xl' : 'text-xl')}>{name}</h1>
  );
  if (desktop)
    return (
      <DesktopHeader
        title={
          <div className="flex min-w-0 items-center">
            {heading}
            {month}
          </div>
        }
        right={right}
        below={below}
      />
    );
  return (
    <header className="shrink-0 border-b border-line bg-surface">
      {month && heading}
      <div className="grid h-14 grid-cols-[44px_minmax(0,1fr)_44px] items-center px-2">
        <div className="flex">{left}</div>
        <div className="flex min-w-0 justify-center">{month ?? heading}</div>
        <div className="flex justify-end">{right}</div>
      </div>
      {below && <div className="flex flex-col gap-2.5 px-4 pb-2.5">{below}</div>}
    </header>
  );
}

export function MonthBar({
  month,
  current,
  min,
  max,
  onGo,
}: {
  /** The month on screen. */
  month: string;
  /** This month: "Back to …" goes there. */
  current: string;
  /** The first month there is; Previous is disabled there. */
  min?: string;
  /** The last month there is; Next is disabled there. */
  max?: string;
  onGo: (month: string) => void;
}) {
  const desktop = useIsDesktop();
  const canPrev = !min || compareMonths(month, min) > 0;
  const canNext = !max || compareMonths(month, max) < 0;
  const away = month !== current;
  useShortcuts(
    {
      '[': () => canPrev && onGo(addMonths(month, -1)),
      ']': () => canNext && onGo(addMonths(month, 1)),
      t: () => away && onGo(current),
    },
    desktop,
  );
  const back = `Back to ${monthName(current)}`;
  const chevron =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-2 disabled:text-line-strong';
  return (
    <div role="group" aria-label="Month" className={cx('flex items-center', desktop ? '-ml-3' : 'h-14')}>
      <button
        type="button"
        data-track="month.prev"
        aria-label="Previous month"
        aria-keyshortcuts={desktop ? '[' : undefined}
        title={desktop ? 'Previous month ( [ )' : undefined}
        disabled={!canPrev}
        onClick={() => onGo(addMonths(month, -1))}
        className={chevron}
      >
        <Icon name="chevL" size={22} />
      </button>
      {/* Always a button, so focus stays on it when it goes back to this month. */}
      <button
        type="button"
        data-track="month.today"
        data-testid="month-label"
        aria-disabled={!away || undefined}
        aria-label={away ? `${monthLabel(month)}. ${back}` : monthLabel(month)}
        onClick={() => away && onGo(current)}
        className={cx(
          'relative flex shrink-0 flex-col items-center justify-center font-bold text-ink',
          desktop ? 'h-11 w-[184px] text-3xl' : 'h-14 w-[140px] text-xl max-[359px]:w-[92px]',
          !away && 'cursor-default',
        )}
      >
        <span className={cx(!desktop && 'max-[359px]:hidden')}>{monthLabel(month)}</span>
        {!desktop && (
          <span className="hidden max-[359px]:inline">{`${monthShort(month)} ${month.slice(0, 4)}`}</span>
        )}
        {/* Under the label, in the bar's bottom gap, so the label doesn't move when it shows. */}
        {away && !desktop && (
          <span className="absolute bottom-1 whitespace-nowrap text-xs font-semibold text-accent">
            {back}
          </span>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {monthLabel(month)}
      </span>
      <button
        type="button"
        data-track="month.next"
        aria-label="Next month"
        aria-keyshortcuts={desktop ? ']' : undefined}
        title={desktop ? 'Next month ( ] )' : undefined}
        disabled={!canNext}
        onClick={() => onGo(addMonths(month, 1))}
        className={chevron}
      >
        <Icon name="chevR" size={22} />
      </button>
      {away && desktop && (
        <button
          type="button"
          data-track="month.today"
          aria-keyshortcuts="t"
          title={`${back} ( t )`}
          onClick={() => onGo(current)}
          className="hit ml-2 h-9 rounded-full px-3 text-md font-semibold text-accent hover:bg-accent-soft"
        >
          {back}
        </button>
      )}
    </div>
  );
}
