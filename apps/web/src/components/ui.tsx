// Small shared building blocks. Colors, sizes, corners and shadows are always tokens (src/styles.css,
// docs/design-system.md), never literals.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { Link } from '@tanstack/react-router';
import type { CategoryStatus } from '@ledgerline/contracts';
import { formatCents } from '../lib/money';
import { errorMessage } from '../api/client';

export * from './buttons';
export * from './headers';
export * from './fields';

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

/** Every desktop screen's content column: one width, centered, so headers and lists line up across screens. */
export const DESKTOP_WIDTH = 'mx-auto w-full max-w-[960px]';

/** True while the user is typing somewhere, so single-key shortcuts don't fire. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/**
 * Single-key desktop shortcuts ("/" for search, "[" and "]" for months). Ignored while typing, with a modifier
 * held, or while a sheet covers the screen (the page under it is inert then).
 */
export function useShortcuts(keys: Record<string, () => void>, enabled = true) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const fn = ref.current[e.key];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

// ------------------------------------------------------------------ icons

// Icon sizes: header buttons 22 px, row chevrons (a row that opens a page) 18 px in text-faint, icons in a
// Banner 18 px, inline status icons 14 or 16 px.
const ICONS = {
  chevL: 'M15 6l-6 6 6 6',
  chevR: 'M9 6l6 6-6 6',
  chevD: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M15 6l-6 6 6 6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  pencil: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM12 12h.01',
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
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M5 8h14M5 12h14M5 16h14',
  pin: 'M9 3h6M10 3v6l-4 5h12l-4-5V3M12 14v7',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  swap: 'M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4',
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
        'tnum shrink-0 rounded-full px-2.5 py-1 text-md font-bold',
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
    <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-sm bg-track">
      <div className={cx('h-1.5 rounded-sm', TONE[tone].bar)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Money({ cents, plus, className }: { cents: number; plus?: boolean; className?: string }) {
  return <span className={cx('tnum', className)}>{formatCents(cents, { plus })}</span>;
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
        'hit flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-semibold',
        pressed ? 'border-inverse bg-inverse text-on-inverse' : 'border-line-strong bg-surface text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * A count of to-dos. Gray unless `danger`: red is kept for real problems (overspending, broken links).
 * size 'sm': the smaller one on a phone tab icon.
 */
export function CountBadge({
  n,
  inverted,
  danger,
  size,
  className,
}: {
  n: number;
  inverted?: boolean;
  danger?: boolean;
  size?: 'sm';
  className?: string;
}) {
  return (
    <span
      aria-hidden={size === 'sm' || undefined}
      className={cx(
        'flex items-center justify-center rounded-full text-xs font-bold',
        size === 'sm' ? 'h-[18px] min-w-[18px] px-[5px]' : 'h-5 min-w-5 px-1.5',
        className,
        inverted
          ? 'bg-on-inverse text-inverse'
          : danger
            ? 'bg-danger text-on-danger'
            : 'bg-count-bg text-count-fg',
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
      className="grid gap-1 rounded-lg bg-sunken p-[3px]"
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
            'hit h-9 rounded-md px-1 text-md font-bold text-ink disabled:text-disabled',
            v === value ? 'bg-surface shadow-low' : 'bg-transparent',
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
        'flex min-h-[60px] w-full items-start gap-3 rounded-lg border-2 px-3 py-2.5 text-left text-ink',
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
        <span className="text-base font-bold">{title}</span>
        {desc && <span className="text-sm leading-snug text-muted">{desc}</span>}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ cards, sections, fields

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx('shrink-0 overflow-hidden rounded-lg border border-line bg-surface', className)}>
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
      <h2 className="m-0 text-sm font-bold uppercase tracking-caps text-ink-2">{children}</h2>
      {note !== undefined && <span className="text-xs text-muted">{note}</span>}
      {action}
    </div>
  );
}

/**
 * The one note or warning card. Tones: info, warn (needs you: sign in again), neutral, danger (over: overspent,
 * negative), success (done). `icon` leads the card; `to` makes the whole card a link (repair, match).
 */
export function Banner({
  tone,
  title,
  children,
  action,
  icon,
  to,
  track,
  role = 'status',
  className,
}: {
  tone: 'info' | 'warn' | 'neutral' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
  to?: string;
  track?: string;
  role?: 'status' | 'alert';
  className?: string;
}) {
  const cls = {
    info: 'bg-info-bg text-info-fg border border-transparent',
    warn: 'bg-warn-bg text-warn-fg border border-warn-border',
    neutral: 'bg-sunken text-none-fg border border-line',
    danger: 'bg-over-bg text-over-fg border border-transparent',
    success: 'bg-success-soft text-funded-fg border border-success-border',
  }[tone];
  const body = (
    <>
      {icon && <Icon name={icon} size={18} stroke={2.4} className="mt-px shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <span className="text-md font-bold">{title}</span>}
        {children && <span>{children}</span>}
      </div>
      {to && <Icon name="chevR" size={18} className="mt-px shrink-0 opacity-70" />}
      {action}
    </>
  );
  const box = cx(
    'flex shrink-0 items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm leading-snug no-underline',
    cls,
    className,
  );
  if (to)
    return (
      <Link to={to} data-track={track} className={box}>
        {body}
      </Link>
    );
  return (
    <div role={role} className={box}>
      {body}
    </div>
  );
}

/** A neutral "nothing here" line: 14 px muted, centered. `inCard`: inside a Card, which draws the border. */
export function EmptyNote({ children, inCard }: { children: ReactNode; inCard?: boolean }) {
  return <p className={cx('m-0 p-4 text-center text-md text-muted', !inCard && 'shrink-0')}>{children}</p>;
}

/**
 * The scrolling content under a screen's header: phone px-4 pt-3 pb-6, desktop px-6 pt-5 pb-8 in the content
 * column, blocks gap-3 apart. Pass `scrollRef` for pull to sync.
 */
export function ScreenBody({
  children,
  scrollRef,
  className,
  innerRef,
}: {
  children: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  innerRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  const desktop = useIsDesktop();
  return (
    <div
      ref={scrollRef}
      className={cx(
        'relative flex min-h-0 flex-1 flex-col overflow-y-auto',
        desktop ? 'px-6 pb-8 pt-5' : 'px-4 pb-6 pt-3',
      )}
    >
      <div ref={innerRef} className={cx('flex flex-col gap-3', desktop && DESKTOP_WIDTH, className)}>
        {children}
      </div>
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
    <p role="status" aria-live="polite" className="m-0 p-6 text-center text-md text-muted">
      {show ? `${label}…` : ''}
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <p role="alert" className="m-0 rounded-lg bg-over-bg p-3 text-md text-over-fg">
      {errorMessage(error)}
    </p>
  );
}

export function badgeClass(kind: string | null): string {
  switch (kind) {
    case 'alert':
      return 'bg-under-bg text-under-fg';
    case 'match':
      // Waiting to match is a to-do, not a success: the Owed to you color, never green.
      return 'bg-owed-bg text-owed-fg';
    case 'est':
      return 'bg-info-bg text-info-fg';
    case 'owed':
      return 'bg-owed-bg text-owed-fg';
    default:
      return 'bg-sunken text-none-fg';
  }
}
