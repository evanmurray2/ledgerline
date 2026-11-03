// Buttons: the full-width Primary and Secondary, the small Soft pill, and a screen's header action.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
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

/** The outlined full-width button. `danger`: red text, for "Sign out of this device" and the like. */
export function SecondaryButton({ className, danger, ...p }: BtnProps & { danger?: boolean }) {
  return (
    <Button
      className={cx(
        'flex h-12 shrink-0 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-[16px] font-bold disabled:text-disabled',
        danger ? 'text-over-fg' : 'text-ink-2',
        className,
      )}
      {...p}
    />
  );
}

/**
 * The small pill (h-9, 13 px) for one-tap actions on a row or card ("Cover $18.25", "Match", "Undo").
 * soft: the usual one; filled: the one main step in a card ("Fund all"); outline: a quieter second step.
 * Every tone looks the same when disabled.
 */
export type PillTone = 'soft' | 'filled' | 'outline';
export function softButtonClass(tone: PillTone = 'soft'): string {
  return cx(
    'hit inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-bold no-underline',
    tone === 'soft' && 'bg-accent-soft text-accent',
    tone === 'filled' && 'bg-accent text-on-accent',
    tone === 'outline' && 'border border-line-strong bg-surface text-ink-2',
    'disabled:border-transparent disabled:bg-sunken disabled:text-disabled',
  );
}

export function SoftButton({ className, tone, ...p }: BtnProps & { tone?: PillTone }) {
  return <Button className={cx(softButtonClass(tone), className)} {...p} />;
}

/** A SoftButton that goes somewhere (a sheet or page). */
export function SoftLink({
  to,
  search,
  tone,
  track,
  className,
  children,
}: {
  to: string;
  search?: Record<string, unknown>;
  tone?: PillTone;
  track?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} search={search} data-track={track} className={cx(softButtonClass(tone), className)}>
      {children}
    </Link>
  );
}

/** A text button or link: 14 px bold, accent ("Show archived", "Select", "Add line"). */
export const textLinkClass =
  'hit inline-flex min-h-9 shrink-0 items-center gap-1 self-start text-[14px] font-bold text-accent no-underline disabled:text-disabled';

export function TextButton({ className, ...p }: BtnProps) {
  return <Button className={cx(textLinkClass, className)} {...p} />;
}

/** The red text that starts a removal: "Delete…", "Remove Groceries…". The "…" means a confirmation follows. */
export function DangerLink({ className, ...p }: BtnProps) {
  return (
    <Button
      className={cx(
        'min-h-10 self-start text-[14px] font-bold text-over-fg disabled:text-disabled',
        className,
      )}
      {...p}
    />
  );
}

/**
 * The one way the app asks before removing something: an inline red card with Keep it and a red button.
 * Used after a DangerLink ("Remove X…").
 */
export function ConfirmInline({
  label,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  track,
  mutates = true,
  busy,
  className,
}: {
  /** For screen readers, e.g. "Remove Groceries". */
  label: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  track?: string;
  mutates?: boolean | 'offline';
  busy?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={label}
      className={cx('flex shrink-0 flex-col gap-2.5 rounded-xl bg-over-bg p-3 text-over-fg', className)}
    >
      <span className="text-[14px] leading-snug">{children}</span>
      <div className="flex gap-2">
        <SecondaryButton onClick={onCancel} className="flex-1">
          Keep it
        </SecondaryButton>
        <PrimaryButton
          danger
          mutates={mutates}
          track={track}
          disabled={busy}
          onClick={onConfirm}
          className="flex-1"
        >
          {confirmLabel}
        </PrimaryButton>
      </div>
    </div>
  );
}

const HEADER_ACTION = softButtonClass();

/**
 * The one style for a screen's own action in its header (Add, Refresh), the same on phone and desktop: the soft
 * pill with an icon and a word. Filled blue is kept for the main button of a sheet or form (Save, Assign).
 */
export function HeaderAction({
  icon,
  label,
  to,
  search,
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
  search?: Record<string, string | undefined>;
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
      <Link to={to} search={search} data-track={track} aria-label={ariaLabel} className={HEADER_ACTION}>
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
