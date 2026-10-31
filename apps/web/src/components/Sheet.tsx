// Phone: a sheet slides up over the screen (scrim above it closes it). Desktop (>= 1024 px): the same content
// opens in the right-hand side panel that AppShell reserves next to the page.
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, Icon, useIsDesktop } from './ui';
import { usage } from '../usage/tracker';

export const PanelSlotContext = createContext<HTMLElement | null>(null);

export interface SheetProps {
  label: string;
  /** Usage id for back-outs, e.g. "category". */
  track: string;
  onClose: () => void;
  /** Phone only: space above the sheet (32, 56 or 120 px, the sheet filling the rest), or 'auto' to fit content. */
  gap?: 'small' | 'medium' | 'large' | 'auto';
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Close link label for screen readers. */
  closeLabel?: string;
}

export function Sheet({ label, track, onClose, gap = 'medium', header, footer, children, closeLabel = 'Close' }: SheetProps) {
  const desktop = useIsDesktop();
  const slot = useContext(PanelSlotContext);
  const ref = useRef<HTMLElement>(null);
  const close = () => {
    usage.backOut(track);
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const body = (
    <section
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      className={cx(
        'flex min-h-0 flex-col bg-surface text-ink outline-none',
        desktop ? 'h-full' : 'll-sheet max-h-full rounded-t-[20px]',
        !desktop && (gap === 'auto' ? 'flex-none' : 'flex-1'),
      )}
    >
      {!desktop && <div aria-hidden="true" className="mt-2 h-1 w-10 shrink-0 self-center rounded-sm bg-line-strong" />}
      <div className="flex shrink-0 items-start justify-between pb-1 pl-4 pr-2 pt-2">
        <div className="min-w-0 flex-1">{header}</div>
        <button type="button" onClick={close} aria-label={closeLabel} className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-2">
          <Icon name="close" size={22} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-3 pt-2">{children}</div>
      {footer && <div className="shrink-0 border-t border-line px-4 pb-6 pt-3">{footer}</div>}
    </section>
  );

  if (desktop) {
    if (!slot) return body;
    return createPortal(body, slot);
  }

  const top = { small: 'h-8 shrink-0', medium: 'h-14 shrink-0', large: 'h-[120px] shrink-0', auto: 'min-h-14 flex-1' }[gap];
  return createPortal(
    <div className="fixed inset-0 z-40 flex flex-col">
      <div className="ll-scrim absolute inset-0 bg-scrim" aria-hidden="true" />
      <button type="button" aria-label={`${closeLabel} and go back`} onClick={close} className={cx('relative block w-full', top)} tabIndex={-1} />
      <div className={cx('relative flex min-h-0 flex-col', gap === 'auto' ? 'max-h-[calc(100%-56px)]' : 'flex-1')}>{body}</div>
    </div>,
    document.body,
  );
}

/** Header block used at the top of most sheets. */
export function SheetTitle({ title, sub, tag, tagClass }: { title: ReactNode; sub?: ReactNode; tag?: ReactNode; tagClass?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      {tag && <span className={cx('text-[13px] font-bold', tagClass ?? 'text-muted')}>{tag}</span>}
      <h1 className="m-0 text-[20px] font-bold leading-tight">{title}</h1>
      {sub && <span className="text-[13px] text-muted">{sub}</span>}
    </div>
  );
}
