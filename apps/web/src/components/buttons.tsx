// Buttons: the full-width Primary and Secondary, the small Soft pill, and a screen's header action.
import type { ButtonHTMLAttributes } from 'react';
import { Link } from '@tanstack/react-router';
import { useCanWrite } from '../state/connectivity';
import { cx, Icon, type IconName } from './ui';

// ------------------------------------------------------------------ buttons

export type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Changes data: disabled while offline or read-only. 'offline': also works offline with the copy (D-45). */
  mutates?: boolean | 'offline';
  track?: string;
};

export function useDisabled(mutates: boolean | 'offline' | undefined, disabled: boolean | undefined) {
  const canWrite = useCanWrite({ offline: mutates === 'offline' });
  return !!disabled || (!!mutates && !canWrite);
}

export function Button({
  mutates,
  track,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: BtnProps) {
  const off = useDisabled(mutates, disabled);
  return (
    <button
      type={type}
      data-track={track}
      disabled={off}
      aria-disabled={off || undefined}
      className={cx('disabled:cursor-not-allowed', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function PrimaryButton({ className, danger, ...p }: BtnProps & { danger?: boolean }) {
  return (
    <Button
      className={cx(
        // shrink-0: in a scrolling column a button would otherwise be squeezed below its height.
        'flex h-12 w-full shrink-0 items-center justify-center rounded-xl px-4 text-[16px] font-bold',
        danger ? 'bg-danger text-on-danger' : 'bg-accent text-on-accent',
        'disabled:bg-disabled-bg disabled:text-muted',
        className,
      )}
      {...p}
    />
  );
}

export function SecondaryButton({ className, ...p }: BtnProps) {
  return (
    <Button
      className={cx(
        'flex h-12 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-[16px] font-bold text-ink-2 disabled:text-disabled',
        className,
      )}
      {...p}
    />
  );
}

/** The soft blue pill used for one-tap fixes ("Cover $18.25", "Match", "Edit"). */
export function SoftButton({ className, ...p }: BtnProps) {
  return (
    <Button
      className={cx(
        'hit h-9 shrink-0 rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent disabled:bg-sunken disabled:text-disabled',
        className,
      )}
      {...p}
    />
  );
}

const HEADER_ACTION =
  'hit flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline disabled:opacity-50';

/**
 * The one style for a screen's own action in its header (Add, Refresh), the same on phone and desktop: the soft
 * pill with an icon and a word. Filled blue is kept for the main button of a sheet or form (Save, Assign).
 */
export function HeaderAction({
  icon,
  label,
  to,
  onClick,
  disabled,
  spin,
  track,
  ariaLabel,
}: {
  icon: IconName;
  label: string;
  /** A link (opens a sheet or page) or, without it, a button. */
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Turns the icon while the action runs (Refresh). */
  spin?: boolean;
  track: string;
  ariaLabel?: string;
}) {
  const inner = (
    <>
      <Icon name={icon} size={16} stroke={2.4} className={spin ? 'animate-spin' : undefined} />
      {label}
    </>
  );
  if (to)
    return (
      <Link to={to} data-track={track} aria-label={ariaLabel} className={HEADER_ACTION}>
        {inner}
      </Link>
    );
  return (
    <button
      type="button"
      data-track={track}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={HEADER_ACTION}
    >
      {inner}
    </button>
  );
}
