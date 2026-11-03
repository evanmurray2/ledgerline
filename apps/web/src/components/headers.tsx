// Screen headers: the desktop header, the phone header with Back, and the ⋯ menu.
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

/** A "More" button with a short list of links, for header actions that don't fit. */
export function OverflowMenu({
  label = 'More',
  items,
  className,
}: {
  label?: string;
  items: { to: string; search?: Record<string, string | undefined>; name: string; track?: string }[];
  className?: string;
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
        onClick={() => setOpen(!open)}
        className="hit flex h-9 w-9 items-center justify-center rounded-full text-ink-2 hover:bg-sunken"
      >
        <Icon name="more" size={22} stroke={3} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 flex min-w-[180px] flex-col rounded-xl border border-line bg-surface py-1 shadow-[0_8px_24px_var(--ll-shadow)]">
          {items.map((i) => (
            <Link
              key={i.to}
              to={i.to}
              search={i.search}
              data-track={i.track}
              onClick={() => setOpen(false)}
              className="flex h-10 items-center px-3.5 text-[14px] font-semibold text-ink no-underline hover:bg-surface-2"
            >
              {i.name}
            </Link>
          ))}
        </div>
      )}
    </div>
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
      {right}
    </>
  );
  // Desktop: the same 64 px header as every other screen, lined up with the content column.
  if (desktop)
    return (
      <header className="shrink-0 border-b border-line bg-surface px-6">
        <div className={cx(DESKTOP_WIDTH, 'flex min-h-16 items-center gap-1 py-1')}>{inner}</div>
      </header>
    );
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-line bg-surface py-2 pl-1 pr-4">
      {inner}
    </header>
  );
}
