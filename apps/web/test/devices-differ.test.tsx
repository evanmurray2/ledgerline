// Budget → Needs attention when another device showed different numbers (the device check, D-116;
// screens/DevicesDiffer.tsx): the item, its count in the chip, and Rebuild. Against the mock API, with the copy's
// state set as a sync would set it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';

const m = vi.hoisted(() => ({ rebuildHere: vi.fn() }));
vi.mock('../src/copy/copy', async (orig) => ({
  ...(await orig<object>()),
  rebuildHere: m.rebuildHere,
}));

import { App, makeQueryClient } from '../src/App';
import { installMock } from '../src/mock/install';
import { novemberCopy } from '#november-node';
import { connectivity } from '../src/state/connectivity';
import { resetCopyForTests } from '../src/copy/copy';

const T = { timeout: 4000 };
const OTHER = { deviceId: '01CX5ZZKBKACTAV9WEVGEMMVRZ', number: 12, month: '2026-11' };

function show(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(<App history={history} queryClient={makeQueryClient()} />);
}

beforeEach(() => {
  window.__desktop = false;
  connectivity.setOnline(true);
  connectivity.setReadOnly(false, null);
  connectivity.reportOk();
  installMock('default', 0, (now) => novemberCopy(now));
  m.rebuildHere.mockReset();
});
afterEach(() => {
  cleanup();
  resetCopyForTests({ differs: null });
});

/** The Needs attention chip's count. */
const chipCount = async () =>
  Number(
    (await screen.findByRole('button', { name: /^Needs attention/ }, T)).textContent?.replace(/\D/g, '') ||
      '0',
  );

describe('two devices that show different numbers', () => {
  it('add one item to Needs attention, which says what to do', async () => {
    show('/budget');
    const before = await chipCount();
    cleanup();

    resetCopyForTests({ differs: OTHER });
    show('/budget?view=attention');
    expect(await chipCount()).toBe(before + 1);
    const note = await screen.findByRole('alert', {}, T);
    expect(within(note).getByText('Your devices show different numbers')).toBeTruthy();
    expect(note.textContent).toContain('Another device got other numbers for November.');
    expect(note.textContent).toContain('Rebuild the budget on this device to check again.');
  });

  it('Rebuild makes this device’s budget again', async () => {
    m.rebuildHere.mockImplementation(async () => {
      resetCopyForTests({ differs: null });
    });
    resetCopyForTests({ differs: OTHER });
    show('/budget?view=attention');
    const button = await screen.findByRole('button', { name: 'Rebuild' }, T);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(m.rebuildHere).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Done', {}, T)).toBeTruthy();
  });

  it('shows nothing when the devices agree', async () => {
    show('/budget?view=attention');
    await screen.findByRole('button', { name: /^Needs attention/ }, T);
    await waitFor(() => expect(screen.queryByText('Your devices show different numbers')).toBeNull());
  });
});
