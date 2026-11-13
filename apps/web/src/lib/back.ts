// Coming back from another tab. A link that opens a screen of another tab carries where it was opened, so Back
// (a page) or closing (a sheet) returns there instead of to the tab's own list:
// - `?back=<path>`: the page's Back button goes there (an account, Owed to you, one category's transactions).
// - `?close=<path>`: closing the sheet goes there (a transaction opened from a category, Assign from any tab).
// Both are kept by the page's own sheets and filters (they keep its search), and both chain: the path kept can
// carry a `back` of its own. Only a path in this app is kept: never another site.
import { useNavigate, useRouterState, type RouterHistory } from '@tanstack/react-router';

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

// Closing a sheet (✕, Escape, the scrim, a swipe) goes back to the screen under it without adding a page to the
// history: otherwise Back would open the sheet again. When the page before is that screen, closing is Back itself;
// else the sheet's page is replaced. Each sheet's onClose still says where to go (Sheet.tsx calls it in closingSheet).
let closing = 0;

/** Runs a sheet's onClose: a navigation it makes goes back or replaces, never adds a page. */
export function closingSheet(fn: () => void): void {
  closing++;
  try {
    fn();
  } finally {
    closing--;
  }
}

// Back (the browser's, or a swipe from the edge) while a sheet is open. A picker opened from inside another sheet (a
// `modal` sheet: Move money, a category picker) has no page of its own, so Back would close the sheet under it too:
// Back closes only the picker. A sheet holding an amount typed but not saved asks first (Sheet.tsx shows the ask).
// The router puts the page back when Back is refused (its history's blockers), so nothing changes but the sheet.

/** An open sheet, as Back sees it. */
export interface OpenSheet {
  /** A picker opened from inside another sheet: it has no page of its own. */
  nested: boolean;
  /** An amount typed and not saved: Back asks before it drops it. */
  unsaved: () => boolean;
  /** Shows the ask (Sheet.tsx). */
  ask: () => void;
  /** Closes the sheet as its ✕ does. */
  close: () => void;
}

/** Open sheets, newest last. */
const openSheets: OpenSheet[] = [];

/** Puts an open sheet where Back sees it; the function returned takes it away. */
export function sheetOpened(sheet: OpenSheet): () => void {
  openSheets.push(sheet);
  return () => {
    const i = openSheets.indexOf(sheet);
    if (i >= 0) openSheets.splice(i, 1);
  };
}

/** What Back does with the newest open sheet: true when it handled Back (the page stays). */
export function backHandled(): boolean {
  const top = openSheets[openSheets.length - 1];
  if (!top) return false;
  if (top.unsaved()) {
    top.ask();
    return true;
  }
  if (!top.nested) return false;
  top.close();
  return true;
}

/** The router's history, with pages a sheet's closing pushes turned into Back or a replace (closingSheet). */
export function sheetAwareHistory(h: RouterHistory): RouterHistory {
  const hrefAt = new Map<number, string>();
  const note = () => {
    const i = h.location.state.__TSR_index;
    if (typeof i === 'number') hrefAt.set(i, h.location.href);
  };
  note();
  h.subscribe(note);
  const push = h.push.bind(h);
  h.push = (path, state, opts) => {
    if (!closing) return push(path, state, opts);
    const i = h.location.state.__TSR_index;
    // A sheet closing goes back on purpose: Back's ask doesn't stop it.
    if (typeof i === 'number' && i > 0 && hrefAt.get(i - 1) === path) return h.back({ ignoreBlocker: true });
    return h.replace(path, state, { ...opts, ignoreBlocker: true });
  };
  // Only a step through the history (Back, Forward): a link or a sheet's own Save goes where it goes.
  h.block({
    blockerFn: ({ action }) => action !== 'PUSH' && action !== 'REPLACE' && backHandled(),
    enableBeforeUnload: false,
  });
  return h;
}
