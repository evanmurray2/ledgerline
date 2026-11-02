// Offline start (api/hooks.ts useSession): the saved session stands in only when the server can't be reached.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { qk, useSession } from '../src/api/hooks';
import { connectivity } from '../src/state/connectivity';
import { makeQueryClient } from '../src/App';

const saved = { appVersion: 'x', budget: { currentMonth: '2026-11' } };

function setup(respond: () => Promise<Response>) {
  globalThis.fetch = vi.fn(respond) as typeof fetch;
  const qc: QueryClient = makeQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } });
  qc.setQueryData(qk.savedSession, saved);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSession(), { wrapper });
}

afterEach(() => {
  cleanup();
  connectivity.reportOk();
  connectivity.setOnline(true);
});

describe('offline start', () => {
  it('uses the last confirmed session when the server cannot be reached', async () => {
    const { result } = setup(() => Promise.reject(new TypeError('Failed to fetch')));
    await waitFor(() => expect(result.current.data).toEqual(saved));
    expect(connectivity.canWrite()).toBe(false);
  });

  it('never after the server says you are signed out', async () => {
    const { result } = setup(
      async () =>
        new Response(JSON.stringify({ error: 'unauthenticated', message: 'Sign in' }), { status: 401 }),
    );
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeUndefined();
  });
});
