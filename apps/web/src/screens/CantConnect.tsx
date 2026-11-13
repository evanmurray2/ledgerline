// Shown when the app opens and can't reach the server, with no saved copy to show instead (no signal, or
// Cloudflare's daily limit ran out). It tries again by itself when the signal comes back or the app comes back to
// the screen, and has a Try again button: a Home Screen app has no reload button.
import { useEffect, useRef } from 'react';
import { ErrorNote } from '../components/ui';
import { SecondaryButton } from '../components/buttons';
import { connectivity } from '../state/connectivity';

export function CantConnect({ error, retry }: { error: unknown; retry: () => void }) {
  const again = useRef(retry);
  again.current = retry;
  useEffect(() => {
    const onOnline = () => again.current();
    const onVisible = () => {
      if (document.visibilityState === 'visible') again.current();
    };
    // The app's own check (state/connectivity.ts) found the server again.
    let wasOffline = connectivity.isOffline();
    const stop = connectivity.subscribe(() => {
      const offline = connectivity.isOffline();
      if (wasOffline && !offline) again.current();
      wasOffline = offline;
    });
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return (
    <div className="flex flex-col gap-3 p-4">
      <ErrorNote error={error} />
      <SecondaryButton type="button" data-track="app.retry" onClick={retry}>
        Try again
      </SecondaryButton>
    </div>
  );
}
