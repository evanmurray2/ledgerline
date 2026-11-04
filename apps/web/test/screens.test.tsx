// Renders each main screen against the mock API (November 2026, worked out by the real engine) and checks the key
// numbers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer, Scenario } from '../src/mock/server';
import { novemberCopy } from '../../worker/src/local/november-copy';
import { connectivity } from '../src/state/connectivity';

let server: MockServer;

function renderAt(path: string, scenario: Scenario = 'default') {
  server = installMock(scenario, 0, (now) => novemberCopy(now));
  return show(path);
}

function show(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

/** Categorizes rows through the mock API before the screen opens (the November seed has no payee history). */
async function categorize(keys: string[], categoryId: string) {
  const r = await server.handle(
    'POST',
    '/api/transactions/categorize',
    { 'content-type': 'application/json', 'x-ledgerline': '1' },
    { keys, categoryId },
  );
  expect(r.status).toBe(200);
}

/** What the copy stored: Ready to Assign, and a transaction's category. */
const storedRta = async () =>
  (await (await server.db()).prepare(`SELECT rta FROM budget`).first<{ rta: number }>())!.rta;
const categoryOf = async (key: string) =>
  (
    await (
      await server.db()
    )
      .prepare(`SELECT category_id FROM txn_overlay WHERE txn_key = ?1`)
      .bind(key)
      .first<{ category_id: string | null }>()
  )?.category_id ?? null;

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
    expect(screen.getByText('$1,121.85 available')).toBeTruthy();
    expect(screen.getByText('$441.45 available')).toBeTruthy();
    expect(screen.getByText('$18,877.63 available')).toBeTruthy();
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
    // Low categories have their own filter now, so Personal care isn't listed here.
    expect(screen.queryByRole('button', { name: 'Add $20.00 for Personal care' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move $40.00 for Gifts' })).toBeTruthy();
    fireEvent.click(cover);
    await waitFor(() => expect(screen.getByTestId('rta').textContent).toBe('$963.65'), { timeout: 4000 });
    expect(screen.getByText('Done just now')).toBeTruthy();
    expect(await storedRta()).toBe(96365);
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
    await text('Refill to $600.00 every month');
    expect(screen.getByTestId('category-available').textContent).toBe('$212.40');
    expect(screen.getByText('$387.60')).toBeTruthy();
    expect(screen.getByText('See all 4')).toBeTruthy();
  });

  it('assign sheet totals the suggestions', async () => {
    renderAt('/budget/assign');
    await text('Assign $981.90');
    expect(screen.getByRole('button', { name: 'Assign $358.25' })).toBeTruthy();
    expect(screen.getByTestId('assign-left').textContent).toBe('$623.65');
  });

  it('first budget state asks to give the money a job', async () => {
    renderAt('/budget', 'empty');
    await text(/Give your \$22,164\.46 a job/);
  });
});

describe('Activity', () => {
  it('shows the Needs attention groups and lists', async () => {
    renderAt('/activity');
    await text('Money to match');
    expect(screen.getAllByText('+$1,018.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('Transfers to sort out')).toBeNull();
    expect(screen.getByText(/4 · −\$86\.48/)).toBeTruthy();
    expect(screen.getByText('Check these')).toBeTruthy();
    expect(screen.getByText('counts now · $201.00')).toBeTruthy();
    expect(screen.getByText('Acme Corp payroll')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Needs attention 7' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not posted yet' })).toBeTruthy();
  });

  it('hides the Activity filters when nothing needs attention and nothing is pending', async () => {
    renderAt('/activity', 'empty');
    await screen.findByRole('heading', { name: 'Activity' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Filter' })).toBeNull());
    expect(screen.queryByRole('button', { name: /Needs attention/ })).toBeNull();
  });

  it('OK takes the suggested category, with Undo and no rule offer', async () => {
    server = installMock('default', 0, (now) => novemberCopy(now));
    await categorize(['n-amazon-f'], 'household');
    show('/activity');
    fireEvent.click(
      await screen.findByRole('button', { name: /^OK Household for Amazon/ }, { timeout: 4000 }),
    );
    await text(/^Amazon → Household/);
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(await categoryOf('n-amazon-s')).toBe('household');
  });

  it('the picker lists the payee’s past categories most used first, with counts', async () => {
    server = installMock('default', 0, (now) => novemberCopy(now));
    await categorize(['n-amazon-f'], 'household');
    show('/activity');
    fireEvent.click(
      (await screen.findAllByRole('button', { name: /^Choose category for Amazon/ }, { timeout: 4000 }))[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    expect(within(dialog).getByText('You’ve used for Amazon')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Household/ })[0]!);
    await waitFor(async () => expect(await categoryOf('n-amazon-s')).toBe('household'));
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
    expect(screen.getByText('$23,492.40')).toBeTruthy();
    expect(screen.getByText('$1,138.05')).toBeTruthy();
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
    expect(screen.getAllByText('Rent').length).toBeGreaterThan(0);
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
