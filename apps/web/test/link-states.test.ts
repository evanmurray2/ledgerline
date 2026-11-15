import type { AccountsView, ConnectionsView } from '@ledgerline/contracts';
import { describe, expect, it } from 'vitest';
import { withLinkStates } from '../src/api/link-states';

const account = (
  id: string,
  connectionId: string | null,
): AccountsView['groups'][number]['accounts'][number] => ({
  id,
  name: id,
  kind: 'checking',
  institution: 'E2E Bank',
  mask: '0001',
  bank: 100,
  pending: 0,
  working: 100,
  syncedAt: 1,
  connectionStatus: 'ok',
  drift: null,
  pendingInBank: 0,
  statement: null,
  meta: 'E2E Bank · ending 0001 · synced 6:56 AM',
  closed: false,
  connectionId,
  unlinked: false,
});

const view = (): AccountsView => ({
  netWorth: 100,
  netWorthChange: 0,
  month: '2026-11',
  owedOut: 0,
  groups: [{ name: 'Cash', total: 100, accounts: [account('acc_1', 'con_1'), account('acc_2', null)] }],
  closed: [],
  repairs: [],
  failures: [],
  alerts: [],
});

const server = (status: ConnectionsView['items'][number]['status']): ConnectionsView => ({
  used: 1,
  limit: 10,
  environment: 'sandbox',
  items: [
    { id: 'con_1', institution: '', accounts: '', status, lastSynced: 1000, linkedAt: 1, setupDone: true },
  ],
});

describe('withLinkStates', () => {
  it('a link that needs sign-in shows as a repair, and its accounts say so', () => {
    const v = withLinkStates(view(), server('login_required'), 5000);
    expect(v.repairs).toEqual([{ connectionId: 'con_1', institution: 'E2E Bank', lastSynced: 1000 }]);
    const [linked, manual] = v.groups[0]!.accounts;
    expect(linked!.connectionStatus).toBe('login_required');
    expect(linked!.meta).toBe('E2E Bank · ending 0001 · sign in again');
    expect(manual!.connectionStatus).toBe('ok');
  });

  it('a failed fetch shows as a failure with the next try in 4 hours', () => {
    const v = withLinkStates(view(), server('error'), 5000);
    expect(v.failures).toEqual([
      { connectionId: 'con_1', institution: 'E2E Bank', lastGood: 1000, nextRetry: 5000 + 4 * 3_600_000 },
    ]);
    expect(v.groups[0]!.accounts[0]!.connectionStatus).toBe('error');
  });

  it('a link that is fine, or already listed by the copy, changes nothing', () => {
    expect(withLinkStates(view(), server('ok'), 5000)).toEqual(view());
    const listed = {
      ...view(),
      repairs: [{ connectionId: 'con_1', institution: 'E2E Bank', lastSynced: 1 }],
    };
    expect(withLinkStates(listed, server('login_required'), 5000).repairs).toHaveLength(1);
  });
});
