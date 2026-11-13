// A grayed-out action that still says why when tapped: view only until the daily limit resets, or offline before
// the budget is open on this device. Used where a link-styled action (Assign) has no room for a line of reason text;
// where there is room (the desktop sidebar), `showWhy` puts the short reason under it as well.
import { useId, type ReactNode } from 'react';
import { useConnectivity } from '../state/connectivity';
import { budgetTime } from '../lib/dates';
import { dailyResetTime } from '../api/client';
import { toast } from './Toast';
import { cx } from './ui';

/** Why changes are off right now, in the words of the status banners (docs/copy.md): a sentence and a short line. */
export function useBlockedReason(): { why: string; short: string } {
  const c = useConnectivity();
  if (c.readOnly) {
    const until = (c.readOnlyUntil && budgetTime(c.readOnlyUntil)) || dailyResetTime();
    return { why: `View only until ${until}. Nothing is lost.`, short: `View only until ${until}` };
  }
  return { why: 'You’re offline. Connect to the internet to make changes.', short: 'You’re offline' };
}

/** Why changes are off right now, as one sentence. */
export function useBlockedWhy(): string {
  return useBlockedReason().why;
}

export function BlockedAction({
  className,
  track,
  children,
  showWhy,
  whyClassName,
}: {
  className: string;
  track: string;
  children: ReactNode;
  /** Also show the short reason as a line under the action, where there is room for it. */
  showWhy?: boolean;
  whyClassName?: string;
}) {
  const { why, short } = useBlockedReason();
  const whyId = useId();
  const button = (
    <button
      type="button"
      aria-disabled="true"
      aria-describedby={showWhy ? whyId : undefined}
      // On a computer, hovering shows the reason too.
      title={why}
      data-track={track}
      data-testid="blocked-action"
      onClick={() => toast.show({ text: why })}
      className={cx('cursor-not-allowed', className)}
    >
      {children}
    </button>
  );
  if (!showWhy) return button;
  return (
    <>
      {button}
      <span id={whyId} data-testid="blocked-why" className={cx('text-xs', whyClassName)}>
        {short}
      </span>
    </>
  );
}
