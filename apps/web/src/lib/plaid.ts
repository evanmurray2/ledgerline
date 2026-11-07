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
export async function runPlaidLink(mode: 'new' | 'repair', connectionId?: string): Promise<LinkOutcome> {
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
