// Accounts, registers, Owed to you and Reports against the mock API (the real engine over November 2026): an unknown
// or finished owed item, a register's upcoming bills, and short amounts on the trend chart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer } from '../src/mock/server';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';
import { kShort } from '../src/screens/Reports';

let server: MockServer;

function show(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

const T = { timeout: 4000 };

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  server = installMock('default', 0, (now) => novemberCopy(now));
});
afterEach(() => cleanup());

describe('Owed to you: Close out of an item that is not open', () => {
  it('an unknown item says so instead of loading forever', async () => {
    show('/owed/close/BOGUS');
    const dialog = await screen.findByRole('dialog', undefined, T);
    await within(dialog).findByText(/isn’t on your Owed to you list/, undefined, T);
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('an item already closed out offers nothing to do again', async () => {
    const r = await server.handle(
      'POST',
      '/api/owed/nopa',
      { 'content-type': 'application/json', 'x-ledgerline': '1' },
      { action: 'close' },
    );
    expect(r.status).toBe(200);
    show('/owed/close/nopa');
    const dialog = await screen.findByRole('dialog', undefined, T);
    await within(dialog).findByText(/already closed out/, undefined, T);
    expect(within(dialog).queryByRole('button', { name: /Close out/ })).toBeNull();
    expect(within(dialog).queryByText('Remove the mark')).toBeNull();
  });
});

describe('Register', () => {
  it('lists upcoming bills apart, with their dates', async () => {
    show('/accounts/checking');
    await screen.findByText('Upcoming', undefined, T);
    expect(screen.getByText('counts on its date')).toBeTruthy();
    // Each says how often it comes.
    expect(screen.getAllByText(/ · Monthly$/).length).toBeGreaterThan(0);
  });
});

describe('Reports trend labels', () => {
  it('shortens thousands and millions', () => {
    expect(kShort(84_000)).toBe('$840');
    expect(kShort(270_000)).toBe('$2.7k');
    expect(kShort(-1_870_000)).toBe('−$18.7k');
    expect(kShort(10_000_130_000)).toBe('$100.0M');
    expect(kShort(99_999_000)).toBe('$1.0M');
  });
});
