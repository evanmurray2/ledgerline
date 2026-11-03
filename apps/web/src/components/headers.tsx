// Screen headers, one set for every screen:
// - desktop: DesktopHeader (64 px), or BackHeader, which draws the same header with a Back button;
// - phone: PhoneHeader on a tab's own screen (56 px, 22 px title) and BackHeader on a screen opened from one
//   (56 px, 19 px title after the Back button). Both take `below` for search and filter chips.
// Header icon buttons are 44 px with a 22 px icon; a screen's own action is a HeaderAction (buttons.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { cx, DESKTOP_WIDTH, Icon, useIsDesktop } from './ui';

/**
 * The one desktop page header: 64 px, title on the left, actions on the right, and an optional second row
 * (search, filters). Both rows line up with the content column unless `wide` (Settings has its own panes).
 */
export function DesktopHeader({
  title,
  right,
  below,
  wide,
}: {
  title: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
  wide?: boolean;
}) {
  return (
    <header className="@container shrink-0 border-b border-line bg-surface px-6">
      <div className={cx('flex h-16 items-center justify-between gap-3', !wide && DESKTOP_WIDTH)}>
        {typeof title === 'string' ? <h1 className="m-0 truncate text-[22px] font-bold">{title}</h1> : title}
        {right && <div className="flex min-w-0 shrink-0 items-center gap-2">{right}</div>}
      </div>
      {below && <div className={cx('flex flex-col gap-2.5 pb-3', !wide && DESKTOP_WIDTH)}>{below}</div>}
    </header>
  );
}

/** The one ⋯ menu: a short list of links (`to`) or actions (`onClick`), for header actions that don't fit. */
export type MenuItem = {
  name: string;
  track?: string;
  /** Red, for a removal. */
  danger?: boolean;
} & (
  | { to: string; search?: Record<string, string | undefined>; onClick?: never }
  | { onClick: () => void; to?: never }
);

export function OverflowMenu({
  label = 'More',
  items,
  className,
  track,
}: {
  label?: string;
  items: MenuItem[];
  className?: string;
  /** Usage id for opening the menu. */
  track?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        data-track={track}
        onClick={() => setOpen(!open)}
        className="hit flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-sunken"
      >
        <Icon name="more" size={22} stroke={3} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-30 flex min-w-[200px] flex-col rounded-xl border border-line bg-surface py-1 shadow-[0_8px_24px_var(--ll-shadow)]">
          {items.map((i) => {
            const cls = cx(
              'flex h-11 w-full items-center px-3.5 text-left text-[15px] font-semibold no-underline hover:bg-surface-2',
              i.danger ? 'text-over-fg' : 'text-ink',
            );
            return i.to !== undefined ? (
              <Link
                key={i.name}
                to={i.to}
                search={i.search}
                data-track={i.track}
                onClick={() => setOpen(false)}
                className={cls}
              >
                {i.name}
              </Link>
            ) : (
              <button
                key={i.name}
                type="button"
                data-track={i.track}
                onClick={() => {
                  setOpen(false);
                  i.onClick();
                }}
                className={cls}
              >
                {i.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A tab's own screen on the phone (Activity, Accounts, Reports): 56 px, 22 px title, actions on the right. */
export function PhoneHeader({
  title,
  right,
  below,
}: {
  title: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <header className="shrink-0 border-b border-line bg-surface">
      <div className="flex min-h-14 items-center justify-between gap-2 pl-4 pr-2">
        {typeof title === 'string' ? <h1 className="m-0 truncate text-[22px] font-bold">{title}</h1> : title}
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
      {below && <div className="flex flex-col gap-2.5 px-4 pb-2.5">{below}</div>}
    </header>
  );
}

/** A screen opened from another one, with Back. Phone: 56 px, 19 px title. Desktop: the 64 px DesktopHeader. */
export function BackHeader({
  title,
  sub,
  onBack,
  backLabel,
  right,
  below,
}: {
  title: string;
  sub?: string;
  onBack: () => void;
  backLabel: string;
  right?: ReactNode;
  /** Search and filter chips under the title row. */
  below?: ReactNode;
}) {
  const desktop = useIsDesktop();
  const inner = (
    <>
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className={cx('flex h-11 w-11 shrink-0 items-center justify-center text-ink-2', desktop && '-ml-3')}
      >
        <Icon name="back" size={22} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className={cx('m-0 truncate font-bold', desktop ? 'text-[22px]' : 'text-[19px]')}>{title}</h1>
        {sub && <span className="truncate text-[13px] text-muted">{sub}</span>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
    </>
  );
  // Desktop: the same 64 px header as every other screen, lined up with the content column.
  if (desktop)
    return (
      <header className="@container shrink-0 border-b border-line bg-surface px-6">
        <div className={cx(DESKTOP_WIDTH, 'flex min-h-16 items-center gap-1 py-1')}>{inner}</div>
        {below && <div className={cx(DESKTOP_WIDTH, 'flex flex-col gap-2.5 pb-3')}>{below}</div>}
      </header>
    );
  return (
    <header className="shrink-0 border-b border-line bg-surface">
      <div className="flex min-h-14 items-center gap-1 pl-1 pr-2">{inner}</div>
      {below && <div className="flex flex-col gap-2.5 px-4 pb-2.5">{below}</div>}
    </header>
  );
}
