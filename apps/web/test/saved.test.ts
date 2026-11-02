import { describe, expect, it } from 'vitest';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { dropLargest, makePersister, SAVED_KEY } from '../src/state/saved';

const client = (sizes: number[]): PersistedClient =>
  ({
    buster: 'b',
    timestamp: 0,
    clientState: {
      mutations: [],
      queries: sizes.map((n, i) => ({
        queryKey: [`q${i}`],
        queryHash: `q${i}`,
        state: { data: 'x'.repeat(n) },
      })),
    },
  }) as unknown as PersistedClient;

describe('saving screens on the phone', () => {
  it('when storage is full, leaves out the largest screen first, until nothing is left', () => {
    let c: PersistedClient | undefined = client([10, 5000, 20]);
    const err = new Error('QuotaExceededError');
    c = dropLargest({ persistedClient: c, error: err, errorCount: 1 });
    expect(c!.clientState.queries.map((q) => q.queryHash)).toEqual(['q0', 'q2']);
    c = dropLargest({ persistedClient: c!, error: err, errorCount: 2 });
    c = dropLargest({ persistedClient: c!, error: err, errorCount: 3 });
    expect(c!.clientState.queries).toEqual([]);
    expect(dropLargest({ persistedClient: c!, error: err, errorCount: 4 })).toBeUndefined();
  });

  it('a full storage still saves the screens that fit', async () => {
    const store = new Map<string, string>();
    const limited = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 2000) throw new Error('QuotaExceededError');
        store.set(k, v);
      },
      removeItem: (k: string) => store.delete(k),
    };
    Object.defineProperty(window, 'localStorage', { value: limited, configurable: true });
    const p = makePersister();
    await p.persistClient(client([100, 5000, 200]));
    await new Promise((r) => setTimeout(r, 2100));
    const saved = JSON.parse(store.get(SAVED_KEY)!) as PersistedClient;
    expect(saved.clientState.queries.map((q) => q.queryHash)).toEqual(['q0', 'q2']);
  });
});
