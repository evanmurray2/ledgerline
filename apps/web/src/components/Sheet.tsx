// Phone: a sheet slides up over the screen, which stays visible but dimmed behind it. Tapping above it or
// swiping its top edge down closes it. Desktop (>= 1024 px): the same content opens in the right-hand side
// panel that AppShell reserves next to the page. A `modal` sheet (a picker opened from inside another sheet)
// always opens over everything, also on desktop.
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx, Icon, useIsDesktop } from './ui';
import { usage } from '../usage/tracker';

export const PanelSlotContext = createContext<HTMLElement | null>(null);

// ------------------------------------------------------------------ open sheets

/** Sheets covering the screen, newest last. Escape closes only the newest; AppShell makes the rest inert. */
const stack: number[] = [];
let nextId = 1;
const modalListeners = new Set<() => void>();
function emitModal() {
  for (const l of modalListeners) l();
}
function subscribeModal(cb: () => void) {
  modalListeners.add(cb);
  return () => {
    modalListeners.delete(cb);
  };
}
/** True while a sheet covers the screen (phone, or a modal sheet on desktop). */
export function useModalOpen(): boolean {
  return useSyncExternalStore(
    subscribeModal,
    () => stack.length > 0,
    () => false,
  );
}

/** Drag distance (px) past which letting go closes the sheet. */
const SWIPE_CLOSE = 90;

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
  /** Open over everything, also on desktop (for a picker opened from inside another sheet). */
  modal?: boolean;
}

export function Sheet({
  label,
  track,
  onClose,
  gap = 'medium',
  header,
  footer,
  children,
  closeLabel = 'Close',
  modal = false,
}: SheetProps) {
  const isDesktop = useIsDesktop();
  // A modal sheet is drawn the phone way (over everything) on every screen size.
  const desktop = isDesktop && !modal;
  const covers = !desktop;
  const slot = useContext(PanelSlotContext);
  const ref = useRef<HTMLElement>(null);
  const [id] = useState(() => nextId++);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const close = () => {
    usage.backOut(track);
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (covers) {
      stack.push(id);
      emitModal();
    }
    const onKey = (e: KeyboardEvent) => {
      // Only the newest sheet answers, so Escape in a picker doesn't also close the sheet under it.
      if (e.key !== 'Escape') return;
      const top = stack[stack.length - 1];
      if (covers ? top === id : top === undefined) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const i = stack.indexOf(id);
      if (i >= 0) {
        stack.splice(i, 1);
        emitModal();
      }
    };
  }, [covers, id]);

  // Swipe down on the top edge (handle and title) to close, as the handle suggests.
  const onDragStart = (e: ReactPointerEvent) => {
    if (desktop || e.pointerType === 'mouse') return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    dragFrom.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    if (dragFrom.current === null) return;
    setDrag(Math.max(0, e.clientY - dragFrom.current));
  };
  const onDragEnd = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (drag > SWIPE_CLOSE) close();
    else setDrag(0);
  };

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const body = (
    <section
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal={covers || undefined}
      aria-label={label}
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
      className={cx(
        'flex min-h-0 flex-col bg-surface text-ink outline-none',
        desktop || isDesktop ? 'h-full' : 'll-sheet max-h-full rounded-t-xl shadow-overlay',
        !desktop && (gap === 'auto' ? 'flex-none' : 'flex-1'),
        !desktop && !drag && 'transition-transform duration-150',
      )}
    >
      <div
        className={cx('flex shrink-0 flex-col', !desktop && 'touch-none')}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {!desktop && (
          <div aria-hidden="true" className="mt-2 h-1 w-10 shrink-0 self-center rounded-sm bg-line-strong" />
        )}
        <div className="flex shrink-0 items-start justify-between pb-1 pl-4 pr-2 pt-2">
          <div className="min-w-0 flex-1">{header}</div>
          <button
            type="button"
            onClick={close}
            aria-label={closeLabel}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-ink-2"
          >
            <Icon name="close" size={22} />
          </button>
        </div>
      </div>
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-2',
          footer || desktop ? 'pb-3' : 'safe-pad',
        )}
      >
        {children}
      </div>
      {footer && (
        <div className={cx('shrink-0 border-t border-line px-4 pt-3', desktop ? 'pb-6' : 'safe-foot')}>
          {footer}
        </div>
      )}
    </section>
  );

  if (desktop) {
    if (!slot) return body;
    return createPortal(body, slot);
  }

  const top = {
    small: 'h-8 shrink-0',
    medium: 'h-14 shrink-0',
    large: 'h-[120px] shrink-0',
    auto: 'min-h-14 flex-1',
  }[gap];
  return createPortal(
    <div className={cx('safe-top fixed inset-0 z-40 flex flex-col', isDesktop && 'items-end')}>
      <div
        className="ll-scrim absolute inset-0 bg-scrim-a"
        aria-hidden="true"
        onClick={isDesktop ? close : undefined}
      />
      <button
        type="button"
        aria-label={`${closeLabel} and go back`}
        onClick={close}
        className={cx('relative block w-full', top, isDesktop && 'hidden')}
        tabIndex={-1}
      />
      <div
        className={cx(
          'relative flex min-h-0 flex-col',
          isDesktop
            ? 'h-full w-[400px] border-l border-line'
            : gap === 'auto'
              ? 'max-h-[calc(100%-56px)]'
              : 'flex-1',
        )}
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Header block used at the top of most sheets. With `amount` (the transaction sheets), the amount is the
 * heading: tag line (13 px bold), amount (28 px), sub line (14 px muted), in that order, and `title` is left out.
 */
export function SheetTitle({
  title,
  sub,
  tag,
  tagClass,
  amount,
  amountClass,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  tag?: ReactNode;
  tagClass?: string;
  amount?: ReactNode;
  amountClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {tag && <span className={cx('text-sm font-bold', tagClass ?? 'text-muted')}>{tag}</span>}
      {amount !== undefined ? (
        <h1 className={cx('tnum m-0 text-4xl font-bold leading-tight', amountClass)}>{amount}</h1>
      ) : (
        <h1 className="m-0 text-2xl font-bold leading-tight">{title}</h1>
      )}
      {sub && <span className={cx('text-muted', amount !== undefined ? 'text-md' : 'text-sm')}>{sub}</span>}
    </div>
  );
}
