// A grayed-out action that still says why when tapped: view only until the daily limit resets, or offline before
// the budget is open on this device. Used where a link-styled action (Assign) has no room for a line of reason text.
import type { ReactNode } from 'react';
import { useConnectivity } from '../state/connectivity';
import { budgetTime } from '../lib/dates';
import { dailyResetTime } from '../api/client';
import { toast } from './Toast';
import { cx } from './ui';

/** Why changes are off right now, in the words of the status banners (docs/copy.md). */
export function useBlockedWhy(): string {
  const c = useConnectivity();
  if (c.readOnly) {
    const until = (c.readOnlyUntil && budgetTime(c.readOnlyUntil)) || dailyResetTime();
    return `View only until ${until}. Nothing is lost.`;
  }
  return 'You’re offline. Connect to the internet to make changes.';
}

export function BlockedAction({
  className,
  track,
  children,
}: {
  className: string;
  track: string;
  children: ReactNode;
}) {
  const why = useBlockedWhy();
  return (
    <button
      type="button"
      aria-disabled="true"
      data-track={track}
      data-testid="blocked-action"
      onClick={() => toast.show({ text: why })}
      className={cx('cursor-not-allowed', className)}
    >
      {children}
    </button>
  );
}
