// Activity against the mock API (the real engine over November 2026): a link to a removed category.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';

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
  installMock('default', 0, (now) => novemberCopy(now));
});
afterEach(() => cleanup());

describe('Activity: one category', () => {
  it('a category that was removed says so, with no months', async () => {
    show('/activity?category=nope');
    await screen.findByText('This category was removed.', undefined, T);
    expect(screen.queryByText('All months')).toBeNull();
    expect(screen.queryByText('No transactions match.')).toBeNull();
  });

  it('a category that exists shows its name and All months', async () => {
    show('/activity?category=groceries');
    await screen.findByText('All months', undefined, T);
    expect(screen.queryByText('This category was removed.')).toBeNull();
  });
});
