import { afterEach, describe, expect, it, vi } from 'vitest';
import { copySettled, needsReload, reloadForVersion } from '../src/state/version';

afterEach(() => {
  window.sessionStorage.clear();
  document.body.innerHTML = '';
});

describe('reloading for a new release', () => {
  it('reloads only when the server runs another release than this build', () => {
    expect(needsReload('abc', 'abc')).toBe(false);
    expect(needsReload('def', 'abc')).toBe(true);
    // Local dev and tests: no release to compare.
    expect(needsReload('def', 'dev')).toBe(false);
  });

  it('tries once per server release, so a cached page cannot loop', () => {
    const reload = vi.fn();
    reloadForVersion('def', reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(needsReload('def', 'abc')).toBe(false);
    expect(needsReload('ghi', 'abc')).toBe(true);
  });

  it('waits while you are typing, then reloads when the app is hidden', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const reload = vi.fn();
    reloadForVersion('def', reload);
    expect(reload).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits while the copy is opening, so a sign-in is not asked for Face ID again', () => {
    expect(copySettled('idle')).toBe(false);
    expect(copySettled('opening')).toBe(false);
    for (const status of ['ready', 'signed_out', 'failed', 'off']) expect(copySettled(status)).toBe(true);
  });
});
