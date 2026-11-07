// More screens against the mock API (the real engine over November 2026): stored alerts on Accounts, the
// transaction sheet, saving a target, and closing out what's owed. Each checks what the copy stored, not only the
// screen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const sql = async <T,>(q: string, ...args: unknown[]) =>
  (await server.db())
    .prepare(q)
    .bind(...args)
    .first<T>();

const T = { timeout: 4000 };

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  server = installMock('default', 0, (now) => novemberCopy(now));
});
afterEach(() => cleanup());

describe('Accounts: stored alerts', () => {
  it('lists an alert the sync saved, and Dismiss marks it seen', async () => {
    const db = await server.db();
    await db
      .prepare(
        `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
         SELECT 'al1', id, 'possible_reissue', 'p:old', '{}', 0 FROM budget`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
         SELECT 'al2', id, 'vanished_pending', 'p:gone', '{}', 0 FROM budget`,
      )
      .run();
    show('/accounts');
    // With Ally to repair, three problems fold into one line until opened.
    fireEvent.click(await screen.findByRole('button', { name: /3 things need you/ }, T));
    await screen.findByText(/added new ones. Check for a double/, undefined, T);
    expect(screen.getByText(/likely a released hold/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    await waitFor(() => expect(screen.queryByText(/added new ones. Check for a double/)).toBeNull(), T);
    expect(screen.getByText(/likely a released hold/)).toBeTruthy();
    expect(
      (await sql<{ acked_at: number | null }>(`SELECT acked_at FROM alert WHERE id = 'al1'`))!.acked_at,
    ).not.toBeNull();
  });
});

describe('Transaction sheet', () => {
  it('a row a rule set before rules were removed keeps its chip (D-60)', async () => {
    show('/activity/txn/n-tj');
    await screen.findByText(/^Set by Rule/, undefined, T);
  });

  it('a pending row shows your estimate next to the bank amount', async () => {
    show('/activity/txn/n-uber');
    await screen.findByText('Bank amount', undefined, T);
    expect(screen.getAllByText(/\$31\.40/).length).toBeGreaterThan(0);
  });
});

describe('Targets', () => {
  it('saving a target on a category without one stores it', async () => {
    show('/budget/category/home/target');
    const field = await screen.findByLabelText('Have this much available', undefined, T);
    fireEvent.change(field, { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
    await waitFor(async () => {
      const t = await sql<{ amount: number }>(`SELECT amount FROM target WHERE category_id = 'home'`);
      expect(t?.amount).toBe(15000);
    }, T);
  });
});

describe('Owed to you', () => {
  it('closing out what they won’t pay gives Ready to Assign the money back', async () => {
    const before = (await sql<{ rta: number }>(`SELECT rta FROM budget`))!.rta;
    show('/owed/close/nopa');
    fireEvent.click(await screen.findByRole('button', { name: 'Close out $18.00' }, T));
    await screen.findByText(/^Closed\. Dining out was charged \$18/, undefined, T);
    await waitFor(
      async () => expect((await sql<{ rta: number }>(`SELECT rta FROM budget`))!.rta).toBe(before + 1800),
      T,
    );
    expect(
      (await sql<{ closed_at: number | null }>(
        `SELECT closed_at FROM expected_reimbursement WHERE id = 'nopa'`,
      ))!.closed_at,
    ).not.toBeNull();
  });
});
