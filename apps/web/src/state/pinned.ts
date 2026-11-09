// Pinned categories: the ones shown again in a Pinned group at the top of Budget, in the order they were pinned.
// Saved per device, like folded groups: it changes only what shows first, never any money.
import { useSyncExternalStore } from 'react';

export const PINNED_KEY = 'ledgerline-pinned';

let memory: string[] = [];
let cached: string[] | null = null;
const listeners = new Set<() => void>();

function read(): string[] {
  if (cached) return cached;
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(PINNED_KEY) ?? '[]');
    cached = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // storage blocked: this tab's memory only
    cached = memory;
  }
  return cached;
}

function write(ids: string[]) {
  memory = ids;
  cached = ids;
  try {
    window.localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
  } catch {
    // per-device convenience only
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PINNED_KEY) return;
    cached = null;
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function togglePinned(id: string) {
  const ids = read();
  write(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
}

/** The pinned category ids, oldest pin first. */
export function usePinned(): string[] {
  return useSyncExternalStore(subscribe, read, () => memory);
}
