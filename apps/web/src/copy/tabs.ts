// The app's other tabs on this device share its sign-in. When one tab ends it (Sign out, or 10 idle minutes), the
// others are told at once, so none keeps showing the budget from its copy in memory until it next asks the server.
// Split from copy.ts.
const SIGN_IN_CHANNEL = 'ledgerline-sign-in';
let channel: BroadcastChannel | null | undefined;
function otherTabs(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = new BroadcastChannel(SIGN_IN_CHANNEL);
      // Node (unit tests) would otherwise wait on it forever.
      (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    } catch {
      channel = null;
    }
  }
  return channel;
}

/**
 * `locked`: the sign-in ended and the saved copies stay. `deleted`: Sign out of this device deleted them. `active`:
 * someone is using that tab (at most once every TELL_ACTIVE_MS).
 */
export type TabNotice = 'locked' | 'deleted' | 'active';
const TELL_ACTIVE_MS = 30_000;
let lastTold = 0;

export function tellOtherTabs(notice: TabNotice): void {
  try {
    otherTabs()?.postMessage(notice);
  } catch {
    // A closed channel: the other tabs find out at their next request.
  }
}

/** Someone used this tab at `at`: the other tabs are told, at most once every TELL_ACTIVE_MS. */
export function tellActive(at: number): void {
  if (at - lastTold >= TELL_ACTIVE_MS) {
    lastTold = at;
    tellOtherTabs('active');
  }
}

/** Calls `fn` with what another tab says (a TabNotice, or anything else a tab of another version posts). */
export function onOtherTabs(fn: (notice: unknown) => void): void {
  otherTabs()?.addEventListener('message', (e: MessageEvent) => fn(e.data));
}
