// lib/pull.ts: pull-to-refresh on a scrolling area.
import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PULL_TRIGGER, resist, usePullToRefresh } from '../src/lib/pull';

describe('resist', () => {
  it('follows the finger at first, then gets harder, never past its limit', () => {
    expect(resist(-10)).toBe(0);
    expect(resist(0)).toBe(0);
    expect(resist(10)).toBeGreaterThan(6);
    expect(resist(10)).toBeLessThan(10);
    expect(resist(200)).toBeLessThan(resist(400));
    expect(resist(10_000)).toBeLessThanOrEqual(120);
  });

  it('needs about 110 px of finger to reach the trigger', () => {
    expect(resist(100)).toBeLessThan(PULL_TRIGGER);
    expect(resist(120)).toBeGreaterThanOrEqual(PULL_TRIGGER);
  });
});

function Pull({ onRefresh }: { onRefresh: () => Promise<string | undefined> }) {
  const ref = useRef<HTMLDivElement>(null);
  const p = usePullToRefresh(ref, onRefresh, true);
  return (
    <div ref={ref} data-testid="area">
      <div ref={p.indicator} />
      <div ref={p.body}>{p.busy ? 'busy' : p.armed ? 'armed' : 'still'}</div>
      {p.note && <p>{p.note}</p>}
    </div>
  );
}

const touch = (el: Element, type: string, y?: number) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { touches: y === undefined ? [] : [{ clientY: y }] });
  el.dispatchEvent(e);
};

afterEach(cleanup);

describe('usePullToRefresh', () => {
  it('a pull past the trigger refreshes once released, and shows its note', async () => {
    const onRefresh = vi.fn(async () => 'Up to date');
    const r = render(<Pull onRefresh={onRefresh} />);
    const area = r.getByTestId('area');
    act(() => {
      touch(area, 'touchstart', 0);
      touch(area, 'touchmove', 200);
    });
    expect(r.getByText('armed')).toBeTruthy();
    await act(async () => touch(area, 'touchend'));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(r.getByText('Up to date')).toBeTruthy();
  });

  it('a short pull does nothing', async () => {
    const onRefresh = vi.fn(async () => undefined);
    const r = render(<Pull onRefresh={onRefresh} />);
    const area = r.getByTestId('area');
    await act(async () => {
      touch(area, 'touchstart', 0);
      touch(area, 'touchmove', 30);
      touch(area, 'touchend');
    });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(r.getByText('still')).toBeTruthy();
  });
});
