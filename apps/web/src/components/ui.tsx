// Small shared building blocks. Colors are always tokens (src/styles.css), never literals.
import { useEffect, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { CategoryStatus } from '@ledgerline/contracts';
import { useCanWrite } from '../state/connectivity';
import { formatCents } from '../lib/money';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ layout helpers

const DESKTOP_QUERY = '(min-width: 1024px)';
function subscribeDesktop(cb: () => void) {
  const mq = window.matchMedia(DESKTOP_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}

// ------------------------------------------------------------------ icons

const ICONS = {
  chevL: 'M15 6l-6 6 6 6',
  chevR: 'M9 6l6 6-6 6',
  chevD: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 6l-6 6 6 6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 7v6M12 17h.01',
  down: 'M12 5v14M5 12l7 7 7-7',
  up: 'M12 19V5M5 12l7-7 7 7',
  half: 'M12 3a9 9 0 1 0 0 18V3z',
  dash: 'M5 12h14',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  budget: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4',
  activity: 'M4 6h16M4 12h16M4 18h10',
  accounts: 'M3 21h18M5 21V10M19 21V10M9 21v-7M15 21v-7M2 10l10-6 10 6',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  note: 'M4 4h16v12H8l-4 4zM8 9h8M8 12h5',
  wifiOff: 'M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.2-1.6M12 20h.01',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  stroke = 2,
  className,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------ status tones

export type Tone = 'funded' | 'low' | 'over' | 'under' | 'overfunded' | 'none';

export const TONE: Record<Tone, { bg: string; fg: string; bar: string }> = {
  funded: { bg: 'bg-funded-bg', fg: 'text-funded-fg', bar: 'bg-funded-bar' },
  low: { bg: 'bg-low-bg', fg: 'text-low-fg', bar: 'bg-low-bar' },
  over: { bg: 'bg-over-bg', fg: 'text-over-fg', bar: 'bg-over-bar' },
  under: { bg: 'bg-under-bg', fg: 'text-under-fg', bar: 'bg-under-bar' },
  overfunded: { bg: 'bg-overfunded-bg', fg: 'text-overfunded-fg', bar: 'bg-overfunded-bar' },
  none: { bg: 'bg-none-bg', fg: 'text-none-fg', bar: 'bg-none-bar' },
};

export const STATUS: Record<CategoryStatus, { word: string; tone: Tone; icon: IconName }> = {
  funded: { word: 'Funded', tone: 'funded', icon: 'check' },
  invested: { word: 'Invested', tone: 'funded', icon: 'check' },
  low: { word: 'Low', tone: 'low', icon: 'down' },
  overspent: { word: 'Overspent', tone: 'over', icon: 'alert' },
  underfunded: { word: 'Underfunded', tone: 'under', icon: 'half' },
  overfunded: { word: 'Overfunded', tone: 'overfunded', icon: 'up' },
  no_target: { word: 'No target', tone: 'none', icon: 'dash' },
};

export function StatusWord({ word, tone, icon }: { word: string; tone: Tone; icon: IconName }) {
  return (
    <span className={cx('inline-flex items-center gap-1 align-[-2px] font-bold', TONE[tone].fg)}>
      <Icon name={icon} size={13} stroke={2.6} className="shrink-0" />
      {word}
    </span>
  );
}

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'tnum shrink-0 rounded-full px-2.5 py-1 text-[14px] font-bold',
        TONE[tone].bg,
        TONE[tone].fg,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Bar({ percent, tone }: { percent: number; tone: Tone }) {
  return (
    <div aria-hidden="true" className="h-1 overflow-hidden rounded-sm bg-track">
      <div className={cx('h-1 rounded-sm', TONE[tone].bar)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Money({ cents, plus, className }: { cents: number; plus?: boolean; className?: string }) {
  return <span className={cx('tnum', className)}>{formatCents(cents, { plus })}</span>;
}

// ------------------------------------------------------------------ buttons

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Changes data: disabled while offline or read-only. */
  mutates?: boolean;
  track?: string;
};

function useDisabled(mutates: boolean | undefined, disabled: boolean | undefined) {
  const canWrite = useCanWrite();
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
        'flex h-12 w-full items-center justify-center rounded-xl px-4 text-[16px] font-bold',
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
        'flex h-12 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-[16px] font-bold text-ink-2 disabled:text-disabled',
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

export function Chip({
  pressed,
  onClick,
  children,
  track,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  track?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-track={track}
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        'hit flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-[13px] font-semibold',
        pressed ? 'border-inverse bg-inverse text-on-inverse' : 'border-line-strong bg-surface text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function CountBadge({ n, inverted }: { n: number; inverted?: boolean }) {
  return (
    <span
      className={cx(
        'flex h-5 min-w-5 items-center justify-center rounded-[10px] px-1.5 text-[12px] font-bold',
        inverted ? 'bg-on-inverse text-inverse' : 'bg-danger text-on-danger',
      )}
    >
      {n}
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  track,
  cols,
  disabled,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  track?: string;
  cols?: number;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid gap-1 rounded-[10px] bg-sunken p-[3px]"
      style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          data-track={track ? `${track}.${v}` : undefined}
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cx(
            'hit h-9 rounded-lg px-1 text-[14px] font-bold text-ink disabled:text-disabled',
            v === value ? 'bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : 'bg-transparent',
          )}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Radio-like option card (target kinds, close-out choices). */
export function OptionCard({
  selected,
  onClick,
  title,
  desc,
  track,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  desc?: string;
  track?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-track={track}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex min-h-[60px] w-full items-start gap-3 rounded-xl border-2 px-3 py-2.5 text-left text-ink',
        selected ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
          selected ? 'border-accent' : 'border-line-strong',
        )}
      >
        <span className={cx('h-2.5 w-2.5 rounded-full', selected ? 'bg-accent' : 'bg-transparent')} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-bold">{title}</span>
        {desc && <span className="text-[13px] leading-snug text-muted">{desc}</span>}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ cards, sections, fields

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cx('shrink-0 overflow-hidden rounded-[14px] border border-line bg-surface', className)}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  children,
  note,
  action,
}: {
  children: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between px-0.5">
      <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">{children}</h2>
      {note !== undefined && <span className="text-[12px] text-muted">{note}</span>}
      {action}
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-[12px] font-bold uppercase tracking-[0.4px] text-ink-2">{children}</span>;
}

export const inputClass =
  'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[16px] text-ink placeholder:text-faint disabled:bg-sunken disabled:text-muted';

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('flex flex-col gap-1.5 text-[13px] font-semibold text-ink-2', className)}>
      {label}
      {children}
    </label>
  );
}

export function Toggle({
  label,
  help,
  checked,
  onChange,
  track,
  mutates,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  track?: string;
  mutates?: boolean;
}) {
  const off = useDisabled(mutates, false);
  return (
    <label className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2 text-[15px] font-semibold first:border-t-0">
      <span className="flex flex-col gap-px">
        {label}
        {help && <span className="text-[12px] font-normal text-muted">{help}</span>}
      </span>
      <input
        type="checkbox"
        className="hit h-6 w-6 shrink-0 accent-[var(--ll-accent)]"
        checked={checked}
        disabled={off}
        data-track={track}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function Banner({
  tone,
  title,
  children,
  action,
  role = 'status',
}: {
  tone: 'info' | 'warn' | 'neutral' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}) {
  const cls = {
    info: 'bg-info-bg text-info-fg',
    warn: 'bg-warn-bg text-warn-fg border border-warn-border',
    neutral: 'bg-sunken text-none-fg border border-line',
    danger: 'bg-over-bg text-over-fg',
    success: 'bg-success-soft text-funded-fg border border-success-border',
  }[tone];
  return (
    <div
      role={role}
      className={cx('flex shrink-0 items-start gap-3 rounded-xl px-3 py-2.5 text-[13px] leading-snug', cls)}
    >
      <div className="flex flex-1 flex-col gap-0.5">
        {title && <span className="text-[14px] font-bold">{title}</span>}
        {children && <span>{children}</span>}
      </div>
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(id);
  }, []);
  return (
    <p role="status" aria-live="polite" className="m-0 p-6 text-center text-[14px] text-muted">
      {show ? `${label}…` : ''}
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="m-0 rounded-xl bg-over-bg p-3 text-[14px] text-over-fg">
      {error instanceof Error ? error.message : 'Something went wrong.'}
    </p>
  );
}

export function BackHeader({
  title,
  sub,
  onBack,
  backLabel,
  right,
}: {
  title: string;
  sub?: string;
  onBack: () => void;
  backLabel: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-line bg-surface py-2 pl-1 pr-4">
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className="flex h-11 w-11 items-center justify-center text-ink-2"
      >
        <Icon name="back" size={22} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="m-0 truncate text-[19px] font-bold">{title}</h1>
        {sub && <span className="text-[13px] text-muted">{sub}</span>}
      </div>
      {right}
    </header>
  );
}

export function badgeClass(kind: string | null): string {
  switch (kind) {
    case 'alert':
      return 'bg-under-bg text-under-fg';
    case 'match':
      return 'bg-success-soft text-funded-fg';
    case 'est':
      return 'bg-info-bg text-info-fg';
    case 'owed':
      return 'bg-owed-bg text-owed-fg';
    default:
      return 'bg-sunken text-none-fg';
  }
}
