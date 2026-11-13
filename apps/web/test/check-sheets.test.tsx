// Check these and Check not cleared against the mock API (the real engine over November 2026): Accept a row that
// cleared at another amount, with Undo, and a new date for an entry you added. Each checks what the copy stored.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer } from '../src/mock/server';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';

let server: MockServer;

function show(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

const sql = async <T,>(q: string) => (await server.db()).prepare(q).first<T>();

const T = { timeout: 8000 };

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  server = installMock('default', 0, (now) => novemberCopy(now));
});
afterEach(() => cleanup());

describe('Check these: a row that cleared at another amount', () => {
  it('Accept takes the bank’s amount, and Undo asks again', async () => {
    show('/activity?filter=attention');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept Shake Shack at $28.10' }, T));
    await screen.findByText('Shake Shack · $28.10 accepted', undefined, T);
    await waitFor(
      () => expect(screen.queryByRole('button', { name: 'Accept Shake Shack at $28.10' })).toBeNull(),
      T,
    );
    const reviewed = () =>
      sql<{ r: number | null }>(`SELECT reviewed_at AS r FROM txn_overlay WHERE txn_key = 'n-shakeshack'`);
    expect((await reviewed())!.r).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByRole('button', { name: 'Accept Shake Shack at $28.10' }, T);
    expect((await reviewed())!.r).toBeNull();
  }, 20_000);
});

describe('Check not cleared', () => {
  it('Fix the amount or date saves the day the check was written', async () => {
    show('/activity/check/n-check-1043');
    fireEvent.click(await screen.findByRole('button', { name: /^Fix the amount or date/ }, T));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved. It keeps waiting for the bank.', undefined, T);
    expect(
      (await sql<{ date: string; amount: number }>(
        `SELECT date, amount FROM manual_pending WHERE txn_key = 'n-check-1043'`,
      ))!,
    ).toEqual({ date: '2026-11-03', amount: -12000 });
  }, 20_000);

  it('a later day is refused: a pending entry stays today or earlier', async () => {
    show('/activity/check/n-check-1043');
    fireEvent.click(await screen.findByRole('button', { name: /^Fix the amount or date/ }, T));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-12-03' } });
    await screen.findByText('Pick today or an earlier date', undefined, T);
  }, 20_000);
});

describe('Transaction sheet: an entry you added', () => {
  it('saves a new date', async () => {
    show('/activity/txn/n-check-1043');
    fireEvent.change(await screen.findByLabelText('Date', undefined, T), { target: { value: '2026-11-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const day = async () =>
      (await sql<{ date: string }>(`SELECT date FROM manual_pending WHERE txn_key = 'n-check-1043'`))!.date;
    await waitFor(async () => expect(await day()).toBe('2026-11-04'), T);
  }, 20_000);
});
