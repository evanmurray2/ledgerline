// Renders each main screen against the mock API (November 2026, worked out by the real engine) and checks the key
// numbers.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer, Scenario } from '../src/mock/server';
import { novemberCopy } from '#november-node';
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
    expect((await screen.findByTestId('rta', undefined, { timeout: 4000 })).textContent).toBe('$1,999.90');
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
    expect(screen.getByRole('button', { name: 'Move $210.00 for Gifts' })).toBeTruthy();
    fireEvent.click(cover);
    await waitFor(() => expect(screen.getByTestId('rta').textContent).toBe('$1,981.65'), { timeout: 4000 });
    expect(screen.getByText('Done just now')).toBeTruthy();
    expect(await storedRta()).toBe(198165);
  });

  it('desktop shows the table with Assigned, Spent and Available', async () => {
    window.__desktop = true;
    renderAt('/budget');
    const table = await screen.findByRole('table', {}, { timeout: 4000 });
    expect(within(table).getByText('Assigned')).toBeTruthy();
    expect(within(table).getByText('Spent')).toBeTruthy();
    expect(within(table).getByText('Available')).toBeTruthy();
    expect(within(table).getByText('$387.60')).toBeTruthy();
    expect(screen.getByTestId('nav-rta').textContent).toBe('$1,999.90');
  });

  it('category sheet shows available, spent and the assigned amount, with no mode to choose', async () => {
    renderAt('/budget/category/groceries');
    await text('Refill to $600.00 every month');
    expect(screen.getByTestId('category-available').textContent).toBe('$212.40');
    expect(screen.getByText('$387.60 spent in November')).toBeTruthy();
    expect((screen.getByLabelText('Assigned in November') as HTMLInputElement).value).toBe('600.00');
    expect(screen.getByText('See all 4')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Mode' })).toBeNull();
    // The target is already the amount, so it isn't offered.
    expect(screen.queryByRole('button', { name: /^Target/ })).toBeNull();
    // Typing says what it does to Ready to Assign, and moves Available with it.
    fireEvent.change(screen.getByLabelText('Assigned in November'), { target: { value: '650' } });
    expect(screen.getByText('Ready to Assign goes from $1,999.90 to $1,949.90.')).toBeTruthy();
    expect(screen.getByTestId('category-available').textContent).toBe('$262.40');
    expect(screen.getByRole('button', { name: 'Target $600' })).toBeTruthy();
  });

  it('category sheet offers the Needs attention amount, and Move money starts by covering it', async () => {
    renderAt('/budget/category/dining');
    fireEvent.click(await screen.findByRole('button', { name: 'Cover $18.25' }));
    expect(screen.getByTestId('category-available').textContent).toBe('$0.00');
    expect(screen.queryByRole('button', { name: 'Cover $18.25' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move money' }));
    const move = await screen.findByRole('dialog', { name: 'Move money' });
    expect(within(move).getByLabelText('From').textContent).toContain('Ready to Assign');
    expect(within(move).getByLabelText('To').textContent).toContain('Dining out');
    expect((within(move).getByLabelText('Amount') as HTMLInputElement).value).toBe('18.25');
    expect(within(move).getByRole('button', { name: 'Move $18.25' })).toBeTruthy();
    // Swapping keeps the amount and turns the move around.
    fireEvent.click(within(move).getByRole('button', { name: 'Swap From and To' }));
    expect(within(move).getByLabelText('From').textContent).toContain('Dining out');
    expect(within(move).getByLabelText('To').textContent).toContain('Ready to Assign');
  });

  it('assign sheet totals the suggestions', async () => {
    renderAt('/budget/assign');
    await text('Assign $1,999.90');
    expect(screen.getByRole('button', { name: 'Assign $358.25' })).toBeTruthy();
    expect(screen.getByTestId('assign-left').textContent).toBe('$1,641.65');
  });

  it('first budget state asks to give the money a job', async () => {
    renderAt('/budget', 'empty');
    await text(/Give your \$22,164\.46 a job/);
  });
});

describe('Activity', () => {
  it('opens on Not posted yet when this month has rows waiting to post (D-97)', async () => {
    renderAt('/activity');
    const chip = await screen.findByRole('button', { name: 'Not posted yet' }, { timeout: 4000 });
    await waitFor(() => expect(chip.getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the Needs attention groups and lists', async () => {
    renderAt('/activity?filter=all');
    await text('Check these');
    expect(screen.queryByText('Money to match')).toBeNull();
    expect(screen.queryByText('Transfers to sort out')).toBeNull();
    expect(screen.getByText(/4 · −\$86\.48/)).toBeTruthy();
    expect(screen.getByText('Check these')).toBeTruthy();
    // Every pending row counts now, the check under Check these included.
    expect(screen.getByText('counts now · $201.00')).toBeTruthy();
    expect(screen.getByText('Acme Corp payroll')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Needs attention 6' })).toBeTruthy();
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
    show('/activity?filter=all');
    fireEvent.click(
      await screen.findByRole('button', { name: /^Use Household for Amazon/ }, { timeout: 4000 }),
    );
    await text(/^Amazon → Household/);
    expect(screen.queryByRole('button', { name: 'Always' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(await categoryOf('n-amazon-s')).toBe('household');
  });

  it('the picker lists the payee’s past categories most used first, with counts', async () => {
    server = installMock('default', 0, (now) => novemberCopy(now));
    await categorize(['n-amazon-f'], 'household');
    show('/activity?filter=all');
    fireEvent.click(
      (await screen.findAllByRole('button', { name: /^Choose category for Amazon/ }, { timeout: 4000 }))[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Choose a category' });
    expect(within(dialog).getByText('Past categories for Amazon')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Household/ })[0]!);
    await waitFor(async () => expect(await categoryOf('n-amazon-s')).toBe('household'));
  });
});

describe('Accounts and Reports', () => {
  it('accounts show net worth, owed to you and the repair banner', async () => {
    renderAt('/accounts');
    expect((await screen.findByTestId('net-worth', undefined, { timeout: 4000 })).textContent).toBe(
      '$22,354.35',
    );
    expect(screen.getByText('$1,430.60')).toBeTruthy();
    expect(screen.getByText('Ally needs you to sign in again')).toBeTruthy();
    expect(screen.getByText('$23,492.40')).toBeTruthy();
    expect(screen.getByText('$1,138.05')).toBeTruthy();
  });

  it('an account whose transactions differ from the bank balance says by how much', async () => {
    renderAt('/accounts');
    await screen.findByTestId('net-worth', undefined, { timeout: 4000 });
    expect(screen.queryAllByTestId('bank-drift')).toHaveLength(0);
    cleanup();
    // The bank reports $40 more than the starting balance plus the posted rows add up to, since long ago (D-68: a
    // difference shows once it has lasted a day).
    await (
      await server.db()
    )
      .prepare(
        `UPDATE provider_account SET current_balance = current_balance + 4000, drift_since = 0
         WHERE provider_account_id = (SELECT provider_account_id FROM account WHERE id = 'checking')`,
      )
      .run();
    show('/accounts');
    expect((await screen.findByTestId('bank-drift', undefined, { timeout: 4000 })).textContent).toBe(
      'Differs from bank by $40.00',
    );
    cleanup();
    show('/accounts/checking');
    expect((await screen.findByTestId('bank-drift', undefined, { timeout: 4000 })).textContent).toContain(
      'differ from the bank balance by $40.00',
    );
  });

  it('an account’s starting balance opens a sheet with each step, and a late row from before the start (D-67)', async () => {
    renderAt('/accounts');
    await screen.findByTestId('net-worth', undefined, { timeout: 4000 });
    cleanup();
    // Sep 30, sent on Oct 3 (after the first sync, while settling): part of the starting balance, not the budget.
    const db = await server.db();
    await db
      .prepare(
        `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         SELECT 'late-1', budget_id, 'con_chase', provider_account_id, -2500, '2026-09-30', 0, 'LATE SHOP', 'late-1', 0, 0, ?1, ?1
         FROM account WHERE id = 'checking'`,
      )
      .bind(Date.parse('2026-10-03T12:00:00Z'))
      .run();
    await db
      .prepare(
        `UPDATE provider_account SET current_balance = current_balance - 2500
         WHERE provider_account_id = (SELECT provider_account_id FROM account WHERE id = 'checking')`,
      )
      .run();
    // The seed saves its balances today; here they were read at the link, as Setup does.
    await db.prepare(`UPDATE account SET starting_balance_confirmed_at = NULL WHERE id = 'checking'`).run();
    show('/accounts/checking');
    // Final, and the late row came in more than 7 days ago: no row of its own, it is in the ⋯ menu.
    fireEvent.click(await screen.findByRole('button', { name: 'More for this account' }, { timeout: 4000 }));
    expect(document.querySelector('[data-track="account.start"]')?.textContent).toBe('Starting balance');
    fireEvent.click(screen.getByRole('button', { name: 'Starting balance' }));
    const sheet = await screen.findByTestId('start-sheet');
    expect(within(sheet).getByText('Dated before Oct 1, came in late')).toBeTruthy();
    expect(within(sheet).getByText('− $25.00')).toBeTruthy();
    expect(screen.getByText('This won’t change now.')).toBeTruthy();
    expect(screen.queryAllByTestId('bank-drift')).toHaveLength(0);
  });

  it('card register shows what you owe', async () => {
    renderAt('/accounts/sapphire');
    await text('You owe the bank');
    expect(screen.getByText('$842.17')).toBeTruthy();
    expect(screen.getByText('$611.40')).toBeTruthy();
    expect(screen.getByText('Owed $771.20')).toBeTruthy();
    // No Payment category row: it only repeated what this page and Budget show (D-70).
    expect(screen.queryByText('Payment category')).toBeNull();
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
    await text(/4 of 10 bank links used/);
  });

  it('bank connections show the link meter and confirm before linking', async () => {
    renderAt('/settings/connections');
    expect((await screen.findByTestId('link-meter', undefined, { timeout: 4000 })).textContent).toBe(
      '4 of 10 bank links used',
    );
    fireEvent.click(screen.getByRole('button', { name: /Link another bank/ }));
    expect(await screen.findByText('Use 1 of your 6 bank links?')).toBeTruthy();
  });
});

describe('States', () => {
  it('read-only shows the banner with the reset time in Pacific and disables changes', async () => {
    renderAt('/budget', 'readonly');
    const banner = await screen.findByTestId('readonly-banner', undefined, { timeout: 4000 });
    expect(banner.textContent).toContain('View only until 4:00\u00a0PM');
    const assign = await screen.findByText('Assign', undefined, { timeout: 4000 });
    expect(assign.getAttribute('aria-disabled')).toBe('true');
    // Grayed out, but a tap says why.
    fireEvent.click(assign);
    expect(await screen.findByText('View only until 4:00 PM. Nothing is lost.')).toBeTruthy();
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
    expect(screen.getByTestId('rta').textContent).toBe('$1,999.90');
  });

  it('offline, the "Same as your…" question stays with Join grayed out, and OK all still leaves that row', async () => {
    renderAt('/activity?filter=attention');
    await screen.findByText('Same as your Amazon?', undefined, { timeout: 4000 });
    expect(screen.getByRole('button', { name: 'Use 2 suggestions' })).toBeTruthy();
    const join = screen.getByRole('button', { name: 'Join Amazon into your Amazon' }) as HTMLButtonElement;
    expect(join.disabled).toBe(false);
    connectivity.setOnline(false);
    await waitFor(() => expect(join.disabled).toBe(true));
    expect(screen.getByText('Same as your Amazon?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use 2 suggestions' })).toBeTruthy();
  });

  it('first run starts at Welcome', async () => {
    renderAt('/budget', 'firstrun');
    await text('Get started');
  });
});
