import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageBatch } from '@ledgerline/contracts';
import { cleanId, FLUSH_MS, UsageTracker } from '../src/usage/tracker';

interface Sent {
  url: string;
  init: RequestInit;
}

function make() {
  const sent: Sent[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  });
  const tracker = new UsageTracker({
    fetch: fetchMock as unknown as typeof fetch,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  });
  tracker.appVersion = '0.1.0';
  return { tracker, sent, fetchMock };
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
  it('buffers events and sends them every 30 seconds with keepalive and the CSRF header', async () => {
    const { tracker, sent } = make();
    tracker.setEnabled(true);
    tracker.view('budget');
    tracker.tap('budget.assign');
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe('/api/usage');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('same-origin');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-ledgerline']).toBe('1');
    const body = UsageBatch.parse(JSON.parse(String(init.body)));
    expect(body.events.map((e) => [e.screen, e.event, e.target])).toEqual([
      ['budget', 'view', null],
      ['budget', 'tap', 'budget.assign'],
    ]);
    expect(tracker.pending).toHaveLength(0);
  });

  it('does not send an empty batch', async () => {
    const { tracker, sent } = make();
    tracker.setEnabled(true);
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 3);
    expect(sent).toHaveLength(0);
  });

  it('flushes when asked (page hidden) without waiting for the timer', async () => {
    const { tracker, sent } = make();
    tracker.setEnabled(true);
    tracker.tap('activity.select');
    await tracker.flush();
    expect(sent).toHaveLength(1);
  });

  it('records task durations, undo, back-outs, searches with no results and errors as fixed ids and one number', async () => {
    const { tracker, sent } = make();
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
    const events = UsageBatch.parse(JSON.parse(String(sent[0]!.init.body))).events;
    expect(events.find((e) => e.event === 'task')).toMatchObject({ target: 'categorize', value: 4000 });
    expect(events.find((e) => e.event === 'undo')).toMatchObject({ target: 'undo.categorize' });
    expect(events.find((e) => e.event === 'back_out')).toMatchObject({ target: 'txn' });
    expect(events.find((e) => e.event === 'search_empty')).toMatchObject({ target: null, value: 12 });
    expect(events.find((e) => e.event === 'error')).toMatchObject({ target: 'read_only' });
    expect(events.find((e) => e.event === 'suggestion')).toMatchObject({ target: 'rule_offer.always' });
  });

  it('never sends amounts, payee names, memos or search text', async () => {
    const { tracker, sent } = make();
    tracker.setEnabled(true);
    tracker.view('Trader Joe’s');
    tracker.tap('$18.25');
    tracker.record('tap', 'Blue Bottle Coffee memo: split with Jordan');
    tracker.record('search', 'uber eats');
    tracker.error('Payee Trader Joe’s not found');
    tracker.tap('budget.category');
    await tracker.flush();
    const raw = String(sent[0]!.init.body);
    for (const bad of ['Trader', 'Joe', '18.25', 'Blue Bottle', 'Jordan', 'uber eats'])
      expect(raw).not.toContain(bad);
    const events = UsageBatch.parse(JSON.parse(raw)).events;
    expect(events.every((e) => /^[a-z0-9_.-]+$/.test(e.event))).toBe(true);
    expect(events.every((e) => e.target === null || /^[a-z0-9_.-]+$/.test(e.target))).toBe(true);
  });

  it('records named controls from clicks and rage taps on non-controls', async () => {
    const { tracker, sent } = make();
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
    const events = UsageBatch.parse(JSON.parse(String(sent[0]!.init.body))).events;
    expect(events.filter((e) => e.event === 'tap').map((e) => e.target)).toEqual(['budget.assign']);
    expect(events.filter((e) => e.event === 'rage_tap')).toHaveLength(1);
    expect(events.find((e) => e.event === 'rage_tap')!.value).toBe(3);
    // Where it happened, by structure only: never the text that was tapped.
    expect(events.find((e) => e.event === 'rage_tap')!.target).toBe('p.body.html');
  });

  it('stops collecting and drops the buffer when tracking is turned off', async () => {
    const { tracker, sent } = make();
    tracker.setEnabled(true);
    tracker.tap('budget.assign');
    tracker.setEnabled(false);
    tracker.tap('budget.assign');
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);
    await tracker.flush();
    expect(sent).toHaveLength(0);
    expect(tracker.pending).toHaveLength(0);
    // Recent event names stay available for a feedback note.
    expect(tracker.recentEvents().length).toBeGreaterThan(0);
  });

  it('drops a failed batch instead of retrying', async () => {
    const { tracker, fetchMock } = make();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    tracker.setEnabled(true);
    tracker.tap('budget.assign');
    await expect(tracker.flush()).resolves.toBeUndefined();
    expect(tracker.pending).toHaveLength(0);
  });
});
