// /link-done: where Plaid's site sends the person after hosted Link (docs/privacy.md 5.7). This page finishes
// nothing: the app that started the link asks the server what happened. It is shown before any sign-in check,
// because the return can land in a browser that isn't signed in (the Home Screen app keeps its own sign-in).
import { useEffect, useState } from 'react';
import { LEFT_HERE_KEY } from '../lib/plaid';
import { appPath } from '../lib/back';

/** Where to go back into the app: the page that left for Plaid's site (Bank connections, or Accounts' repair). */
function returnPath(left: string | null): string | null {
  if (left === null) return null;
  // '1': kept by an older version of the app, before the page was kept.
  return appPath(left) ?? '/settings/connections';
}

export function LinkDoneScreen() {
  const [here, setHere] = useState(true);
  useEffect(() => {
    let left: string | null = null;
    try {
      left = returnPath(sessionStorage.getItem(LEFT_HERE_KEY));
      sessionStorage.removeItem(LEFT_HERE_KEY);
    } catch {
      // No storage: say where to go.
    }
    // This page itself went to Plaid's site: go back into the app, to the page it left, which finishes the link.
    if (left) window.location.replace(left);
    // Another browser than the one that started (the Home Screen app shows Plaid's site in a sheet): say where to go.
    else setHere(false);
  }, []);
  if (here) return null;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-bg px-6 text-center text-ink">
      <h1 className="m-0 text-xl font-bold">Done</h1>
      <p className="m-0 text-base text-ink-2">Close this page and go back to Ledgerline.</p>
    </main>
  );
}
