// The app's data saved on this device, so it opens instantly with the last screens while it checks for changes
// (each screen revalidates with its ETag: a couple of rows read when nothing changed). Only in the production app,
// never in the mock or tests. Signing out, or the session ending, clears it.
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';

declare const __BUILD_ID__: string;

export const SAVED_KEY = 'ledgerline-saved-data';
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
/** Saved data older than this is ignored. */
export const SAVED_MAX_AGE = 24 * 60 * 60 * 1000;

export function savingEnabled(): boolean {
  return import.meta.env.PROD && import.meta.env.VITE_MOCK !== '1';
}

export function makePersister() {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return createSyncStoragePersister({ storage, key: SAVED_KEY, throttleTime: 2000 });
}

export function clearSavedData(): void {
  try {
    window.localStorage.removeItem(SAVED_KEY);
  } catch {
    // Storage blocked: nothing was saved.
  }
}
