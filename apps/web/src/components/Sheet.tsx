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
import { closingSheet } from '../lib/back';

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

/**
 * The part of the screen the keyboard leaves visible, while the keyboard is up (null otherwise). iOS puts the
 * keyboard over the page without making it shorter, so a sheet fixed to the bottom would sit behind it.
 */
function useVisibleArea(active: boolean): { top: number; height: number } | null {
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!active || !vv) return;
    const update = () => {
      // A few px of difference is the browser's toolbar, not a keyboard.
      const covered = window.innerHeight - vv.height > 80;
      setArea((old) => {
        if (!covered) return null;
        if (old && old.top === vv.offsetTop && old.height === vv.height) return old;
        return { top: vv.offsetTop, height: vv.height };
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setArea(null);
    };
  }, [active]);
  return area;
}

/** What Tab can reach inside a sheet. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
    // Back to the screen under it, with no new page in the history (lib/back.ts).
    closingSheet(onClose);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (covers) {
      stack.push(id);
      emitModal();
    }
    const onKey = (e: KeyboardEvent) => {
      const top = stack[stack.length - 1];
      // Tab stays inside a sheet that covers the screen: it goes round from the last control to the first.
      if (e.key === 'Tab' && covers && top === id && ref.current) {
        const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => el.getClientRects().length > 0,
        );
        const first = all[0];
        const last = all[all.length - 1];
        const at = document.activeElement;
        if (!first || !last) return;
        if (!ref.current.contains(at)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (at === first || at === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // Only the newest sheet answers, so Escape in a picker doesn't also close the sheet under it.
      if (e.key !== 'Escape') return;
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

  // Focus the sheet so Escape and screen readers start here, unless a field in it took focus first (the
  // category search does, to open the keyboard).
  // On close, focus goes back to what opened the sheet (a row, a button), once the page under it is no longer
  // inert, unless something else took focus meanwhile.
  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.contains(document.activeElement)) el.focus();
    return () => {
      if (!opener || opener === document.body || el?.contains(opener)) return;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        const free = !now || now === document.body || !now.isConnected || (el?.contains(now) ?? false);
        if (free && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  const visible = useVisibleArea(covers && !isDesktop);

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
        // A phone on its side: the sheet scrolls as one, so its footer can't cover the field being typed in.
        !desktop && 'short:overflow-y-auto',
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
          'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden px-4 pt-2',
          !desktop && 'short:flex-none short:overflow-visible',
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
    small: 'h-8 shrink-0 short:h-2',
    medium: 'h-14 shrink-0 short:h-2',
    large: 'h-[120px] shrink-0 short:h-2',
    auto: 'min-h-14 flex-1 short:min-h-2',
  }[gap];
  return createPortal(
    <div
      className={cx('safe-top fixed inset-0 z-40 flex flex-col', isDesktop && 'items-end')}
      style={visible ? { top: visible.top, height: visible.height, bottom: 'auto' } : undefined}
    >
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
        <h1 className="m-0 text-2xl font-bold leading-tight wrap-anywhere">{title}</h1>
      )}
      {sub && <span className={cx('text-muted', amount !== undefined ? 'text-md' : 'text-sm')}>{sub}</span>}
    </div>
  );
}
