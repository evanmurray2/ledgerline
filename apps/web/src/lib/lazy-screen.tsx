// Screens opened now and then load when first opened (router.tsx). The service worker saves every one of them with
// the release (public/sw.js), so they open with no signal too. If a screen still can't load, the app reloads only
// when that is safe: online, with no edit waiting to send. A reload with no signal would leave the app stuck on
// "You're offline", and a reload with edits waiting loses them on a device that keeps no saved copy. Otherwise the
// screen says why it can't open, and tries again when the signal is back.
import { createElement, useEffect, type ComponentType, type ReactElement } from 'react';
import { getCopy } from '../copy/copy';
import { connectivity } from '../state/connectivity';
import { errorMessage } from '../api/client';
import { SecondaryButton } from '../components/buttons';

/** A screen's code couldn't be loaded, and reloading the app wasn't safe. */
export class ScreenLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenLoadError';
  }
}

const failed = new Set<{ error: unknown }>();

/** Online with nothing waiting to send: a reload loses nothing. */
function safeToReload(): boolean {
  const online = typeof navigator === 'undefined' || navigator.onLine;
  return online && !connectivity.isOffline() && getCopy().queued === 0;
}

function loadProblem(): ScreenLoadError {
  if (getCopy().queued > 0 && !connectivity.isOffline() && navigator.onLine)
    return new ScreenLoadError('This screen couldn’t load. Try again once your changes are sent.');
  return new ScreenLoadError('This screen isn’t saved on this device yet. It opens when you’re back online.');
}

/** Lets every screen that failed to load try again (Try again, or the signal came back). */
export function retryScreens(): void {
  for (const f of failed) f.error = undefined;
  failed.clear();
}

/** A route component that loads `name` from `importer` when first shown (like TanStack's lazyRouteComponent). */
export function lazyScreen<M extends Record<string, unknown>>(
  importer: () => Promise<M>,
  name: keyof M & string,
): ((props: Record<string, unknown>) => ReactElement) & { preload: () => Promise<void> } {
  let comp: ComponentType<Record<string, unknown>> | undefined;
  let loading: Promise<void> | undefined;
  const slot: { error: unknown } = { error: undefined };
  const load = () =>
    (loading ??= importer().then(
      (m) => {
        comp = m[name] as ComponentType<Record<string, unknown>>;
      },
      (e: unknown) => {
        loading = undefined;
        slot.error = e;
        failed.add(slot);
      },
    ));
  function Lazy(props: Record<string, unknown>) {
    if (comp) return createElement(comp, props);
    if (slot.error !== undefined) {
      // A new release replaced the files this page knew: load the new one, once.
      const key = `ledgerline_screen_reload:${name}`;
      if (safeToReload() && typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
        throw new Promise(() => undefined);
      }
      throw loadProblem();
    }
    throw load();
  }
  Lazy.preload = load;
  return Lazy;
}

/** What a route shows when it fails: the reason, and Try again. A screen that couldn't load tries again by itself. */
export function RouteProblem({ error, reset }: { error: unknown; reset: () => void }) {
  const unsaved = error instanceof ScreenLoadError;
  useEffect(() => {
    if (!unsaved) return;
    const again = () => {
      if (connectivity.isOffline() || !navigator.onLine) return;
      retryScreens();
      reset();
    };
    window.addEventListener('online', again);
    const stop = connectivity.subscribe(again);
    return () => {
      window.removeEventListener('online', again);
      stop();
    };
  }, [unsaved, reset]);
  return (
    <div className="flex flex-col gap-3 p-4">
      <p role="alert" className="m-0 rounded-lg bg-over-bg p-3 text-md text-over-fg">
        {unsaved ? error.message : errorMessage(error)}
      </p>
      <SecondaryButton
        type="button"
        data-track="route.retry"
        onClick={() => {
          retryScreens();
          reset();
        }}
      >
        Try again
      </SecondaryButton>
    </div>
  );
}
