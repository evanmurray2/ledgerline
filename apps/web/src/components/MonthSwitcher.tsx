// The one month switcher (Budget's title, Reports' header): 44 px buttons with 22 px chevrons, Previous and Next
// disabled at the first and last month there is, and "[" / "]" on a computer.
import { addMonths, compareMonths, monthLabel } from '../lib/dates';
import { cx, Icon, useIsDesktop, useShortcuts } from './ui';

export function MonthSwitcher({
  month,
  min,
  max,
  onGo,
  track,
  title = false,
  labelClassName,
  className,
}: {
  month: string;
  /** The first month there is; Previous is disabled there. */
  min?: string;
  /** The last month there is; Next is disabled there. */
  max?: string;
  onGo: (month: string) => void;
  /** Usage id prefix: `${track}.prev` and `${track}.next`. */
  track: string;
  /** The month is the screen's title (an h1, Budget); otherwise smaller text (Reports). */
  title?: boolean;
  /** The title's size and width (with `title`). */
  labelClassName?: string;
  className?: string;
}) {
  const desktop = useIsDesktop();
  const canPrev = !min || compareMonths(month, min) > 0;
  const canNext = !max || compareMonths(month, max) < 0;
  useShortcuts(
    {
      '[': () => canPrev && onGo(addMonths(month, -1)),
      ']': () => canNext && onGo(addMonths(month, 1)),
    },
    desktop,
  );
  const btn =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-2 disabled:text-line-strong';
  const Label = title ? 'h1' : 'span';
  return (
    <div className={cx('flex items-center', className)}>
      <button
        type="button"
        data-track={`${track}.prev`}
        aria-label="Previous month"
        aria-keyshortcuts={desktop ? '[' : undefined}
        title={desktop ? 'Previous month ( [ )' : undefined}
        disabled={!canPrev}
        onClick={() => onGo(addMonths(month, -1))}
        className={btn}
      >
        <Icon name="chevL" size={22} />
      </button>
      <Label
        className={cx('m-0 text-center font-bold', !title && 'min-w-[84px] text-[15px]', labelClassName)}
      >
        {monthLabel(month)}
      </Label>
      <button
        type="button"
        data-track={`${track}.next`}
        aria-label="Next month"
        aria-keyshortcuts={desktop ? ']' : undefined}
        title={desktop ? 'Next month ( ] )' : undefined}
        disabled={!canNext}
        onClick={() => onGo(addMonths(month, 1))}
        className={btn}
      >
        <Icon name="chevR" size={22} />
      </button>
    </div>
  );
}
