// Appearance: Light, Dark or Match device (default), saved per device. The resolved theme is set as
// data-theme on <html>; every color is a token with a light and a dark value (src/styles.css).
import { useSyncExternalStore } from 'react';
import { createListeners } from './store';

export type ThemePref = 'light' | 'dark' | 'device';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'ledgerline-theme';

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'device';
}

let memoryPref: ThemePref | null = null;

export function readThemePref(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (isThemePref(v)) return v;
  } catch {
    // storage blocked: fall back to this tab's memory
  }
  return memoryPref ?? 'device';
}

export function writeThemePref(pref: ThemePref): void {
  memoryPref = pref;
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this tab only
  }
  applyTheme();
  emit();
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'device') return prefersDark ? 'dark' : 'light';
  return pref;
}

export function applyTheme(): ResolvedTheme {
  const resolved = resolveTheme(readThemePref(), systemPrefersDark());
  document.documentElement.setAttribute('data-theme', resolved);
  // The phone's status bar follows the app's theme, not only the device's. index.html has one tag per scheme,
  // each with that theme's surface color: remember both, then give both tags the chosen theme's color.
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  for (const m of metas) m.dataset.color ??= m.content;
  const color = metas.find((m) => m.getAttribute('media')?.includes(resolved))?.dataset.color;
  if (color) for (const m of metas) m.content = color;
  return resolved;
}

const { subscribe, emit } = createListeners();

let watching = false;
/** Keeps data-theme in step with the device setting and with other tabs. */
export function watchTheme(): void {
  if (watching) return;
  watching = true;
  const onChange = () => {
    applyTheme();
    emit();
  };
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onChange);
  } catch {
    // old browsers: no live updates
  }
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) onChange();
  });
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, readThemePref, () => 'device' as ThemePref);
}
