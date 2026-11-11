// /link-done: where Plaid's site sends the person after hosted Link (docs/privacy.md 5.7). This page finishes
// nothing: the app that started the link asks the server what happened. It is shown before any sign-in check,
// because the return can land in a browser that isn't signed in (the Home Screen app keeps its own sign-in).
import { useEffect, useState } from 'react';
import { LEFT_HERE_KEY } from '../lib/plaid';

export function LinkDoneScreen() {
  const [here, setHere] = useState(true);
  useEffect(() => {
    let left = false;
    try {
      left = sessionStorage.getItem(LEFT_HERE_KEY) === '1';
      sessionStorage.removeItem(LEFT_HERE_KEY);
    } catch {
      // No storage: say where to go.
    }
    // This page itself went to Plaid's site: go back into the app, which finishes the link.
    if (left) window.location.replace('/settings/connections');
    else {
      setHere(false);
      // A tab the app opened closes itself. A browser refuses for a tab it didn't open, and the text below stays.
      window.close();
    }
  }, []);
  if (here) return null;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-bg px-6 text-center text-ink">
      <h1 className="m-0 text-xl font-bold">Done</h1>
      <p className="m-0 text-base text-ink-2">Close this page and go back to Ledgerline.</p>
    </main>
  );
}
