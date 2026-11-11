import { describe, expect, it } from 'vitest';
import { seededUlid, ulid } from '../src/ids.js';

describe('seededUlid', () => {
  const now = Date.UTC(2026, 10, 11);

  it('gives the same id for the same time, seed and number', () => {
    expect(seededUlid(now, 'edit-0001', 0)).toBe(seededUlid(now, 'edit-0001', 0));
  });

  it('differs by number and by seed', () => {
    const ids = new Set<string>();
    for (const seed of ['edit-0001', 'edit-0002', 'edit-00010'])
      for (let n = 0; n < 50; n++) ids.add(seededUlid(now, seed, n));
    expect(ids.size).toBe(150);
  });

  it('has the shape and the time part of a ULID', () => {
    const id = seededUlid(now, 'edit-0001', 3);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(0, 10)).toBe(ulid(now).slice(0, 10));
    expect(seededUlid(now + 1, 'edit-0001', 3) > id).toBe(true);
  });
});
