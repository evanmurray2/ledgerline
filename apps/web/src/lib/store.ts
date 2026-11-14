// Small stores outside React, read with useSyncExternalStore: one set of listeners each, made the same way.
import { useSyncExternalStore } from 'react';

export interface Listeners {
  /** Adds a listener; gives the function that removes it (useSyncExternalStore's `subscribe`). */
  subscribe(cb: () => void): () => void;
  /** Calls every listener. */
  emit(): void;
}

/** A set of listeners, for a store whose value is read some other way (a stack, localStorage). */
export function createListeners(): Listeners {
  const listeners = new Set<() => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit() {
      for (const l of listeners) l();
    },
  };
}

export interface Store<T> extends Listeners {
  get(): T;
  /** Replaces the value and tells every listener (even when it is the same). */
  set(value: T): void;
  /** The value in a component, which renders again when it changes. */
  use(): T;
}

/** A value with listeners. */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const { subscribe, emit } = createListeners();
  const get = () => value;
  return {
    subscribe,
    emit,
    get,
    set(next) {
      value = next;
      emit();
    },
    // A hook: called from components and hooks only.
    use: () => useSyncExternalStore(subscribe, get, get),
  };
}
