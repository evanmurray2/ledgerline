// Linking and repairing a bank (docs/privacy.md 5.7). The person does it on Plaid's own site: no Plaid script runs in
// the app, and the app's CSP allows no outside host.
import { api } from '../api/endpoints';
import { safeStorage } from './safe-storage';

const LOAD_FAILED = 'The bank sign-in page didn’t open. Check your connection and try again.';

export type LinkOutcome =
  { status: 'linked'; connectionId: string } | { status: 'repaired' } | { status: 'exited' };

/**
 * Sends the person to Plaid's site to link a bank (`new`) or sign in to one again (`repair`), and says what it came
 * to. In a browser the page leaves, and `resumeHostedLink` finishes on the way back in.
 */
export function runPlaidLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
  return import.meta.env.VITE_MOCK === '1' ? mockLink(mode, connectionId) : runHostedLink(mode, connectionId);
}

/** Mock mode has no Plaid and no server: pretend the person finished (src/mock answers the link's end). */
async function mockLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
  const { linkToken } = await api.linkToken({
    mode,
    connectionId,
    confirmSlot: mode === 'new' ? true : undefined,
  });
  await new Promise((r) => setTimeout(r, 300));
  if (mode === 'repair') return { status: 'repaired' };
  const r = await api.linkFinish({ linkToken, mode });
  return r.status === 'linked' ? { status: 'linked', connectionId: r.connectionId } : { status: 'exited' };
}

// ------------------------------------------------------------------ on Plaid's site
// This page goes to Plaid's site and Plaid
// sends it back to /link-done. The app finishes the link by asking the server what the session came to, never by
// trusting where a browser lands.
//
// Why this page and not a new tab: a tab must open before anything is awaited, and the link token may first need
// "Confirm it's you", whose passkey prompt a new tab would cover.

const PENDING_KEY = 'ledgerline.link';
/** Set in the page that left for Plaid's site, so `/link-done` comes back into the app, to that page (its path). */
export const LEFT_HERE_KEY = 'ledgerline.link.left';
/** How long a session on Plaid's site may take: its link token lasts 30 minutes. */
const HOSTED_MS = 30 * 60 * 1000;
const POLL_MS = 2500;

/** Leaving the app for another site. Its own object, so a test can stand in for it. */
export const leave = { to: (url: string) => window.location.assign(url) };

interface PendingLink {
  linkToken: string;
  mode: 'new' | 'repair';
  connectionId?: string;
  at: number;
}

function readPending(): PendingLink | null {
  const p = safeStorage.getJson<PendingLink | null>(PENDING_KEY, null);
  if (!p || typeof p.linkToken !== 'string' || Date.now() - p.at > HOSTED_MS) return null;
  return p;
}
/** Storage off (private mode): the link still finishes while this page stays open. */
function writePending(p: PendingLink | null): void {
  if (p) safeStorage.set(PENDING_KEY, JSON.stringify(p));
  else safeStorage.remove(PENDING_KEY);
}
function markLeft(left: boolean): void {
  try {
    if (left) sessionStorage.setItem(LEFT_HERE_KEY, window.location.pathname + window.location.search);
    else sessionStorage.removeItem(LEFT_HERE_KEY);
  } catch {
    // Without it, /link-done says to go back to Ledgerline, which still works.
  }
}

/** Waits `ms`, or less when the person comes back to this page. */
function waitOrReturn(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') done();
    };
    const timer = setTimeout(done, ms);
    document.addEventListener('visibilitychange', onVisible);
  });
}

/** True while this page waits on a session it started: `resumeHostedLink` then leaves it alone. */
let waiting = false;

async function runHostedLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
  waiting = true;
  try {
    return await hostedLink(mode, connectionId);
  } finally {
    waiting = false;
  }
}

async function hostedLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
  const { linkToken, hostedUrl } = await api.linkToken({
    mode,
    connectionId,
    confirmSlot: mode === 'new' ? true : undefined,
    hosted: true,
  });
  if (!hostedUrl) throw new Error(LOAD_FAILED);
  const pending: PendingLink = { linkToken, mode, connectionId, at: Date.now() };
  writePending(pending);
  markLeft(true);
  leave.to(hostedUrl);
  // In a browser this page is now gone, and `resumeHostedLink` finishes when the person is back. The Home Screen
  // app shows another site in a sheet over the app, so this page lives on: it asks the server until the session ends.
  for (;;) {
    await waitOrReturn(POLL_MS);
    const r = await api.linkFinish({ linkToken: pending.linkToken, mode });
    if (r.status !== 'waiting') {
      writePending(null);
      markLeft(false);
      return r.status === 'linked'
        ? { status: 'linked', connectionId: r.connectionId }
        : { status: r.status };
    }
    if (Date.now() - pending.at > HOSTED_MS) {
      writePending(null);
      markLeft(false);
      return { status: 'exited' };
    }
  }
}

/**
 * A hosted Link session this browser started and has not finished here: the page went to Plaid's site and came back,
 * or the app was closed meanwhile. Asks the server once. Null when there is none, or the person is still at Plaid.
 */
export async function resumeHostedLink(): Promise<(LinkOutcome & { connectionId?: string }) | null> {
  const pending = readPending();
  if (!pending || waiting) return null;
  const r = await api.linkFinish({ linkToken: pending.linkToken, mode: pending.mode });
  if (r.status === 'waiting') return null;
  writePending(null);
  if (r.status === 'linked') return { status: 'linked', connectionId: r.connectionId };
  return { status: r.status, connectionId: pending.connectionId };
}
