// Settings → Backup: the full backup, made on this device from its copy (DeviceBackup.tsx). Every budget is locked
// (D-102): the server can't read it, so it can't export or rewind it.
import { DeviceBackup } from './DeviceBackup';
import { useScreen } from '../../lib/common';
import { Page } from './common';

export function DataScreen() {
  useScreen('settings.data');
  return (
    <Page title="Backup and export" back="/settings">
      <DeviceBackup />
      <span className="text-xs text-muted">
        The server can’t rewind a locked budget: it can’t read it. Keep a full backup of your own.
      </span>
    </Page>
  );
}
