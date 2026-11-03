// Offline start (api/hooks.ts useSession): the saved session stands in only when the server can't be reached.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { forgetSignedOut, qk, useSession } from '../src/api/hooks';
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

describe('signed out', () => {
  it('keeps the sign-in screen’s check when the session ends while it is loading', async () => {
    // The signed-out event comes after the copy is dropped, so the sign-in screen may already be asking.
    let answer: (v: { setupOpen: boolean }) => void = () => {};
    const qc = makeQueryClient();
    qc.setQueryData(['budget', '2026-11'], { saved: true });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: qk.authStatus,
          queryFn: () => new Promise<{ setupOpen: boolean }>((r) => (answer = r)),
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('fetching'));
    forgetSignedOut(qc);
    answer({ setupOpen: true });
    await waitFor(() => expect(result.current.data).toEqual({ setupOpen: true }));
    expect(qc.getQueryData(['budget', '2026-11'])).toBeUndefined();
  });

  it('keeps it, too, when the app was showing a session', () => {
    const qc = makeQueryClient();
    qc.setQueryData(qk.session, saved);
    qc.setQueryData(qk.authStatus, { setupOpen: false });
    qc.setQueryData(['budget', '2026-11'], { saved: true });
    forgetSignedOut(qc);
    expect(qc.getQueryData(qk.session)).toBeUndefined();
    expect(qc.getQueryData(['budget', '2026-11'])).toBeUndefined();
    expect(qc.getQueryData(qk.authStatus)).toEqual({ setupOpen: false });
  });
});
