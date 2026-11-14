// Budget → Needs attention, for what only this device can notice: a full backup that is long overdue, and a bank
// link the server has not fetched for a day. The server can't read the budget and has no monitor (D-49), so these
// are the app's only warnings that the budget's one off-site copy is old, or that bank rows stopped coming.
import type { ConnectionsView } from '@ledgerline/contracts';
import { useConnections, useSession } from '../api/hooks';
import { Banner } from '../components/ui';
import { useCopy } from '../copy/copy';
import { BACKUP_DUE_DAYS } from '../copy/vault';
import { syncedLabel } from '../lib/dates';

/** A link with no complete fetch for this long shows here. The server tries every 4 hours (seal/fetch-job.ts). */
export const BANK_BEHIND_MS = 24 * 3_600_000;

type Link = ConnectionsView['items'][number];

/**
 * The bank links whose last complete fetch is a day old or more. A link that needs the person to sign in again is
 * not here: Accounts already says so. A link still being set up has nothing to fetch yet.
 */
export function banksBehind(items: readonly Link[], now: number): Link[] {
  return items.filter(
    (i) =>
      (i.status === 'ok' || i.status === 'error') &&
      i.setupDone &&
      now - (i.lastSynced ?? i.linkedAt) > BANK_BEHIND_MS,
  );
}

/** What this file adds to Needs attention: one for the backup, one per bank behind. */
export function useDeviceAttention(): { backupDue: boolean; behind: Link[]; count: number } {
  const backupDue = !!useCopy().backupDue;
  const behind = banksBehind(useConnections().data?.items ?? [], Date.now());
  return { backupDue, behind, count: (backupDue ? 1 : 0) + behind.length };
}

export function DeviceAttention() {
  const { backupDue, behind } = useDeviceAttention();
  const today = useSession().data?.budget.today ?? '';
  return (
    <>
      {behind.map((i) => (
        <Banner
          key={i.id}
          tone="warn"
          icon="alert"
          title={
            i.lastSynced === null
              ? `${i.institution || 'A bank'} hasn’t synced since it was linked`
              : `${i.institution || 'A bank'} hasn’t synced since ${syncedLabel(i.lastSynced, today)}`
          }
          to="/settings/connections"
          track="budget.attention.bank_behind"
        >
          New transactions from it aren’t coming in. Open Bank connections to sync it now.
        </Banner>
      ))}
      {backupDue && (
        <Banner
          tone="warn"
          icon="alert"
          title="Save a full backup"
          to="/settings/data"
          track="budget.attention.backup"
        >
          This device hasn’t saved one for {BACKUP_DUE_DAYS} days. It is the only copy if your account is
          lost.
        </Banner>
      )}
    </>
  );
}
