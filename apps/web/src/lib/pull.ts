// Pull-to-refresh for a scrolling area (design.md, When data updates). The page itself doesn't scroll or bounce on a
// phone, so the gesture is watched on the screen's own scroll container: a pull down from the top past PULL_TRIGGER
// starts onRefresh once it is released.
import { useEffect, useRef, useState, type RefObject } from 'react';

/** How far (after damping) the content has to be pulled before releasing starts a refresh. */
export const PULL_TRIGGER = 64;
const PULL_MAX = 96;
const DAMPING = 0.5;

export function usePullToRefresh(
  ref: RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void>,
  enabled: boolean,
): { pull: number; busy: boolean; run: () => Promise<void> } {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await refreshRef.current();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let startY: number | null = null;
    let dist = 0;
    const start = (e: TouchEvent) => {
      if (busyRef.current || el.scrollTop > 0 || e.touches.length !== 1) return;
      startY = e.touches[0]!.clientY;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      dist = Math.min(Math.max(0, (e.touches[0]!.clientY - startY) * DAMPING), PULL_MAX);
      if (dist > 0 && el.scrollTop <= 0) {
        setPull(dist);
        if (e.cancelable) e.preventDefault();
      }
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      const go = dist >= PULL_TRIGGER;
      dist = 0;
      setPull(0);
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

  return { pull, busy, run };
}
