// Buttons: the full-width Primary and Secondary, the small Soft pill, and a screen's header action.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useCanWrite } from '../state/connectivity';
import { cx, Icon, type IconName } from './ui';
import { useToastRoomForFab } from './Toast';

// ------------------------------------------------------------------ buttons

/**
 * Hover (only on a computer: Tailwind wraps hover: in @media (hover: hover)) and pressed. not-disabled: also
 * matches links, which are never :disabled.
 */
const PRESS = 'not-disabled:active:opacity-70';

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

/**
 * The full-width main button. `busy`: the step is running (a save, Face ID): it can't be tapped again, keeps
 * its color and shows a spinner before the label. `why`: shown above the button while it is disabled, to say
 * what to do first ("Change the amount to save"); pass '' when no reason applies (busy, offline), so the button
 * keeps its place either way.
 */
export function PrimaryButton({
  className,
  danger,
  busy,
  disabled,
  children,
  why,
  ...p
}: BtnProps & { danger?: boolean; busy?: boolean; why?: string }) {
  if (why !== undefined)
    return (
      <div className="flex w-full flex-col gap-1.5">
        {disabled && !busy && why && (
          <p className="m-0 text-center text-sm text-muted" data-testid="disabled-why">
            {why}
          </p>
        )}
        <PrimaryButton className={className} danger={danger} busy={busy} disabled={disabled} {...p}>
          {children}
        </PrimaryButton>
      </div>
    );
  return (
    <Button
      className={cx(
        // shrink-0: in a scrolling column a button would otherwise be squeezed below its height.
        'flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-lg font-bold',
        danger
          ? 'bg-danger text-on-danger not-disabled:hover:opacity-90'
          : 'bg-accent text-on-accent not-disabled:hover:bg-accent-strong',
        busy ? 'cursor-progress' : 'disabled:bg-disabled-bg disabled:text-muted',
        PRESS,
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...p}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
        />
      )}
      {children}
    </Button>
  );
}

/** The outlined full-width button. `danger`: red text, for "Sign out of this device" and the like. */
export function SecondaryButton({ className, danger, ...p }: BtnProps & { danger?: boolean }) {
  return (
    <Button
      className={cx(
        'flex h-12 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface px-4 text-lg font-bold disabled:text-disabled not-disabled:hover:bg-sunken',
        PRESS,
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
    'hit inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-bold no-underline',
    tone === 'soft' && 'bg-accent-soft text-accent not-disabled:hover:brightness-95',
    tone === 'filled' && 'bg-accent text-on-accent not-disabled:hover:bg-accent-strong',
    tone === 'outline' && 'border border-line-strong bg-surface text-ink-2 not-disabled:hover:bg-sunken',
    'disabled:border-transparent disabled:bg-sunken disabled:text-disabled',
    PRESS,
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
  /** `true` keeps the screen's search. */
  search?: Record<string, unknown> | true;
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
export const textLinkClass = cx(
  'hit inline-flex min-h-9 shrink-0 items-center gap-1 self-start text-md font-bold text-accent no-underline disabled:text-disabled',
  'not-disabled:hover:underline',
  PRESS,
);

export function TextButton({ className, ...p }: BtnProps) {
  return <Button className={cx(textLinkClass, className)} {...p} />;
}

/** The red text that starts a removal: "Delete…", "Remove Groceries…". The "…" means a confirmation follows. */
export function DangerLink({ className, ...p }: BtnProps) {
  return (
    <Button
      className={cx(
        'min-h-10 self-start text-md font-bold text-over-fg disabled:text-disabled not-disabled:hover:underline',
        PRESS,
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
  cancelLabel = 'Keep it',
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
  /** The button that steps back: "Keep it" before a removal. */
  cancelLabel?: string;
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
      className={cx('flex shrink-0 flex-col gap-2.5 rounded-lg bg-over-bg p-3 text-over-fg', className)}
    >
      <span className="text-md leading-snug">{children}</span>
      <div className="flex gap-2">
        <SecondaryButton onClick={onCancel} className="flex-1">
          {cancelLabel}
        </SecondaryButton>
        <PrimaryButton
          danger
          mutates={mutates}
          track={track}
          busy={busy}
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
const ICON_ACTION = cx(
  'hit flex h-11 w-11 items-center justify-center rounded-full text-ink-2 not-disabled:hover:bg-sunken disabled:text-line-strong',
  PRESS,
);

/**
 * A phone screen's one "make a new one" action, in thumb reach: a 56 px round accent button at the bottom right,
 * just above the tab bar (D-71). Put it last in a `relative` screen root; the list under it needs `pb-20` so its
 * last row can scroll clear. On a computer the action stays a `HeaderAction`.
 */
export function FloatingAction({
  icon,
  label,
  to,
  search,
  track,
}: {
  icon: IconName;
  /** The button's accessible name ("Add transaction"). */
  label: string;
  to: string;
  search?: Record<string, string | undefined>;
  track: string;
}) {
  useToastRoomForFab(true);
  return (
    <Link
      to={to}
      search={search}
      data-track={track}
      aria-label={label}
      className={cx(
        'absolute bottom-4 right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-raised',
        PRESS,
      )}
    >
      <Icon name={icon} size={24} stroke={2.4} />
    </Link>
  );
}

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
  iconOnly,
}: {
  icon: IconName;
  label: string;
  /** A phone tab's header: a 44 px icon button named by `label`, so the month stays centered (docs/month-header.md). */
  iconOnly?: boolean;
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
  const inner = iconOnly ? (
    <Icon name={icon} size={22} className={spin ? 'animate-spin' : undefined} />
  ) : (
    <>
      <Icon name={icon} size={16} stroke={2.4} className={spin ? 'animate-spin' : undefined} />
      {label}
    </>
  );
  const cls = iconOnly ? ICON_ACTION : HEADER_ACTION;
  if (iconOnly) ariaLabel ??= label;
  if (to)
    return (
      <Link to={to} search={search} data-track={track} aria-label={ariaLabel} className={cls}>
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
      className={cls}
    >
      {inner}
    </button>
  );
}
