// Opening the app signed out: the "signed out" clean-up must not drop the sign-in screen's own check while it loads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../src/App';
import { onSignedOutQueries } from '../src/router';
import { SignInScreen } from '../src/screens/Auth';

afterEach(cleanup);

describe('signed out', () => {
  it('shows first-time setup when the clean-up runs while the sign-in check is loading', async () => {
    let answer!: (r: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((r) => (answer = r))) as typeof fetch;
    const qc = makeQueryClient();
    qc.setQueryData(['budget', '2026-11'], { saved: true });
    render(
      <QueryClientProvider client={qc}>
        <SignInScreen />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    onSignedOutQueries(qc);
    answer(
      new Response(JSON.stringify({ signedIn: false, hasPasskey: false, setupOpen: true }), { status: 200 }),
    );
    expect(await screen.findByRole('heading', { name: 'Set up sign-in' })).toBeTruthy();
    // The budget's saved data still goes.
    expect(qc.getQueryData(['budget', '2026-11'])).toBeUndefined();
  });
});
