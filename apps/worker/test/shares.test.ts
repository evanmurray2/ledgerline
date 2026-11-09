// Fair use (docs/open-signup.md 8, store/shares.ts).
import { describe, expect, it } from 'vitest';
import { FREE_LIMITS } from '../src/sync/breaker.js';
import { UsageCounter, poolFraction, shareState } from '../src/store/shares.js';

const zero = { written: 0, requests: 0 };

describe('poolFraction', () => {
  it('is half unless set; off turns fair use off', () => {
    expect(poolFraction({})).toBe(0.5);
    expect(poolFraction({ OTHER_USERS_SHARE: '0.25' })).toBe(0.25);
    expect(poolFraction({ OTHER_USERS_SHARE: 'off' })).toBeNull();
    for (const v of ['', '0', '-1', '2', 'lots']) expect(poolFraction({ OTHER_USERS_SHARE: v })).toBe(0.5);
  });
});

describe('shareState', () => {
  // Free: 100,000 rows written and 100,000 Durable Object requests a day; half for other users; 5 active → 10,000 each.
  const at = (written: number, requests = 0, others = zero) =>
    shareState({ written, requests }, others, FREE_LIMITS, 0.5, 5);

  it('splits the pool evenly: under the share is normal, past it waits, past 1.5 × it is read-only', () => {
    expect(at(9_999)).toBe('normal');
    expect(at(10_000)).toBe('pause');
    expect(at(14_999)).toBe('pause');
    expect(at(15_000)).toBe('readonly');
    expect(at(0, 15_000)).toBe('readonly');
  });

  it('once the pool is used, every other user waits', () => {
    expect(at(0, 0, { written: 50_000, requests: 0 })).toBe('pause');
    expect(at(0, 0, { written: 0, requests: 50_000 })).toBe('pause');
  });

  it('one active user gets the whole pool', () => {
    expect(shareState({ written: 49_000, requests: 0 }, zero, FREE_LIMITS, 0.5, 1)).toBe('normal');
    expect(shareState({ written: 49_000, requests: 0 }, zero, FREE_LIMITS, 0.5, 0)).toBe('normal');
  });
});

describe('UsageCounter', () => {
  it('reports rows and requests once a minute at most, and nothing while not counting', () => {
    const stats = { rowsRead: 10, rowsWritten: 5 };
    const u = new UsageCounter(stats);
    stats.rowsWritten += 3;
    stats.rowsRead += 7;
    u.request();
    expect(u.take(false, 1_000)).toBeNull(); // not counting: dropped
    stats.rowsWritten += 2;
    u.request();
    expect(u.take(true, 100_000)).toEqual({ written: 2, read: 0, requests: 1 });
    u.request();
    expect(u.take(true, 120_000)).toBeNull(); // within a minute: kept for later
    stats.rowsWritten += 4;
    expect(u.take(true, 161_000)).toEqual({ written: 4, read: 0, requests: 1 });
  });

  it('counts from 0 again when the database counters are reset', () => {
    const stats = { rowsRead: 100, rowsWritten: 100 };
    const u = new UsageCounter(stats);
    Object.assign(stats, { rowsRead: 0, rowsWritten: 3 });
    u.request();
    expect(u.take(true, 100_000)).toEqual({ written: 3, read: 0, requests: 1 });
  });
});
