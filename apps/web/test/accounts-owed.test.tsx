// Accounts, registers, Owed to you and Reports against the mock API (the real engine over November 2026): an unknown
// or finished owed item, a register's upcoming bills, its older pages and its place on a computer, and short amounts
// on the trend chart.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer } from '../src/mock/server';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';
import { kShort } from '../src/screens/Reports';
import { registerSub } from '../src/screens/AccountRegister';
import type { AccountRow } from '@ledgerline/contracts';

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

  it('shows older days a page at a time', async () => {
    // 400 more posted rows on checking, one a day back from June 30, 2026, all in the budget.
    const db = await server.db();
    const run = (sql: string, ...args: unknown[]) =>
      db
        .prepare(sql)
        .bind(...args)
        .run();
    await run(`UPDATE account SET budget_from = '2020-01-01' WHERE id = 'checking'`);
    for (let i = 0; i < 400; i++) {
      const d = new Date(Date.UTC(2026, 5, 30) - i * 86_400_000).toISOString().slice(0, 10);
      await run(
        `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending, raw_name, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         SELECT ?1, a.budget_id, pa.connection_id, a.provider_account_id, -100, ?2, 0, 'Coffee', ?3, 0, 0, 0, 0
         FROM account a JOIN provider_account pa ON pa.provider_account_id = a.provider_account_id WHERE a.id = 'checking'`,
        `old_${i}`,
        d,
        `p:old_${i}`,
      );
    }
    show('/accounts/checking');
    const older = await screen.findByRole('button', { name: 'Show older' }, { timeout: 15_000 });
    // The oldest row (May 27, 2025) is on the second page.
    expect(screen.queryByText(/May 27, 2025/)).toBeNull();
    fireEvent.click(older);
    await screen.findByText(/May 27, 2025/, undefined, { timeout: 15_000 });
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  }, 30_000);

  it('a computer opens the account in the side panel, next to the list', async () => {
    window.__desktop = true;
    show('/accounts/checking');
    const panel = await screen.findByRole('dialog', { name: 'Everyday Checking' }, T);
    await within(panel).findByText('Balance at bank', undefined, T);
    // The list stays on the page, with this account marked.
    expect(screen.getByTestId('net-worth')).toBeTruthy();
    const row = screen
      .getAllByRole('link')
      .find((l) => l.getAttribute('href') === '/accounts/checking' && !panel.contains(l));
    expect(row?.getAttribute('data-status')).toBe('active');
  });

  it('says an account whose bank was removed is not linked, not when it synced', () => {
    const a = {
      institution: 'Chase',
      mask: '0912',
      syncedAt: Date.UTC(2026, 10, 12),
      connectionStatus: 'ok',
      closed: false,
      meta: 'Chase · ending 0912 · not linked',
    } as AccountRow;
    expect(registerSub(a, '2026-11-14')).toMatch(/synced/);
    expect(registerSub({ ...a, unlinked: true }, '2026-11-14')).toBe('Chase · ending 0912 · not linked');
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
