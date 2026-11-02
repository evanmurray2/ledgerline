// Drag-to-reorder for a short vertical list (categories in a group, or the groups themselves), always on:
// no Edit mode. Drag the handle with a finger or mouse, or focus it and press the up or down arrow.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

interface Drag {
  from: number;
  to: number;
  dy: number;
  startY: number;
  rects: DOMRect[];
}

/** `commit(from, to)` is called once, on drop or on an arrow key, with the item's old and new index. */
export function useReorder(count: number, commit: (from: number, to: number) => void) {
  const items = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const live = useRef<Drag | null>(null);
  const set = (d: Drag | null) => {
    live.current = d;
    setDrag(d);
  };

  const itemRef = (i: number) => (el: HTMLElement | null) => {
    items.current[i] = el;
  };

  const handleProps = (i: number) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const rects = items.current.slice(0, count).map((el) => el?.getBoundingClientRect() ?? new DOMRect());
      set({ from: i, to: i, dy: 0, startY: e.clientY, rects });
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = live.current;
      if (!d) return;
      const dy = e.clientY - d.startY;
      const r = d.rects[d.from]!;
      const center = r.top + r.height / 2 + dy;
      // The new index is how many of the other items now sit above the dragged one's middle.
      const to = d.rects.filter((x, j) => j !== d.from && x.top + x.height / 2 < center).length;
      set({ ...d, dy, to });
    },
    onPointerUp: () => {
      const d = live.current;
      set(null);
      if (d && d.to !== d.from) commit(d.from, d.to);
    },
    onPointerCancel: () => set(null),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'ArrowUp' && i > 0) {
        e.preventDefault();
        commit(i, i - 1);
      } else if (e.key === 'ArrowDown' && i < count - 1) {
        e.preventDefault();
        commit(i, i + 1);
      }
    },
  });

  /** Moves the dragged item with the finger and slides the ones it passes out of the way. */
  const itemStyle = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const r = drag.rects;
    if (i === drag.from)
      return {
        transform: `translateY(${drag.dy}px)`,
        position: 'relative',
        zIndex: 10,
        boxShadow: '0 6px 16px var(--ll-shadow)',
      };
    // How far the others move: the dragged item's height plus the gap after (or before) it.
    const next = r[drag.from + 1];
    const prev = r[drag.from - 1];
    const self = r[drag.from]!;
    const gap = next ? next.top - self.bottom : prev ? self.top - prev.bottom : 0;
    const shift = self.height + gap;
    const style: CSSProperties = { transition: 'transform 150ms ease' };
    if (drag.from < drag.to && i > drag.from && i <= drag.to)
      return { ...style, transform: `translateY(${-shift}px)` };
    if (drag.from > drag.to && i >= drag.to && i < drag.from)
      return { ...style, transform: `translateY(${shift}px)` };
    return style;
  };

  return { itemRef, handleProps, itemStyle, dragging: drag !== null };
}

/** The list with item `from` moved to index `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}
