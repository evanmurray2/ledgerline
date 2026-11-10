// A store call that reads many rows writes one heavy_read line (store/heavy-reads.ts); a light one writes nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_READ_ROWS, markReads, noteHeavyRead, routeName } from '../src/store/heavy-reads';

const stats = (rowsRead: number, rowsWritten = 0) => ({ queries: 0, statements: 0, rowsRead, rowsWritten });

afterEach(() => vi.restoreAllMocks());

describe('heavy reads', () => {
  it('logs a call that read HEAVY_READ_ROWS or more, with what it was', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const s = stats(100, 5);
    const mark = markReads(s);
    s.rowsRead += HEAVY_READ_ROWS;
    s.rowsWritten += 7;
    const line = noteHeavyRead(s, mark, 'job:daily_scan', 'b1');
    expect(line).toMatchObject({
      event: 'heavy_read',
      what: 'job:daily_scan',
      budget: 'b1',
      read: HEAVY_READ_ROWS,
      written: 7,
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a light call, and counts from zero after a stats reset', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const mark = markReads(stats(50_000));
    expect(noteHeavyRead(stats(50_000 + 10), mark, 'GET /api/sync', 'b1')).toBeNull();
    expect(noteHeavyRead(stats(30), mark, 'GET /api/sync', 'b1')).toBeNull();
    expect(noteHeavyRead(stats(HEAVY_READ_ROWS), mark, 'GET /api/sync', 'b1')?.read).toBe(HEAVY_READ_ROWS);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('names a route without its query or ids', () => {
    expect(routeName(new Request('https://x/api/sync?since=0&why=first'))).toBe('GET /api/sync');
    expect(
      routeName(new Request('https://x/api/transactions/01JCDEFGHJKMNPQRSTV', { method: 'PATCH' })),
    ).toBe('PATCH /api/transactions/:id');
    expect(routeName(new Request('https://x/api/budget/2026-11'))).toBe('GET /api/budget/2026-11');
  });
});
