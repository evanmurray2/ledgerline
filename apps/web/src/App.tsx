import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { BUILD_ID, SAVED_MAX_AGE, makePersister, savingEnabled } from './state/saved';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { makeRouter } from './router';
import { ApiError } from './api/client';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Keep showing the last loaded data when offline; don't retry client errors.
        networkMode: 'offlineFirst',
        // Each screen reads every transaction from the database, so refetch on focus only when data is older than this.
        staleTime: 120_000,
        gcTime: 24 * 60 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}

export function App({ history, queryClient }: { history?: RouterHistory; queryClient?: QueryClient }) {
  const [qc] = useState(() => queryClient ?? makeQueryClient());
  const [router] = useState(() => makeRouter(history));
  const [persister] = useState(() => (savingEnabled() && !queryClient ? makePersister() : null));
  if (persister)
    return (
      <PersistQueryClientProvider
        client={qc}
        persistOptions={{
          persister,
          maxAge: SAVED_MAX_AGE,
          buster: BUILD_ID,
          // Never the session: the app always confirms you're signed in before it shows saved screens.
          dehydrateOptions: {
            shouldDehydrateQuery: (q) => q.state.status === 'success' && q.queryKey[0] !== 'session',
          },
        }}
        // Saved screens are shown at once, then each checks for changes with its ETag (a couple of rows read when
        // nothing changed). Without this, a screen saved within staleTime would trust its copy, and a change made
        // just before leaving (saved data is written at most every 2 s) could show stale for up to 2 minutes.
        onSuccess={() => void qc.invalidateQueries()}
      >
        <RouterProvider router={router} />
      </PersistQueryClientProvider>
    );
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
