// lib/resume-link.ts: back from Plaid's site, the app says what the link came to.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resumeHostedLink = vi.fn();
const refreshConnection = vi.fn();
const show = vi.fn();
vi.mock('../src/lib/plaid', () => ({ resumeHostedLink }));
vi.mock('../src/api/endpoints', () => ({ api: { refreshConnection } }));
vi.mock('../src/components/Toast', () => ({ toast: { show } }));

const { useResumeLink } = await import('../src/lib/resume-link');

function Resume() {
  useResumeLink();
  return null;
}
function mount(): QueryClient {
  const qc = new QueryClient();
  vi.spyOn(qc, 'invalidateQueries');
  const wrap = (c: ReactNode) => <QueryClientProvider client={qc}>{c}</QueryClientProvider>;
  render(wrap(<Resume />));
  return qc;
}

beforeEach(() => {
  resumeHostedLink.mockReset();
  refreshConnection.mockReset().mockResolvedValue({ ok: true });
  show.mockReset();
});

afterEach(cleanup);

describe('useResumeLink', () => {
  it('a new link: says so, and reads every screen again', async () => {
    resumeHostedLink.mockResolvedValue({ status: 'linked', connectionId: 'c1' });
    const qc = mount();
    await waitFor(() => expect(qc.invalidateQueries).toHaveBeenCalled());
    expect(show).toHaveBeenCalledWith({ text: 'Linked. Transactions show up in Activity in a few minutes.' });
    expect(refreshConnection).not.toHaveBeenCalled();
  });

  it('a repaired link refreshes its bank', async () => {
    resumeHostedLink.mockResolvedValue({ status: 'repaired', connectionId: 'c2' });
    const qc = mount();
    await waitFor(() => expect(qc.invalidateQueries).toHaveBeenCalled());
    expect(refreshConnection).toHaveBeenCalledWith('c2');
    expect(show).toHaveBeenCalledWith({ text: 'Signed in again. Its transactions are on the way.' });
  });

  it('nothing to resume, or Plaid closed: no toast', async () => {
    resumeHostedLink.mockResolvedValue({ status: 'exited' });
    const qc = mount();
    await waitFor(() => expect(qc.invalidateQueries).toHaveBeenCalled());
    resumeHostedLink.mockResolvedValue(null);
    mount();
    await waitFor(() => expect(resumeHostedLink).toHaveBeenCalledTimes(2));
    expect(show).not.toHaveBeenCalled();
  });

  it('an error is shown', async () => {
    resumeHostedLink.mockRejectedValue(new Error('No signal.'));
    mount();
    await waitFor(() => expect(show).toHaveBeenCalled());
  });
});
