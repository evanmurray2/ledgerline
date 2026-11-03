// The app's data saved on this device, so it opens instantly with the last screens while it checks for changes
// (each screen revalidates with its ETag: a couple of rows read when nothing changed). Only in the production app,
// never in the mock or tests. Signing out, or the session ending, clears it.
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { PersistedClient } from '@tanstack/react-query-persist-client';

declare const __BUILD_ID__: string;

export const SAVED_KEY = 'ledgerline-saved-data';
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
/** Saved data older than this is ignored. */
export const SAVED_MAX_AGE = 24 * 60 * 60 * 1000;

export function savingEnabled(): boolean {
  // Off since D-45: the encrypted copy (src/copy) replaces plain saved screens. clearSavedData() removes old ones.
  return false;
}

export function makePersister() {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return createSyncStoragePersister({ storage, key: SAVED_KEY, throttleTime: 2000, retry: dropLargest });
}

/**
 * When the phone's storage for this site is full (Safari allows about 5 MB), save without the largest screen and
 * try again, until it fits. The screens left out load from the server as usual; nothing on screen changes.
 */
export function dropLargest({
  persistedClient,
}: {
  persistedClient: PersistedClient;
  error: Error;
  errorCount: number;
}): PersistedClient | undefined {
  const queries = persistedClient.clientState.queries;
  if (!queries.length) return undefined;
  let largest = 0;
  let size = -1;
  queries.forEach((q, i) => {
    const n = JSON.stringify(q).length;
    if (n > size) [largest, size] = [i, n];
  });
  return {
    ...persistedClient,
    clientState: { ...persistedClient.clientState, queries: queries.filter((_, i) => i !== largest) },
  };
}

export function clearSavedData(): void {
  try {
    window.localStorage.removeItem(SAVED_KEY);
  } catch {
    // Storage blocked: nothing was saved.
  }
}
