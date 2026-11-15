import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanId, FLUSH_MS, KEEP_DAYS, KEEP_MAX, UsageTracker, type UsageEvent } from '../src/usage/tracker';

function make() {
  let kept: UsageEvent[] = [];
  const saves: UsageEvent[][] = [];
  const store = {
    load: vi.fn(() => kept),
    save: vi.fn((events: UsageEvent[]) => {
      kept = events;
      saves.push(events);
    }),
    clear: vi.fn(() => {
      kept = [];
    }),
  };
  const tracker = new UsageTracker({
    store,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  });
  tracker.appVersion = '0.1.0';
  return { tracker, saves, store, kept: () => kept };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-14T17:42:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cleanId', () => {
  it('keeps fixed ids and drops anything else', () => {
    expect(cleanId('activity.category.choose')).toBe('activity.category.choose');
    expect(cleanId('Budget.Attention')).toBe('budget.attention');
    expect(cleanId('Trader Joe’s')).toBeNull();
    expect(cleanId('$18.25')).toBeNull();
    expect(cleanId('a'.repeat(80))).toBe('a'.repeat(60));
    expect(cleanId('')).toBeNull();
  });
});

describe('UsageTracker', () => {
  it('buffers events and writes them to the device every 30 seconds, sending nothing', async () => {
    const { tracker, saves, kept } = make();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    tracker.setEnabled(true);
    tracker.view('budget');
    tracker.tap('budget.assign');
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toHaveLength(1);
    expect(kept().map((e) => [e.screen, e.event, e.target])).toEqual([
      ['budget', 'view', null],
      ['budget', 'tap', 'budget.assign'],
    ]);
    expect(kept()[0]).toMatchObject({ version: '0.1.0', session: tracker.sessionId.slice(0, 8) });
    expect(tracker.pending).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('records the screen that showed before recording was turned on', async () => {
    const { tracker, kept } = make();
    tracker.view('settings.data');
    tracker.setEnabled(true);
    await tracker.flush();
    expect(kept().map((e) => [e.screen, e.event])).toEqual([['settings.data', 'view']]);
  });

  it('does not write an empty batch', async () => {
    const { tracker, saves } = make();
    tracker.setEnabled(true);
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 3);
    expect(saves).toHaveLength(0);
  });

  it('flushes when asked (page hidden) without waiting for the timer', async () => {
    const { tracker, saves } = make();
    tracker.setEnabled(true);
    tracker.tap('activity.select');
    await tracker.flush();
    expect(saves).toHaveLength(1);
  });

  it('records task durations, undo, back-outs, searches with no results and errors as fixed ids and one number', async () => {
    const { tracker, kept } = make();
    tracker.setEnabled(true);
    tracker.view('activity');
    tracker.startTask('categorize');
    await vi.advanceTimersByTimeAsync(4000);
    tracker.endTask('categorize');
    tracker.undo('categorize');
    tracker.backOut('txn');
    tracker.searchNoResults(12);
    tracker.error('read_only');
    tracker.suggestion('rule_offer', 'always');
    await tracker.flush();
    const events = kept();
    expect(events.find((e) => e.event === 'task')).toMatchObject({ target: 'categorize', value: 4000 });
    expect(events.find((e) => e.event === 'undo')).toMatchObject({ target: 'undo.categorize' });
    expect(events.find((e) => e.event === 'back_out')).toMatchObject({ target: 'txn' });
    expect(events.find((e) => e.event === 'search_empty')).toMatchObject({ target: null, value: 12 });
    expect(events.find((e) => e.event === 'error')).toMatchObject({ target: 'read_only' });
    expect(events.find((e) => e.event === 'suggestion')).toMatchObject({ target: 'rule_offer.always' });
  });

  it('never keeps amounts, payee names, memos or search text', async () => {
    const { tracker, kept } = make();
    tracker.setEnabled(true);
    tracker.view('Trader Joe’s');
    tracker.tap('$18.25');
    tracker.record('tap', 'Blue Bottle Coffee memo: split with Jordan');
    tracker.record('search', 'uber eats');
    tracker.error('Payee Trader Joe’s not found');
    tracker.tap('budget.category');
    await tracker.flush();
    const raw = JSON.stringify(kept());
    for (const bad of ['Trader', 'Joe', '18.25', 'Blue Bottle', 'Jordan', 'uber eats'])
      expect(raw).not.toContain(bad);
    const events = kept();
    expect(events.every((e) => /^[a-z0-9_.-]+$/.test(e.event))).toBe(true);
    expect(events.every((e) => e.target === null || /^[a-z0-9_.-]+$/.test(e.target))).toBe(true);
  });

  it('records named controls from clicks and rage taps on non-controls', async () => {
    const { tracker, kept } = make();
    tracker.setEnabled(true);
    document.body.innerHTML =
      '<button data-track="budget.assign">Assign <span id="inner">$981.90</span></button><p id="text">Ready to Assign</p>';
    tracker.onClick(new MouseEvent('click', { bubbles: true }) as MouseEvent & { target: Element });
    const inner = document.getElementById('inner')!;
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ev = new MouseEvent('click', { clientX: 10, clientY: 10 });
    Object.defineProperty(ev, 'target', { value: inner });
    tracker.onClick(ev);
    const text = document.getElementById('text')!;
    for (let i = 0; i < 3; i++) {
      const e = new MouseEvent('click', { clientX: 50, clientY: 50 });
      Object.defineProperty(e, 'target', { value: text });
      tracker.onClick(e);
      await vi.advanceTimersByTimeAsync(200);
    }
    await tracker.flush();
    const events = kept();
    expect(events.filter((e) => e.event === 'tap').map((e) => e.target)).toEqual(['budget.assign']);
    expect(events.filter((e) => e.event === 'rage_tap')).toHaveLength(1);
    expect(events.find((e) => e.event === 'rage_tap')!.value).toBe(3);
    // Where it happened, by structure only: never the text that was tapped.
    expect(events.find((e) => e.event === 'rage_tap')!.target).toBe('p.body.html');
  });

  it('stops collecting and drops the buffer when tracking is turned off', async () => {
    const { tracker, saves } = make();
    tracker.setEnabled(true);
    tracker.tap('budget.assign');
    tracker.setEnabled(false);
    tracker.tap('budget.assign');
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);
    await tracker.flush();
    expect(saves).toHaveLength(0);
    expect(tracker.pending).toHaveLength(0);
    // Recent event names stay available for a feedback note.
    expect(tracker.recentEvents().length).toBeGreaterThan(0);
  });

  it('drops a failed write instead of retrying', async () => {
    const { tracker, store } = make();
    store.save.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    tracker.setEnabled(true);
    tracker.tap('budget.assign');
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(tracker.pending).toHaveLength(0);
  });

  it('adds to what the device kept, and drops events past 90 days or past the cap', async () => {
    const { tracker, store, kept } = make();
    const now = Date.now();
    const old = {
      at: now - (KEEP_DAYS + 1) * 86_400_000,
      screen: 'budget',
      event: 'view',
      target: null,
      value: null,
    };
    const recent = { ...old, at: now - 86_400_000 };
    store.save([old, recent]);
    tracker.setEnabled(true);
    tracker.tap('budget.assign');
    await tracker.flush();
    expect(kept().map((e) => e.at)).toEqual([recent.at, now]);
    store.save(Array.from({ length: KEEP_MAX + 5 }, (_, i) => ({ ...recent, value: i })));
    tracker.tap('budget.assign');
    await tracker.flush();
    expect(kept()).toHaveLength(KEEP_MAX);
    expect(kept().at(-1)).toMatchObject({ event: 'tap' });
  });

  it('saves a file of what was kept, including events still in memory, and forgets on request', async () => {
    const { tracker, kept } = make();
    tracker.setEnabled(true);
    tracker.view('activity');
    const file = JSON.parse(await tracker.file()) as { kind: string; events: UsageEvent[] };
    expect(file.kind).toBe('ledgerline-usage');
    expect(file.events.map((e) => e.screen)).toEqual(['activity']);
    tracker.forget();
    expect(kept()).toEqual([]);
    expect(await tracker.kept()).toEqual([]);
  });
});
