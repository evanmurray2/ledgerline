// The notices card of a locked budget (screens/SealedNotices.tsx; copy/notices.ts; docs/privacy.md 5.8), with the
// copy's look at the log stubbed: what each notice says, This was me, and Cancel this change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { type Entry, KIND } from '@ledgerline/seal';

const m = vi.hoisted(() => ({
  publicLook: vi.fn(),
  withBudgetKey: vi.fn(),
}));
vi.mock('../src/copy/copy', async (orig) => ({
  ...(await orig<object>()),
  useCopy: () => ({ status: 'ready' }),
  isSealed: () => true,
  sealedSession: () => null,
  publicLook: m.publicLook,
  withBudgetKey: m.withBudgetKey,
}));
vi.mock('../src/api/hooks', async (orig) => ({
  ...(await orig<object>()),
  useSession: () => ({ data: undefined }),
}));
vi.mock('../src/copy/notices', async (orig) => ({
  ...(await orig<object>()),
  // The log's bodies are not built here: the key change at 9 removed a passkey.
  waysRemoved: () => new Map([[9, ['p:lost']]]),
}));

import { makeQueryClient } from '../src/App';
import { SealedNotices } from '../src/screens/SealedNotices';
import { dismissedNotices } from '../src/copy/notices';
import { toast } from '../src/components/Toast';
import { SYNCED_ENTRIES } from '../src/copy/copy';

const DAY = 86_400_000;
const ME = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const BUDGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const entry = (number: number, kind: number, deviceId: string, time: number) =>
  ({ header: { number, kind, deviceId, time } }) as unknown as Entry;

function look(entries: Entry[], intents = new Map<number, { notBefore: number; slotIds: string[] }>()) {
  return {
    entries,
    state: { intents },
    deviceIds: [ME],
    budgetId: BUDGET,
    session: { recoveryKeyUsedAt: null },
  };
}

const show = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <SealedNotices />
    </QueryClientProvider>,
  );

beforeEach(() => {
  m.publicLook.mockReset();
  m.withBudgetKey.mockReset();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the notices card', () => {
  it('shows nothing when there is nothing to tell', async () => {
    m.publicLook.mockResolvedValue(look([entry(3, KIND.slotChange, ME, Date.now() - DAY)]));
    show();
    await waitFor(() => expect(m.publicLook).toHaveBeenCalled());
    expect(screen.queryByTestId('sealed-notices')).toBeNull();
  });

  it('reads the log again right after a sync that brought entries', async () => {
    m.publicLook.mockResolvedValue(look([entry(3, KIND.slotChange, ME, Date.now() - DAY)]));
    show();
    await waitFor(() => expect(m.publicLook).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('sealed-notices')).toBeNull();
    // Another device added a way in; this device's next sync reads it.
    m.publicLook.mockResolvedValue(look([entry(4, KIND.slotChange, OTHER, Date.now() - 1000)]));
    window.dispatchEvent(new Event(SYNCED_ENTRIES));
    await waitFor(() => expect(m.publicLook).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('sealed-notices')).toBeTruthy();
  });

  it('tells of a way in added and one removed on another device; This was me hides one here', async () => {
    m.publicLook.mockResolvedValue(
      look([
        entry(5, KIND.slotChange, OTHER, Date.now() - 2 * DAY),
        entry(9, KIND.keyChange, OTHER, Date.now() - DAY),
      ]),
    );
    show();
    expect(await screen.findByText(/^A way in was removed on /)).toBeTruthy();
    expect(
      screen.getByText(/A passkey no longer opens your budget: another device removed it\./),
    ).toBeTruthy();
    expect(screen.getByText(/^A way in was added on /)).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'This was me' })[0]!);
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(dismissedNotices(BUDGET)).toEqual(['removed:9']);
    expect(screen.queryByText(/^A way in was removed on /)).toBeNull();
  });

  it('a change planned on another device can be cancelled here', async () => {
    const intents = new Map([[4, { notBefore: Date.now() + 3 * DAY, slotIds: ['r:old'] }]]);
    m.publicLook.mockResolvedValue(look([entry(4, KIND.intent, OTHER, Date.now() - DAY)], intents));
    m.withBudgetKey.mockResolvedValue({ ok: true });
    const said = vi.spyOn(toast, 'show');
    show();
    expect(await screen.findByText(/^A change is planned for /)).toBeTruthy();
    expect(screen.getByText(/Your old recovery key stops opening your budget then\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this change' }));
    await waitFor(() => expect(m.withBudgetKey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(said).toHaveBeenCalledWith({ text: 'Cancelled. Nothing changes.' }));
  });

  it('a planned change that is due offers Finish now on every device', async () => {
    const intents = new Map([[4, { notBefore: Date.now() - 1, slotIds: ['p:a', 'p:b'] }]]);
    m.publicLook.mockResolvedValue(look([entry(4, KIND.intent, ME, Date.now() - 8 * DAY)], intents));
    show();
    expect(await screen.findByText('Your planned change is due')).toBeTruthy();
    expect(screen.getByText(/Some of your ways in stops opening your budget when you finish\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish now' })).toBeTruthy();
  });
});
