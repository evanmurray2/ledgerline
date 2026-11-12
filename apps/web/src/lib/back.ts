// Coming back from another tab. A link that opens a screen of another tab carries where it was opened, so Back
// (a page) or closing (a sheet) returns there instead of to the tab's own list:
// - `?back=<path>`: the page's Back button goes there (an account, Owed to you, one category's transactions).
// - `?close=<path>`: closing the sheet goes there (a transaction opened from a category, Assign from any tab).
// Both are kept by the page's own sheets and filters (they keep its search), and both chain: the path kept can
// carry a `back` of its own. Only a path in this app is kept: never another site.
import { useNavigate, useRouterState } from '@tanstack/react-router';

/** A path in this app ("/budget?month=2026-10"), else undefined. */
export function appPath(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')
    ? v
    : undefined;
}

/** The `back` and `close` a route's search keeps. */
export function returnSearch(s: Record<string, unknown>): { back?: string; close?: string } {
  return { back: appPath(s.back), close: appPath(s.close) };
}

/** Where this screen is now (path and search), for the `back` or `close` of a link that leaves it. */
export function useHere(): string {
  return useRouterState({ select: (s) => s.location.pathname + s.location.searchStr });
}

function pathOf(href: string): string {
  return href.split('?')[0] ?? href;
}

/** "Back to …" for a path, by the screen it opens. */
export function backLabel(href: string): string {
  const p = pathOf(href);
  if (p.startsWith('/budget/category/')) return 'Back to category';
  if (p.startsWith('/budget')) return 'Back to budget';
  if (p.startsWith('/owed')) return 'Back to Owed to you';
  if (p.startsWith('/accounts/repair') || p === '/accounts') return 'Back to accounts';
  if (p.startsWith('/accounts/')) return 'Back to account';
  if (p.startsWith('/activity')) return 'Back to activity';
  if (p.startsWith('/reports')) return 'Back to Reports';
  if (p.startsWith('/targets')) return 'Back to targets';
  if (p.startsWith('/categories')) return 'Back to categories';
  if (p.startsWith('/settings/connections')) return 'Back to bank connections';
  if (p.startsWith('/settings/users')) return 'Back to users';
  if (p.startsWith('/settings')) return 'Back to settings';
  return 'Back';
}

function useReturn(key: 'back' | 'close') {
  const navigate = useNavigate();
  const to = useRouterState({ select: (s) => appPath((s.location.search as Record<string, unknown>)[key]) });
  if (!to) return null;
  return { to, label: backLabel(to), go: () => void navigate({ href: to }) };
}

/** The page's Back when it was opened from another tab: null when it wasn't (its own Back applies). */
export function useBack() {
  return useReturn('back');
}

/** Closing the sheet when it was opened from another tab: null when it wasn't (it closes to the screen under it). */
export function useCloseTo() {
  return useReturn('close');
}

/** The search of a screen opened from another tab, for the tab it lights: the one it was opened from. */
export function returnOrigin(
  search: Record<string, unknown>,
): { path: string; search: Record<string, unknown> } | null {
  const href = appPath(search.close) ?? appPath(search.back);
  if (!href) return null;
  const [path = href, query = ''] = href.split('?');
  return { path, search: Object.fromEntries(new URLSearchParams(query)) };
}
