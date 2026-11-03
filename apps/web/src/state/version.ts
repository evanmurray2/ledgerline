// A new release reaches a Home Screen app that stays open for days. The server reports its version on every
// session check; when it differs from the version this code was built as, the app reloads to pick up the new code,
// so an old screen never meets a changed API. It reloads only at a quiet moment (not while you are typing), and at
// most once per server version, so a cached page can't make it loop.
declare const __APP_VERSION__: string;

export const BUILT_AS = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const KEY = 'ledgerline-reloaded-for';

/** The version a reload was last tried for (per tab). */
function triedFor(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Whether a server reporting `serverVersion` needs this tab to load the new code. */
export function needsReload(serverVersion: string, built = BUILT_AS): boolean {
  if (built === 'dev' || !serverVersion || serverVersion === built) return false;
  return triedFor() !== serverVersion;
}

/**
 * Whether the copy is in a state a reload can't hurt. While it is idle or opening, a sign-in may have just returned
 * the passkey's key for the saved copy, held in memory only: reloading then would lose it and ask for Face ID a
 * second time. Once the copy is open its key is held for a refresh (vault.ts holdKey), so the reload reopens it
 * without Face ID.
 */
export function copySettled(status: string): boolean {
  return status !== 'idle' && status !== 'opening';
}

function typing(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/**
 * Reloads now if nothing is being typed, or else the next time the app is hidden or shown again. Returns a cleanup
 * for the waiting listener.
 */
export function reloadForVersion(serverVersion: string, reload = () => window.location.reload()): () => void {
  const go = () => {
    try {
      window.sessionStorage.setItem(KEY, serverVersion);
    } catch {
      /* private mode: reload anyway; a loop is still stopped by the server version matching after reload */
    }
    reload();
  };
  if (!typing()) {
    go();
    return () => {};
  }
  const onChange = () => go();
  document.addEventListener('visibilitychange', onChange, { once: true });
  return () => document.removeEventListener('visibilitychange', onChange);
}
