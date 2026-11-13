// lib/release.ts: the release in /release.json, and a commit as people quote it.
import { describe, expect, it } from 'vitest';
import { parseRelease, shortCommit } from '../src/lib/release';

const HASH = 'a'.repeat(64);

describe('parseRelease', () => {
  it('reads a release', () => {
    expect(parseRelease(JSON.stringify({ commit: 'abc', hash: HASH, extra: 1 }))).toEqual({
      commit: 'abc',
      hash: HASH,
    });
  });

  it('is null for anything else', () => {
    expect(parseRelease('<html>offline</html>')).toBeNull();
    expect(parseRelease('null')).toBeNull();
    expect(parseRelease(JSON.stringify({ commit: 'abc' }))).toBeNull();
    expect(parseRelease(JSON.stringify({ commit: 'abc', hash: 'A'.repeat(64) }))).toBeNull();
    expect(parseRelease(JSON.stringify({ commit: 1, hash: HASH }))).toBeNull();
  });
});

describe('shortCommit', () => {
  it('shortens a full commit only', () => {
    expect(shortCommit('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
    expect(shortCommit('dev')).toBe('dev');
  });
});
