// Budget and Owed to you against the mock API (the real engine over November 2026): the desktop table with two groups
// of one name, what Move money's choices hold, the new month's carry-over and the money that paid items back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import type { BudgetView, MatchView } from '@ledgerline/contracts';
import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import type { MockServer } from '../src/mock/server';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';
import { formatCents } from '../src/lib/money';

let server: MockServer;

function show(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

const T = { timeout: 4000 };
const H = { 'content-type': 'application/json', 'x-ledgerline': '1' };

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  server = installMock('default', 0, (now) => novemberCopy(now));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Budget on a computer', () => {
  it('shows two groups with one name, each with its own rows', async () => {
    const db = await server.db();
    const groups = (
      await db
        .prepare(`SELECT id FROM category_group WHERE archived_at IS NULL ORDER BY sort LIMIT 2`)
        .all<{ id: string }>()
    ).results;
    expect(groups.length).toBe(2);
    await db
      .prepare(`UPDATE category_group SET name = 'Same name' WHERE id IN (?1, ?2)`)
      .bind(groups[0]!.id, groups[1]!.id)
      .run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__desktop = true;
    show('/budget');
    const table = await screen.findByRole('table', { name: /Budget for/ }, T);
    expect(within(table).getAllByRole('rowheader', { name: 'Same name' }).length).toBe(2);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
  });
});

describe('Move money', () => {
  it('shows what Ready to Assign and each category hold', async () => {
    show('/budget/category/dining');
    fireEvent.click(await screen.findByRole('button', { name: 'Move money' }, T));
    const move = await screen.findByRole('dialog', { name: 'Move money' }, T);
    const from = within(move).getByLabelText('From');
    expect(from.textContent).toContain('Ready to Assign');
    expect(from.textContent).toContain('$1,999.90');
    fireEvent.click(from);
    const picker = await screen.findByRole('dialog', { name: 'Move from' }, T);
    expect(within(picker).getByRole('button', { name: /^Ready to Assign/ }).textContent).toContain(
      '$1,999.90',
    );
    expect(within(picker).getByRole('button', { name: /^Groceries/ }).textContent).toContain('$212.40');
  });
});

describe('A new month', () => {
  it('says how Ready to Assign came about, and the parts add up', async () => {
    server = installMock('newmonth', 0, (now) => novemberCopy(now));
    // Money already assigned to January comes out of December's Ready to Assign too.
    const r = await server.handle('POST', '/api/budget/assign', H, {
      month: '2027-01',
      items: [{ categoryId: 'groceries', amount: 5000 }],
    });
    expect(r.status).toBe(200);
    const b = (await server.handle('GET', '/api/budget/2026-12', {}, undefined)).body as BudgetView;
    const c = b.carryOver!;
    expect(c.from).toBe('2026-11');
    expect(c.assigned).toBe(5000);
    show('/budget');
    await screen.findByText('December has started', undefined, T);
    const list = screen.getByTestId('carry-over');
    expect(within(list).getByText('Left from November').nextSibling!.textContent).toBe(formatCents(c.left));
    // Each part that isn't $0 has a line; with what was left, they make Ready to Assign.
    const amounts = within(list)
      .getAllByRole('definition')
      .map((d) => d.textContent!)
      .map((t) => (t.startsWith('−') ? -1 : 1) * Number(t.replace(/[^0-9]/g, '')));
    expect(within(list).getByText('Assigned').nextSibling!.textContent).toBe('−$50.00');
    expect(amounts.reduce((a, x) => a + x, 0)).toBe(b.rta);
  });
});

describe('Owed to you · Paid back recently', () => {
  it('lists the money in that paid an item back, and opens it', async () => {
    const m = (await server.handle('GET', '/api/match/n-venmo', {}, undefined)).body as MatchView;
    const o = m.open.find((x) => x.still > 0)!;
    const amount = Math.min(o.still, m.left);
    const r = await server.handle('POST', '/api/match', H, {
      inflowKey: 'n-venmo',
      items: [{ itemId: o.id, amount }],
    });
    expect(r.status).toBe(200);
    show('/owed');
    await screen.findByText('Paid back recently', undefined, T);
    const row = screen
      .getAllByText(/· Paid back /)
      .map((e) => e.closest('a')!)
      .find((a) => a.getAttribute('href')?.includes('/activity/txn/n-venmo'))!;
    expect(row.textContent).toContain(`Paid back ${o.label.split(' · ')[0]}`);
    expect(row.textContent).toContain(formatCents(amount, { plus: true }));
  });
});
