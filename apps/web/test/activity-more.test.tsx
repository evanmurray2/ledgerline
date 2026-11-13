// Activity and Owed to you against the mock API (the real engine over November 2026): a link to a removed
// category, Match money back from one owed item's row, and the desktop row's category picker.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const T = { timeout: 4000 };

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  server = installMock('default', 0, (now) => novemberCopy(now));
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

describe('Owed to you: Match money back on a row', () => {
  it('opens the match sheet with only that row’s item picked', async () => {
    show('/owed');
    const links = await screen.findAllByRole('link', { name: /^Match money back for / }, T);
    expect(links.length).toBeGreaterThan(1);
    const last = links[links.length - 1]!;
    const label = last.getAttribute('aria-label')!.replace('Match money back for ', '');
    fireEvent.click(last);
    const sheet = await screen.findByRole('dialog', { name: 'Match money back' }, T);
    await within(sheet).findByText('What it pays back', undefined, T);
    const boxes = within(sheet).getAllByRole('checkbox') as HTMLInputElement[];
    const ticked = boxes.filter((b) => b.checked);
    expect(ticked).toHaveLength(1);
    expect(ticked[0]!.closest('label')!.textContent).toContain(label);
  });
});

describe('Desktop Activity: a category menu on each row', () => {
  it('changes a posted row’s category from its menu, and Undo puts it back', async () => {
    window.__desktop = true;
    show('/activity?filter=all');
    const menus = await screen.findAllByRole('button', { name: /^Category for / }, T);
    const menu = menus.find((b) => b.textContent !== 'Household')!;
    const name = menu.getAttribute('aria-label')!.replace(/^Category for (.*): .*$/, '$1');
    const before = menu.textContent;
    fireEvent.click(menu);
    const picker = await screen.findByRole('dialog', { name: 'Choose a category' }, T);
    fireEvent.click(within(picker).getAllByRole('button', { name: /Household/ })[0]!);
    const changed = () =>
      screen.getByRole('button', { name: new RegExp(`^Category for ${name.replace(/[$.()]/g, '\\$&')}: `) })
        .textContent;
    await waitFor(() => expect(changed()).toBe('Household'), T);
    const db = await server.db();
    const n = await db
      .prepare(
        `SELECT count(*) AS n FROM txn_overlay WHERE category_id = 'household' AND categorized_by = 'user'`,
      )
      .first<{ n: number }>();
    expect(n!.n).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }, T));
    await waitFor(() => expect(changed()).toBe(before), T);
  });

  it('a phone has no menu on the rows', async () => {
    show('/activity?filter=all');
    await screen.findByText('Posted', undefined, T);
    expect(screen.queryAllByRole('button', { name: /^Category for / })).toHaveLength(0);
  });
});
