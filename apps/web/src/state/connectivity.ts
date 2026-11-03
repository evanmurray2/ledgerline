// Whether this tab can change data right now. Offline (navigator.onLine false, or the last request failed at
// the network level) and the daily-limit read-only state both make the app view-only: the last loaded data
// stays visible and every control that changes data is disabled. Nothing is queued.
import { useSyncExternalStore } from 'react';
import { useCopy } from '../copy/copy';

interface State {
  online: boolean;
  networkFailed: boolean;
  /** Session.writeState === 'readonly' */
  readOnly: boolean;
  readOnlyUntil: string | null;
  /** 95% of a daily limit (Session.readsPaused, or a 'resting' answer): no reads until the limit resets. */
  readsPaused: boolean;
  /** When the data on screen was last loaded (epoch ms). */
  loadedAt: number | null;
}

let state: State = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  networkFailed: false,
  readOnly: false,
  readOnlyUntil: null,
  readsPaused: false,
  loadedAt: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  const next = { ...state, ...patch };
  if (
    next.online === state.online &&
    next.networkFailed === state.networkFailed &&
    next.readOnly === state.readOnly &&
    next.readOnlyUntil === state.readOnlyUntil &&
    next.readsPaused === state.readsPaused &&
    next.loadedAt === state.loadedAt
  )
    return;
  state = next;
  for (const l of listeners) l();
}

export const connectivity = {
  get: () => state,
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  reportNetworkError() {
    set({ networkFailed: true });
    scheduleProbe();
  },
  /**
   * A server answered: the network works, whatever the browser's online flag says. iPhone Home Screen apps don't
   * always fire 'online' after the connection comes back, and can report offline when they aren't.
   */
  reportOk() {
    stopProbe();
    set({ online: true, networkFailed: false, loadedAt: Date.now() });
  },
  /** How the app checks the network is back after a failed request (api/client.ts registers it). */
  setProbe(fn: (() => Promise<boolean>) | null) {
    probe = fn;
  },
  setReadOnly(readOnly: boolean, until: string | null) {
    set({ readOnly, readOnlyUntil: until });
  },
  setReadsPaused(readsPaused: boolean) {
    set({ readsPaused });
  },
  /** Near a daily limit, screens check for changes less often: every request counts against it. */
  staleMs(normal: number) {
    return state.readOnly || state.readsPaused ? 15 * 60_000 : normal;
  },
  setOnline(online: boolean) {
    set({ online, networkFailed: online ? false : state.networkFailed });
  },
  isOffline() {
    return !state.online || state.networkFailed;
  },
  canWrite() {
    return state.online && !state.networkFailed && !state.readOnly;
  },
};

// After a request fails at the network level, a light check (the session) runs again after 5, 15, 30 and then
// every 60 seconds, and whenever the app comes back to the screen, so one dropped request doesn't leave changes
// turned off until some screen happens to load again.
const PROBE_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
let probe: (() => Promise<boolean>) | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeTries = 0;

function stopProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
  probeTries = 0;
}

function scheduleProbe() {
  if (probeTimer || !probe) return;
  const delay = PROBE_DELAYS_MS[Math.min(probeTries, PROBE_DELAYS_MS.length - 1)]!;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeTries++;
    void runProbe();
  }, delay);
}

async function runProbe() {
  if (!probe || (!state.networkFailed && state.online)) return stopProbe();
  const reachable = await probe().catch(() => false);
  if (reachable) {
    stopProbe();
    set({ online: true, networkFailed: false });
  } else scheduleProbe();
}

let installed = false;
export function installConnectivityListeners() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('online', () => connectivity.setOnline(true));
  window.addEventListener('offline', () => {
    connectivity.setOnline(false);
    // The flag can be wrong: check with the server, and keep checking until it answers.
    scheduleProbe();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.networkFailed || !state.online)) void runProbe();
  });
  // Opened while the browser says offline: check it.
  if (!state.online) scheduleProbe();
}

export function useConnectivity(): State {
  return useSyncExternalStore(connectivity.subscribe, connectivity.get, connectivity.get);
}

/** False while offline or read-only: every control that changes data uses this. */
/**
 * Whether a control that changes data is on. `offline`: a change the copy on this device can take with no signal
 * and send later (D-45, src/copy/copy.ts: categorizing, a transaction's details, assigning, targets).
 */
export function useCanWrite(opts: { offline?: boolean } = {}): boolean {
  const s = useConnectivity();
  const copy = useCopy();
  if (opts.offline && copy.status === 'ready' && !s.readOnly) return true;
  return s.online && !s.networkFailed && !s.readOnly;
}
