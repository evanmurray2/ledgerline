// Renders each main screen against the mock API (November 2026) and checks the key numbers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer } from '../src/mock/server';
import type { Scenario } from '../src/mock/db';
import { connectivity } from '../src/state/connectivity';

let server: MockServer;

function renderAt(path: string, scenario: Scenario = 'default') {
  server = installMock(scenario, 0);
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

const text = (s: string | RegExp) => screen.findAllByText(s, undefined, { timeout: 4000 });

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
});
afterEach(() => cleanup());

describe('Budget', () => {
  it('shows Ready to Assign, card rows, Owed to you and group totals', async () => {
    renderAt('/budget');
    expect((await screen.findByTestId('rta', undefined, { timeout: 4000 })).textContent).toBe('$981.90');
    await text('Sapphire Preferred');
    expect(screen.getByText('$878.32')).toBeTruthy();
    expect(screen.getByText('$155.00')).toBeTruthy();
    expect(screen.getByText('Short')).toBeTruthy();
    expect(screen.getByText('$1,430.60 out')).toBeTruthy();
    expect(screen.getByText('$1,121.85')).toBeTruthy();
    expect(screen.getByText('$441.45')).toBeTruthy();
    expect(screen.getByText('$18,877.63')).toBeTruthy();
    expect(screen.getByText('−$18.25')).toBeTruthy();
  });

  it('Needs attention lists one-tap fixes, and Cover updates Ready to Assign', async () => {
    renderAt('/budget?view=attention');
    const cover = await screen.findByRole(
      'button',
      { name: 'Cover $18.25 for Dining out' },
      { timeout: 4000 },
    );
    expect(screen.getByRole('button', { name: /Fund all · \$340\.00/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add $20.00 for Personal care' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move $40.00 for Gifts' })).toBeTruthy();
    fireEvent.click(cover);
    await waitFor(() => expect(screen.getByTestId('rta').textContent).toBe('$963.65'), { timeout: 4000 });
    expect(screen.getByText('Done just now')).toBeTruthy();
    expect(server.db.rta).toBe(96365);
  });

  it('desktop shows the table with Assigned, Spent and Available', async () => {
    window.__desktop = true;
    renderAt('/budget');
    const table = await screen.findByRole('table', {}, { timeout: 4000 });
    expect(within(table).getByText('Assigned')).toBeTruthy();
    expect(within(table).getByText('Spent')).toBeTruthy();
    expect(within(table).getByText('Available')).toBeTruthy();
    expect(within(table).getByText('$387.60')).toBeTruthy();
    expect(screen.getByTestId('nav-rta').textContent).toBe('$981.90');
  });

  it('category sheet shows assigned, spent and available', async () => {
    renderAt('/budget/category/groceries');
    await text('Refill to $600 every month');
    expect(screen.getByTestId('category-available').textContent).toBe('$212.40');
    expect(screen.getByText('−$387.60')).toBeTruthy();
    expect(screen.getByText('See all 9')).toBeTruthy();
  });

  it('assign sheet totals the suggestions', async () => {
    renderAt('/budget/assign');
    await text('Assign $981.90');
    expect(screen.getByRole('button', { name: 'Assign $358.25' })).toBeTruthy();
    expect(screen.getByTestId('assign-left').textContent).toBe('$623.65');
  });

  it('first budget state asks to give the money a job', async () => {
    renderAt('/budget', 'empty');
    await text(/Give your \$21,840\.00 a job/);
  });
});

describe('Activity', () => {
  it('shows the Needs attention groups and lists', async () => {
    renderAt('/activity');
    await text('Money to match');
    expect(screen.getByText('+$1,018.00')).toBeTruthy();
    expect(screen.getByText('Transfers to sort out')).toBeTruthy();
    expect(screen.getByText(/4 · −\$86\.48/)).toBeTruthy();
    expect(screen.getByText('Check these')).toBeTruthy();
    expect(screen.getByText('counts now · $201.00')).toBeTruthy();
    expect(screen.getByText('Acme Corp payroll')).toBeTruthy();
    expect(screen.getByText('Needs attention 8')).toBeTruthy();
  });

  it('categorizes from the picker with Undo and the Always offer', async () => {
    renderAt('/activity');
    fireEvent.click(
      await screen.findByRole(
        'button',
        { name: /Choose category for Blue Bottle Coffee/ },
        { timeout: 4000 },
      ),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Dining out' })[0]!);
    await text(
      'Blue Bottle Coffee → Dining out · Dining out is now overspent by $25.00. Cover it on Budget.',
    );
    expect(screen.getByRole('button', { name: 'Always' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(server.db.txn('bb').categoryId).toBe('dining');
  });
});

describe('Accounts and Reports', () => {
  it('accounts show net worth, owed to you and the repair banner', async () => {
    renderAt('/accounts');
    expect((await screen.findByTestId('net-worth', undefined, { timeout: 4000 })).textContent).toBe(
      '$22,555.35',
    );
    expect(screen.getByText('$1,430.60')).toBeTruthy();
    expect(screen.getByText('Ally needs you to sign in again')).toBeTruthy();
    expect(screen.getByText('$23,612.40')).toBeTruthy();
    expect(screen.getByText('−$1,057.05')).toBeTruthy();
  });

  it('card register shows what you owe and the payment category', async () => {
    renderAt('/accounts/sapphire');
    await text('You owe the bank');
    expect(screen.getByText('$842.17')).toBeTruthy();
    expect(screen.getByText('$611.40')).toBeTruthy();
    expect(screen.getByText('Owed $771.20')).toBeTruthy();
  });

  it('reports show month-to-date spending by category', async () => {
    renderAt('/reports');
    await text('$387.60');
    expect(screen.getByText('$1,319.25')).toBeTruthy();
    expect(screen.getByText('Groceries')).toBeTruthy();
  });

  it('owed to you lists what is still owed', async () => {
    renderAt('/owed');
    await text('Still owed');
    expect(screen.getByText('$1,430.60')).toBeTruthy();
    expect(screen.getAllByText('Rent · Sam').length).toBeGreaterThan(0);
  });
});

describe('Settings', () => {
  it('shows sections, appearance and preferences without an email setting', async () => {
    renderAt('/settings');
    await text('Record how I use the app');
    expect(screen.getByRole('radio', { name: 'Match device' })).toBeTruthy();
    expect(screen.queryByText(/Email me/)).toBeNull();
    await text(/4 of 10 links used/);
  });

  it('bank connections show the link meter and confirm before linking', async () => {
    renderAt('/settings/connections');
    expect((await screen.findByTestId('link-meter', undefined, { timeout: 4000 })).textContent).toBe(
      '4 of 10 links used',
    );
    fireEvent.click(screen.getByRole('button', { name: /Link another bank/ }));
    expect(await screen.findByText('Use 1 of your 6 remaining links?')).toBeTruthy();
  });

  it('rules list parses despite the contract’s duplicate discriminator', async () => {
    renderAt('/settings/rules');
    await text('Payee is Trader Joe’s');
  });
});

describe('States', () => {
  it('read-only shows the banner with the reset time in Pacific and disables changes', async () => {
    renderAt('/budget', 'readonly');
    const banner = await screen.findByTestId('readonly-banner', undefined, { timeout: 4000 });
    expect(banner.textContent).toContain('View only until 4:00 PM');
    expect(
      (await screen.findByText('Assign', undefined, { timeout: 4000 })).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('offline shows the last loaded data and disables fixes', async () => {
    renderAt('/budget?view=attention');
    const cover = await screen.findByRole(
      'button',
      { name: 'Cover $18.25 for Dining out' },
      { timeout: 4000 },
    );
    connectivity.setOnline(false);
    await waitFor(() => expect((cover as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(screen.getByTestId('rta').textContent).toBe('$981.90');
  });

  it('first run starts at Welcome', async () => {
    renderAt('/budget', 'firstrun');
    await text('Get started');
  });
});
