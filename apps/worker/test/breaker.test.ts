// The write breaker (Sync spec F8, decisions.md D-37): 70% of any daily limit pauses background work and 90% makes
// the app read-only, counting Durable Object requests and active time as well as rows.
import { describe, expect, it } from 'vitest';
import { classifyUsage } from '../src/sync/breaker.js';

describe('classifyUsage', () => {
  it('is normal well under every limit', () => {
    expect(classifyUsage(10_000, 100_000, { requests: 2_000, gbs: 50 })).toBe('normal');
  });
  it('pauses at 70% of rows written or read', () => {
    expect(classifyUsage(70_000, 0)).toBe('pause');
    expect(classifyUsage(0, 3_500_000)).toBe('pause');
  });
  it('pauses at 70% of Durable Object requests or active time', () => {
    expect(classifyUsage(0, 0, { requests: 70_000, gbs: 0 })).toBe('pause');
    expect(classifyUsage(0, 0, { requests: 0, gbs: 9_100 })).toBe('pause');
  });
  it('goes read-only at 90% of any limit', () => {
    expect(classifyUsage(90_000, 0)).toBe('readonly');
    expect(classifyUsage(0, 0, { requests: 90_000, gbs: 0 })).toBe('readonly');
    expect(classifyUsage(0, 0, { requests: 0, gbs: 11_700 })).toBe('readonly');
  });
});
