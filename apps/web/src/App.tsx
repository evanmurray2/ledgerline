import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { makeRouter } from './router';
import { ApiError } from './api/client';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Keep showing the last loaded data when offline; don't retry client errors.
        networkMode: 'offlineFirst',
        staleTime: 15_000,
        gcTime: 24 * 60 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}

export function App({ history, queryClient }: { history?: RouterHistory; queryClient?: QueryClient }) {
  const [qc] = useState(() => queryClient ?? makeQueryClient());
  const [router] = useState(() => makeRouter(history));
  return (
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
