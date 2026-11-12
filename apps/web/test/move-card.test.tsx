// Settings → Privacy, the card that moves a budget to its locked form (screens/settings/Move.tsx). The keys and
// the engine are stood in for: what is checked here is the order of the steps and what each one shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../src/App';
import { resetRecentChanges } from '../src/api/client';

const copy = vi.hoisted(() => ({
  moveStart: vi.fn(),
  moveFinish: vi.fn(),
  moveGiveUp: vi.fn(),
  moveBack: vi.fn(),
}));
vi.mock('../src/copy/copy', async (orig) => ({ ...(await orig<object>()), ...copy }));

import { MoveCard } from '../src/screens/settings/Move';

const KEY = 'able baker charlie delta';
let state: { open: boolean; sealed: boolean; backUntil: string | null };
let blocks: string[];
let posts: string[];

beforeEach(() => {
  state = { open: true, sealed: false, backUntil: null };
  blocks = [];
  posts = [];
  resetRecentChanges();
  for (const f of Object.values(copy)) f.mockReset();
  copy.moveStart.mockResolvedValue({ recoveryText: KEY });
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') posts.push(path);
    const body = path.endsWith('/state')
      ? state
      : path.endsWith('/ready')
        ? { ok: true, blocks }
        : { ok: true };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(cleanup);

const show = () =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <MoveCard />
    </QueryClientProvider>,
  );

describe('the card that locks a budget', () => {
  it('shows nothing while the move is closed', async () => {
    state = { open: false, sealed: false, backUntil: null };
    show();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('move-card')).toBeNull();
  });

  it('says what stands in the way and makes no key', async () => {
    blocks = ['A bank link has not been checked yet.'];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Lock my budget' }));
    expect(await screen.findByText('A bank link has not been checked yet.')).toBeTruthy();
    expect(copy.moveStart).not.toHaveBeenCalled();
  });

  it('shows the recovery key, asks for it back, and locks the budget', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Lock my budget' }));
    expect((await screen.findByTestId('recovery-key')).textContent).toBe(KEY);
    // The key must be saved before the next step.
    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true').toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The key is not on the screen while it is typed back.
    expect(screen.queryByTestId('recovery-key')).toBeNull();

    // A slip of the finger: the same key stays in hand.
    copy.moveFinish.mockResolvedValueOnce({
      ok: false,
      why: 'That is not the recovery key shown. Check it and try again.',
      retype: true,
    });
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: 'able baker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock my budget' }));
    expect(
      await screen.findByText('That is not the recovery key shown. Check it and try again.'),
    ).toBeTruthy();
    expect(copy.moveGiveUp).not.toHaveBeenCalled();

    copy.moveFinish.mockImplementationOnce(async () => {
      state = { open: false, sealed: true, backUntil: '2026-11-19T12:00:00.000Z' };
      return { ok: true };
    });
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock my budget' }));
    expect(await screen.findByText('Your budget is locked.')).toBeTruthy();
    expect(copy.moveFinish).toHaveBeenLastCalledWith({ recoveryText: KEY }, KEY);
    // The way back: asked twice, then taken on the server first and on the device after.
    fireEvent.click(await screen.findByRole('button', { name: 'Go back to how it was…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    await waitFor(() => expect(copy.moveBack).toHaveBeenCalled());
    expect(posts.at(-1)).toMatch(/\/api\/cutover\/back$/);
  });
});
