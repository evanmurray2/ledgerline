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
    show('/accounts');
    // With Ally to repair, two problems fold into one line until opened.
    fireEvent.click(await screen.findByRole('button', { name: /2 things need you/ }, T));
    await screen.findByText(/added new ones. Check for a double/, undefined, T);
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!);
    await waitFor(() => expect(screen.queryByText(/added new ones. Check for a double/)).toBeNull(), T);
    expect(
      (await sql<{ acked_at: number | null }>(`SELECT acked_at FROM alert WHERE id = 'al1'`))!.acked_at,
    ).not.toBeNull();
  });
});

describe('Activity: removed by the bank', () => {
  it('names a pending charge the bank removed, and OK clears it', async () => {
    const db = await server.db();
    await db
      .prepare(
        `INSERT INTO bank_txn (provider_txn_id, budget_id, connection_id, provider_account_id, amount, date, pending,
           raw_name, merchant_name, removed_at, txn_key, first_apply_seq, last_apply_seq, created_at, updated_at)
         SELECT 'gone-1', a.budget_id, 'conn', a.provider_account_id, -4217, '2026-11-02', 1, 'SQ *CORNER CAFE',
           'Corner Cafe', 1, 'p:gone-1', 1, 1, 0, 0
           FROM account a WHERE a.provider_account_id IS NOT NULL LIMIT 1`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO alert (id, budget_id, type, ref_key, data, created_at)
         SELECT 'al2', id, 'vanished_pending', 'p:gone-1', '{}', 0 FROM budget`,
      )
      .run();
    show('/activity');
    await screen.findByText('Removed by the bank', undefined, T);
    expect(screen.getByText('Corner Cafe')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^OK, Corner Cafe \$42\.17/ }));
    await waitFor(() => expect(screen.queryByText('Removed by the bank')).toBeNull(), T);
    expect(
      (await sql<{ acked_at: number | null }>(`SELECT acked_at FROM alert WHERE id = 'al2'`))!.acked_at,
    ).not.toBeNull();
  });
});

describe('Transaction sheet', () => {
  it('a row a rule set before rules were removed keeps its chip (D-60)', async () => {
    show('/activity/txn/n-tj');
    await screen.findByText(/^Set by (a rule|the rule)/, undefined, T);
  });

  it('a pending row shows your estimate next to the bank amount', async () => {
    show('/activity/txn/n-uber');
    await screen.findByText('Bank amount', undefined, T);
    expect(screen.getAllByText(/\$31\.40/).length).toBeGreaterThan(0);
  });

  it('income moved to next month: the Goes to toggle and its help line agree', async () => {
    const r = await server.handle(
      'PATCH',
      '/api/transactions/n-payroll',
      { 'content-type': 'application/json', 'x-ledgerline': '1' },
      { budgetMonth: '2026-12' },
    );
    expect(r.status).toBe(200);
    show('/activity/txn/n-payroll');
    const now = await screen.findByRole('button', { name: 'Ready to Assign now' }, T);
    const next = screen.getByRole('button', { name: 'Save for December' });
    expect(next.getAttribute('aria-pressed')).toBe('true');
    await screen.findByText(/to Ready to Assign on December 1\./);
    fireEvent.click(now);
    expect(now.getAttribute('aria-pressed')).toBe('true');
    await screen.findByText(/to Ready to Assign in November\./);
  });

  it('a deposit with no category is in Ready to Assign: the sheet says so and nothing asks for a category', async () => {
    const before = (await sql<{ rta: number }>(`SELECT rta FROM budget`))!.rta;
    const r = await server.handle(
      'PATCH',
      '/api/transactions/n-payroll',
      { 'content-type': 'application/json', 'x-ledgerline': '1' },
      { categoryId: null },
    );
    expect(r.status).toBe(200);
    expect(
      (await sql<{ to_rta: number }>(`SELECT to_rta FROM txn_overlay WHERE txn_key = 'n-payroll'`))!.to_rta,
    ).toBe(0);
    expect((await sql<{ rta: number }>(`SELECT rta FROM budget`))!.rta).toBe(before);
    const view = (await server.handle('GET', '/api/activity', {}, undefined)).body as {
      needsCategory: { key: string }[];
    };
    expect(view.needsCategory.map((x) => x.key)).not.toContain('n-payroll');
    show('/activity/txn/n-payroll');
    const field = await screen.findByLabelText('Category', undefined, T);
    expect(field.textContent).toMatch(/Ready to Assign/);
    const now = await screen.findByRole('button', { name: 'Ready to Assign now' }, T);
    expect(now.getAttribute('aria-pressed')).toBe('true');
    // "Needs a category" isn't a choice for money in.
    fireEvent.click(field);
    await screen.findAllByRole('button', { name: /^Ready to Assign/ }, T);
    expect(screen.queryByRole('button', { name: /^Needs a category/ })).toBeNull();
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

  it('the sheet asks for what the Budget row asks for, and says when a change starts', async () => {
    // Budget's rows: Vacation needs $250.00 this month, Car insurance $90.00.
    show('/budget/category/vacation/target');
    await screen.findByText('Needs $250 this month', undefined, T);
    expect(screen.getByText('Starts in November 2026. Earlier months keep their target.')).toBeTruthy();
    cleanup();
    show('/budget/category/car/target');
    await screen.findByText('Needs $90 this month', undefined, T);
  });

  it('a monthly Refill changed to Quarter is due at the end of the quarter, not this month', async () => {
    show('/budget/category/groceries/target');
    await screen.findByLabelText('Have this much available', undefined, T);
    fireEvent.click(screen.getByRole('button', { name: 'Quarter' }));
    expect((screen.getByLabelText('Due') as HTMLInputElement).value).toBe('2027-01');
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

describe('Owed to you: Reopen (D-80)', () => {
  it('lists an item closed out this month, and Reopen puts it back in Still owed', async () => {
    const it0 = (await sql<{ id: string }>(
      `SELECT id FROM expected_reimbursement WHERE txn_key = 'o-united'`,
    ))!;
    const r = await server.handle(
      'POST',
      `/api/owed/${it0.id}`,
      { 'content-type': 'application/json', 'x-ledgerline': '1' },
      { action: 'close' },
    );
    expect(r.status).toBe(200);
    show('/owed');
    await screen.findByText('Closed out', undefined, T);
    fireEvent.click(screen.getByRole('button', { name: /^Reopen / }));
    await screen.findByText(/^Reopened\./, undefined, T);
    await waitFor(() => expect(screen.queryByText('Closed out')).toBeNull(), T);
    expect(
      (await sql<{ closed_at: number | null }>(
        `SELECT closed_at FROM expected_reimbursement WHERE id = ?1`,
        it0.id,
      ))!.closed_at,
    ).toBeNull();
  });

  it('Undo after Remove the mark puts the mark back', async () => {
    const it0 = (await sql<{ id: string }>(
      `SELECT id FROM expected_reimbursement WHERE txn_key = 'o-united'`,
    ))!;
    show(`/owed/close/${it0.id}`);
    fireEvent.click(await screen.findByText('I marked it by mistake', undefined, T));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the mark' }));
    await screen.findByText(/^Removed\./, undefined, T);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(
      async () =>
        expect(
          (await sql<{ canceled_at: number | null }>(
            `SELECT canceled_at FROM expected_reimbursement WHERE id = ?1`,
            it0.id,
          ))!.canceled_at,
        ).toBeNull(),
      T,
    );
  });
});
