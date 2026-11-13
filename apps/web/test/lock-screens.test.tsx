// The lock screen of a new budget (screens/Setup.tsx LockBudgetScreen, D-102) and Settings → Sign-in → Recovery key
// (screens/RecoveryKey.tsx RecoveryKeyCard), with the copy's key work stubbed: what each step shows, what it
// refuses, and when the key in hand is given up. e2e/tests/lock.spec.ts and screens-lock.spec.ts run both for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { NewBudget } from '../src/keys/new-budget';

const m = vi.hoisted(() => ({
  lockStart: vi.fn(),
  lockFinish: vi.fn(),
  lockGiveUp: vi.fn(),
  checkRecoveryKey: vi.fn(),
  recoveryKey: vi.fn(),
  setRecoveryKey: vi.fn(),
}));
vi.mock('../src/copy/copy', async (orig) => ({
  ...(await orig<object>()),
  lockStart: m.lockStart,
  lockFinish: m.lockFinish,
  lockGiveUp: m.lockGiveUp,
  checkRecoveryKey: m.checkRecoveryKey,
}));
vi.mock('../src/api/endpoints', async (orig) => {
  const o = await orig<{ api: object }>();
  return { ...o, api: { ...o.api, recoveryKey: m.recoveryKey, setRecoveryKey: m.setRecoveryKey } };
});

import { makeQueryClient } from '../src/App';
import { LockBudgetScreen } from '../src/screens/Setup';
import { RecoveryKeyCard } from '../src/screens/RecoveryKey';

const KEY = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ';
const made = { recoveryText: KEY } as NewBudget;

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.lockStart.mockResolvedValue(made);
});
afterEach(cleanup);

const button = (name: string) => screen.getByRole('button', { name });
const disabled = (name: string) => button(name).hasAttribute('disabled');

describe('the lock screen of a new budget', () => {
  it('shows the key once, asks that it is saved, and locks with the key typed back', async () => {
    m.lockFinish.mockResolvedValue({ ok: true });
    render(<LockBudgetScreen />);
    expect(screen.getByRole('heading', { name: 'Lock your budget' })).toBeTruthy();
    fireEvent.click(button('Make my recovery key'));
    expect((await screen.findByTestId('recovery-key')).textContent).toBe(KEY);
    expect(m.lockStart).toHaveBeenCalledTimes(1);
    // Continue waits for "I saved my recovery key".
    expect(disabled('Continue')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Continue'));
    // The key is no longer on the screen; Lock my budget waits for something typed.
    expect(screen.queryByTestId('recovery-key')).toBeNull();
    expect(disabled('Lock my budget')).toBe(true);
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: KEY } });
    fireEvent.click(button('Lock my budget'));
    await waitFor(() => expect(m.lockFinish).toHaveBeenCalledWith(made, KEY));
    expect(m.lockGiveUp).not.toHaveBeenCalled();
  });

  it('a wrong key is typed again with the same key in hand; Show the key again goes back to it', async () => {
    m.lockFinish.mockResolvedValueOnce({
      ok: false,
      why: 'That is not the recovery key shown. Check it and try again.',
      retype: true,
    });
    render(<LockBudgetScreen />);
    fireEvent.click(button('Make my recovery key'));
    await screen.findByTestId('recovery-key');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Continue'));
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: 'not the key' } });
    fireEvent.click(button('Lock my budget'));
    expect(
      await screen.findByText('That is not the recovery key shown. Check it and try again.'),
    ).toBeTruthy();
    expect(screen.getByTestId('recovery-key-typed')).toBeTruthy();
    fireEvent.click(button('Show the key again'));
    expect(screen.getByTestId('recovery-key').textContent).toBe(KEY);
    // The same key: no new one was made.
    expect(m.lockStart).toHaveBeenCalledTimes(1);
  });

  it('a start that took too long goes back to the start, to make a new key', async () => {
    m.lockFinish.mockResolvedValueOnce({
      ok: false,
      why: 'This took too long. Start again: a new recovery key is made.',
    });
    render(<LockBudgetScreen />);
    fireEvent.click(button('Make my recovery key'));
    await screen.findByTestId('recovery-key');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Continue'));
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: KEY } });
    fireEvent.click(button('Lock my budget'));
    expect(
      await screen.findByText('This took too long. Start again: a new recovery key is made.'),
    ).toBeTruthy();
    expect(button('Make my recovery key')).toBeTruthy();
  });

  it('says what went wrong when the key could not be made', async () => {
    m.lockStart.mockRejectedValueOnce(new Error('Cancelled. Try again when you’re ready.'));
    render(<LockBudgetScreen />);
    fireEvent.click(button('Make my recovery key'));
    expect(await screen.findByText('Cancelled. Try again when you’re ready.')).toBeTruthy();
    expect(screen.queryByTestId('recovery-key')).toBeNull();
  });

  it('gives the key in hand up when the screen closes', async () => {
    const r = render(<LockBudgetScreen />);
    fireEvent.click(button('Make my recovery key'));
    await screen.findByTestId('recovery-key');
    r.unmount();
    expect(m.lockGiveUp).toHaveBeenCalledWith(made);
  });
});

describe('Settings → Sign-in → Recovery key', () => {
  const show = () =>
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <RecoveryKeyCard />
      </QueryClientProvider>,
    );

  it('a key that can’t sign in yet: set it up by typing it', async () => {
    m.recoveryKey.mockResolvedValue({ set: false });
    m.checkRecoveryKey.mockResolvedValue('auth-pub');
    m.setRecoveryKey.mockResolvedValue({ ok: true });
    show();
    expect(await screen.findByText(/Your recovery key can’t sign in yet/)).toBeTruthy();
    fireEvent.click(button('Set up sign-in with it'));
    expect(disabled('Set up')).toBe(true);
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: KEY } });
    fireEvent.click(button('Set up'));
    await waitFor(() => expect(m.setRecoveryKey).toHaveBeenCalledWith('auth-pub'));
    expect(m.checkRecoveryKey).toHaveBeenCalledWith(KEY);
    // Back to the card, which asks the server again.
    expect(await screen.findByRole('button', { name: 'Make a new recovery key' })).toBeTruthy();
    await waitFor(() => expect(m.recoveryKey).toHaveBeenCalledTimes(2));
  });

  it('a key that isn’t this budget’s is refused, and Cancel goes back', async () => {
    m.recoveryKey.mockResolvedValue({ set: false });
    m.checkRecoveryKey.mockRejectedValue(new Error('That isn’t your recovery key. Check it and try again.'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up sign-in with it' }));
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: 'nope' } });
    fireEvent.click(button('Set up'));
    expect(await screen.findByText('That isn’t your recovery key. Check it and try again.')).toBeTruthy();
    expect(m.setRecoveryKey).not.toHaveBeenCalled();
    fireEvent.click(button('Cancel'));
    expect(await screen.findByRole('button', { name: 'Set up sign-in with it' })).toBeTruthy();
  });

  it('a key that signs in: no set-up, and a new key is shown once, then must be typed back exactly', async () => {
    m.recoveryKey.mockResolvedValue({ set: true });
    show();
    expect(await screen.findByText(/It opens your budget and signs you in/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up sign-in with it' })).toBeNull();
    fireEvent.click(button('Make a new recovery key'));
    const shown = (await screen.findByTestId('recovery-key')).textContent!;
    expect(shown.length).toBeGreaterThan(20);
    expect(disabled('Continue')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Continue'));
    fireEvent.change(screen.getByTestId('recovery-key-typed'), { target: { value: KEY } });
    fireEvent.click(button('Use the new key'));
    expect(
      await screen.findByText('That is not the recovery key shown. Check it and try again.'),
    ).toBeTruthy();
    fireEvent.click(button('Show the key again'));
    expect(screen.getByTestId('recovery-key').textContent).toBe(shown);
    fireEvent.click(button('Cancel'));
    expect(await screen.findByRole('button', { name: 'Make a new recovery key' })).toBeTruthy();
    expect(m.setRecoveryKey).not.toHaveBeenCalled();
  });
});
