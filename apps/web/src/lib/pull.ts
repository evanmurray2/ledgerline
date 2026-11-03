// Pull-to-refresh for a scrolling area (design.md, When data updates). The page itself doesn't scroll or bounce on a
// phone, so the gesture is watched on the screen's own scroll container: a pull down from the top past PULL_TRIGGER
// starts onRefresh once it is released.
//
// The pull follows the finger frame by frame without React: the content and the indicator are moved with transforms
// on their elements (`body` and `indicator`), and React only re-renders when the pull crosses the trigger, when the
// refresh starts and when it ends. While it runs the indicator stays in view, so there's no gap between letting go
// and seeing it work, and onRefresh can return a short note ("Up to date") to show before it tucks away.
import { useEffect, useRef, useState, type RefObject } from 'react';

/** How far (after resistance) the content has to be pulled before releasing starts a refresh: about 110 px of finger. */
export const PULL_TRIGGER = 56;
/** Where the content rests while the refresh runs, with the indicator showing above it. */
export const PULL_HOLD = 44;
const PULL_MAX = 120;
const NOTE_MS = 1_200;
const SETTLE = 'transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 240ms ease-out';

/** Rubber band: follows the finger at first, then gets harder to pull, never past PULL_MAX. */
export function resist(dy: number): number {
  return dy <= 0 ? 0 : PULL_MAX * (1 - Math.exp((-0.7 * dy) / PULL_MAX));
}

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<string | undefined>,
  enabled: boolean,
): {
  armed: boolean;
  busy: boolean;
  note: string | null;
  run: () => Promise<void>;
  body: RefObject<HTMLDivElement | null>;
  indicator: RefObject<HTMLDivElement | null>;
} {
  const body = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busyRef = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  /** Moves the content down by `dist` and slides the indicator in above it. */
  const place = (dist: number, animate: boolean) => {
    const b = body.current;
    const i = indicator.current;
    for (const el of [b, i]) if (el) el.style.transition = animate ? SETTLE : 'none';
    if (b) b.style.transform = dist > 0 ? `translate3d(0, ${dist}px, 0)` : '';
    if (i) {
      i.style.transform = `translate3d(0, ${dist - PULL_HOLD}px, 0)`;
      i.style.opacity = String(Math.min(1, dist / PULL_TRIGGER));
      i.style.setProperty('--pull-turn', `${Math.round((dist / PULL_TRIGGER) * 270)}deg`);
    }
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setNote(null);
    setBusy(true);
    let done: string | undefined;
    try {
      done = await refreshRef.current();
    } finally {
      busyRef.current = false;
      setBusy(false);
      if (done) setNote(done);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  // Keep the indicator in view while the refresh runs and while its note shows; tuck it away after.
  useEffect(() => {
    if (!enabled) return;
    placeRef.current(busy || note ? PULL_HOLD : 0, true);
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [busy, note, enabled]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let startY: number | null = null;
    let dist = 0;
    let isArmed = false;
    const arm = (a: boolean) => {
      if (a === isArmed) return;
      isArmed = a;
      setArmed(a);
    };
    const start = (e: TouchEvent) => {
      if (busyRef.current || el.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0]!.clientY;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dist === 0 && (dy <= 0 || el.scrollTop > 0)) {
        // Scrolling the list, not pulling it: leave the gesture to the browser.
        if (dy < 0) startY = null;
        return;
      }
      dist = resist(dy);
      if (e.cancelable) e.preventDefault();
      placeRef.current(dist, false);
      arm(dist >= PULL_TRIGGER);
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      const go = isArmed;
      dist = 0;
      arm(false);
      placeRef.current(go ? PULL_HOLD : 0, true);
      if (go) void runRef.current();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [ref, enabled]);

  return { armed, busy, note, run, body, indicator };
}
