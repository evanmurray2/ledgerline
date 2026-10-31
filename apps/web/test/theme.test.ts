import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, readThemePref, resolveTheme, THEME_KEY, writeThemePref } from '../src/lib/theme';

afterEach(() => {
  window.localStorage.clear();
  window.__prefersDark = false;
  vi.restoreAllMocks();
});

describe('resolveTheme', () => {
  it('follows the device only for Match device', () => {
    expect(resolveTheme('device', true)).toBe('dark');
    expect(resolveTheme('device', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('theme preference', () => {
  it('defaults to Match device', () => {
    expect(readThemePref()).toBe('device');
  });

  it('is saved per device under ledgerline-theme and sets data-theme', () => {
    writeThemePref('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    writeThemePref('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('Match device resolves from prefers-color-scheme', () => {
    writeThemePref('device');
    window.__prefersDark = true;
    expect(applyTheme()).toBe('dark');
    window.__prefersDark = false;
    expect(applyTheme()).toBe('light');
  });

  it('ignores junk in storage', () => {
    window.localStorage.setItem(THEME_KEY, 'purple');
    expect(readThemePref()).toBe('device');
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeThemePref('dark')).not.toThrow();
    expect(readThemePref()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
