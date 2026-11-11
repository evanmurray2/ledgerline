// Plaid Link is the only third-party script, loaded only when the person starts linking or repairing a bank.
import { api } from '../api/endpoints';

export const PLAID_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidHandler {
  open: () => void;
  destroy?: () => void;
}
interface PlaidGlobal {
  create: (cfg: {
    token: string;
    onSuccess: (publicToken: string, metadata: unknown) => void;
    onExit: (err: unknown, metadata: unknown) => void;
  }) => PlaidHandler;
}
declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

const LOAD_FAILED = 'The bank sign-in window didn’t open. Check your connection and try again.';
let loading: Promise<PlaidGlobal> | null = null;

export function loadPlaid(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (loading) return loading;
  loading = new Promise<PlaidGlobal>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PLAID_SRC;
    s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error(LOAD_FAILED)));
    s.onerror = () => {
      loading = null;
      reject(new Error(LOAD_FAILED));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export type LinkOutcome =
  { status: 'linked'; connectionId: string } | { status: 'repaired' } | { status: 'exited' };

/**
 * Gets a link token, opens Plaid Link and, for a new link, exchanges the public token. Repair (update mode)
 * keeps the same Item, so there's nothing to exchange; the caller refreshes the connection afterwards.
 */
export function runPlaidLink(
  mode: 'new' | 'repair',
  connectionId?: string,
  /** The session's `hostedLink`: link on Plaid's own site, with no Plaid script in the app. */
  hosted = false,
): Promise<LinkOutcome> {
  return hosted ? runHostedLink(mode, connectionId) : runScriptLink(mode, connectionId);
}

async function runScriptLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
  const { linkToken } = await api.linkToken({
    mode,
    connectionId,
    confirmSlot: mode === 'new' ? true : undefined,
  });
  const publicToken = await openLink(linkToken);
  if (publicToken === null) return { status: 'exited' };
  if (mode === 'repair') return { status: 'repaired' };
  const res = await api.exchange(publicToken);
  return { status: 'linked', connectionId: res.connectionId };
}

function openLink(token: string): Promise<string | null> {
  if (import.meta.env.VITE_MOCK === '1') {
    // Mock mode never loads the real script: pretend the person finished Link.
    return new Promise((r) => setTimeout(() => r('public-sandbox-mock'), 300));
  }
  return loadPlaid().then(
    (Plaid) =>
      new Promise<string | null>((resolve) => {
        const handler = Plaid.create({
          token,
          onSuccess: (publicToken) => {
            resolve(publicToken);
            handler.destroy?.();
          },
          onExit: () => {
            resolve(null);
            handler.destroy?.();
          },
        });
        handler.open();
      }),
  );
}

// ------------------------------------------------------------------ hosted Link (docs/privacy.md 5.7)
// The person links the bank on Plaid's own site, and no Plaid script runs in the app. This page goes there and Plaid
// sends it back to /link-done. The app finishes the link by asking the server what the session came to, never by
// trusting where a browser lands.
//
// Why this page and not a new tab: a tab must open before anything is awaited, and the link token may first need
// "Confirm it's you", whose passkey prompt a new tab would cover.

const PENDING_KEY = 'ledgerline.link';
/** Set in the page that left for Plaid's site, so `/link-done` knows to come back into the app. */
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
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as PendingLink | null;
    if (!p || typeof p.linkToken !== 'string' || Date.now() - p.at > HOSTED_MS) return null;
    return p;
  } catch {
    return null;
  }
}
function writePending(p: PendingLink | null): void {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage is off (private mode): the link still finishes while this page stays open.
  }
}
function markLeft(left: boolean): void {
  try {
    if (left) sessionStorage.setItem(LEFT_HERE_KEY, '1');
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
