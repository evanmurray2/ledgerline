// A locked budget's bank links: the server keeps each link's state (a bank that needs you to sign in again, or whose
// last fetch failed), and the copy on the device never learns it, so its Accounts screen would show every bank as
// fine. This lays the server's states over what the copy worked out (hunt month-sim, Nov 15, 2026).
import type { AccountsView, ConnectionsView } from '@ledgerline/contracts';

const FOUR_HOURS = 4 * 3_600_000;

export function withLinkStates(view: AccountsView, server: ConnectionsView, now: number): AccountsView {
  const states = new Map(server.items.map((i) => [i.id, i]));
  const bankOf = (connectionId: string) =>
    [...view.groups.flatMap((g) => g.accounts), ...view.closed].find((a) => a.connectionId === connectionId)
      ?.institution ?? 'Your bank';
  const repairs = [...view.repairs];
  const failures = [...view.failures];
  for (const i of server.items) {
    if (i.status === 'login_required' && !repairs.some((r) => r.connectionId === i.id))
      repairs.push({ connectionId: i.id, institution: bankOf(i.id), lastSynced: i.lastSynced });
    if (i.status === 'error' && !failures.some((f) => f.connectionId === i.id))
      failures.push({
        connectionId: i.id,
        institution: bankOf(i.id),
        lastGood: i.lastSynced,
        // The server tries each link again every 4 hours.
        nextRetry: Math.max(now, i.lastSynced ?? now) + FOUR_HOURS,
      });
  }
  const row = (a: AccountsView['groups'][number]['accounts'][number]) => {
    const s = a.connectionId ? states.get(a.connectionId)?.status : undefined;
    if (!s || s === 'ok' || s === 'removed' || a.closed || a.unlinked || a.connectionStatus !== 'ok')
      return a;
    return {
      ...a,
      connectionStatus: s,
      meta: s === 'login_required' ? a.meta.replace(/ · synced [^·]*$/, ' · sign in again') : a.meta,
    };
  };
  return {
    ...view,
    groups: view.groups.map((g) => ({ ...g, accounts: g.accounts.map(row) })),
    repairs,
    failures,
  };
}
