// Settings → Backup and export for a locked budget (screens/settings/DeviceBackup.tsx): the backup is made on the
// device after a passkey prompt, locked with the typed recovery key unless the person says otherwise.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { newRecoveryKey, openBackup, showRecoveryKey } from '@ledgerline/seal';

const m = vi.hoisted(() => ({
  confirmItsYou: vi.fn(),
  saveFile: vi.fn(),
  copyBytes: vi.fn(),
  checkRecoveryKey: vi.fn(),
}));
vi.mock('../src/api/client', async (orig) => ({
  ...(await orig<object>()),
  confirmItsYou: m.confirmItsYou,
  saveFile: m.saveFile,
}));
vi.mock('../src/copy/copy', async (orig) => ({
  ...(await orig<object>()),
  copyBytes: m.copyBytes,
  checkRecoveryKey: m.checkRecoveryKey,
}));

import { DeviceBackup } from '../src/screens/settings/DeviceBackup';
import { KEY_TYPO, WayInError } from '../src/keys/budget';

const COPY = new TextEncoder().encode('SQLite format 3, a whole budget');

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.confirmItsYou.mockResolvedValue(true);
  m.copyBytes.mockImplementation(async () => COPY.slice().buffer);
  m.checkRecoveryKey.mockResolvedValue('ab'.repeat(32));
});
afterEach(cleanup);

const saved = async (): Promise<{ bytes: Uint8Array; name: string }> => {
  const [blob, name] = m.saveFile.mock.calls[0] as [Blob, string];
  return { bytes: new Uint8Array(await blob.arrayBuffer()), name };
};

describe('the full backup of a locked budget', () => {
  it('asks for the passkey, then saves the copy locked with the typed recovery key', async () => {
    const r = newRecoveryKey();
    render(<DeviceBackup />);
    const button = screen.getByRole('button', { name: 'Download' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('backup-recovery-key'), {
      target: { value: await showRecoveryKey(r) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(m.saveFile).toHaveBeenCalledTimes(1));
    expect(m.confirmItsYou).toHaveBeenCalledTimes(1);
    // Checked against the budget's recovery slot in force, as typed.
    expect(m.checkRecoveryKey).toHaveBeenCalledWith(await showRecoveryKey(r));
    const f = await saved();
    expect(f.name).toMatch(/\.locked$/);
    expect([...(await openBackup(r, f.bytes))]).toEqual([...COPY]);
  });

  it('saves nothing when the passkey is not used, or the key has a slip', async () => {
    m.confirmItsYou.mockResolvedValueOnce(false);
    render(<DeviceBackup />);
    const shown = await showRecoveryKey(newRecoveryKey());
    fireEvent.change(screen.getByTestId('backup-recovery-key'), { target: { value: shown } });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(m.confirmItsYou).toHaveBeenCalledTimes(1));
    expect(m.copyBytes).not.toHaveBeenCalled();
    const slip = shown.slice(0, 3) + (shown[3] === 'A' ? 'B' : 'A') + shown.slice(4);
    m.checkRecoveryKey.mockRejectedValueOnce(new WayInError(KEY_TYPO));
    fireEvent.change(screen.getByTestId('backup-recovery-key'), { target: { value: slip } });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText(KEY_TYPO)).toBeTruthy();
    expect(m.saveFile).not.toHaveBeenCalled();
  });

  it('saves nothing for a key with good check bytes that does not open this budget now', async () => {
    // A recovery key replaced since (or another budget's): its check bytes pass, its slot is not in force.
    m.checkRecoveryKey.mockRejectedValueOnce(
      new WayInError('That recovery key doesn’t open this budget. Check it and try again.'),
    );
    render(<DeviceBackup />);
    fireEvent.change(screen.getByTestId('backup-recovery-key'), {
      target: { value: await showRecoveryKey(newRecoveryKey()) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(
      await screen.findByText('That recovery key doesn’t open this budget. Check it and try again.'),
    ).toBeTruthy();
    expect(m.copyBytes).not.toHaveBeenCalled();
    expect(m.saveFile).not.toHaveBeenCalled();
  });

  it('warns before it saves the copy without a lock', async () => {
    render(<DeviceBackup />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/anyone who gets the file can read your whole budget/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(m.saveFile).toHaveBeenCalledTimes(1));
    const f = await saved();
    expect(f.name).toMatch(/\.sqlite$/);
    expect(m.checkRecoveryKey).not.toHaveBeenCalled();
    expect([...f.bytes]).toEqual([...COPY]);
  });
});
