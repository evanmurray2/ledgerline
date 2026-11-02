// Whether this tab can change data right now. Offline (navigator.onLine false, or the last request failed at
// the network level) and the daily-limit read-only state both make the app view-only: the last loaded data
// stays visible and every control that changes data is disabled. Nothing is queued.
import { useSyncExternalStore } from 'react';

interface State {
  online: boolean;
  networkFailed: boolean;
  /** Session.writeState === 'readonly' or 'moving' */
  readOnly: boolean;
  /** Session.writeState === 'moving': the data is being moved (a few minutes). */
  moving: boolean;
  readOnlyUntil: string | null;
  /** When the data on screen was last loaded (epoch ms). */
  loadedAt: number | null;
}

let state: State = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  networkFailed: false,
  readOnly: false,
  moving: false,
  readOnlyUntil: null,
  loadedAt: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  const next = { ...state, ...patch };
  if (
    next.online === state.online &&
    next.networkFailed === state.networkFailed &&
    next.readOnly === state.readOnly &&
    next.moving === state.moving &&
    next.readOnlyUntil === state.readOnlyUntil &&
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
  },
  reportOk() {
    set({ networkFailed: false, loadedAt: Date.now() });
  },
  setReadOnly(readOnly: boolean, until: string | null, moving = false) {
    set({ readOnly: readOnly || moving, readOnlyUntil: until, moving });
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

let installed = false;
export function installConnectivityListeners() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('online', () => connectivity.setOnline(true));
  window.addEventListener('offline', () => connectivity.setOnline(false));
}

export function useConnectivity(): State {
  return useSyncExternalStore(connectivity.subscribe, connectivity.get, connectivity.get);
}

/** False while offline or read-only: every control that changes data uses this. */
export function useCanWrite(): boolean {
  const s = useConnectivity();
  return s.online && !s.networkFailed && !s.readOnly;
}
