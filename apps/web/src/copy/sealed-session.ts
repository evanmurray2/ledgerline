// The session of a person whose budget is sealed (docs/privacy.md 6.2): the server says who is signed in and
// what the account may do; the budget's own facts (its name, its time zone, the month, how far setup is) come
// from the copy on this device, which answers the same question the server used to.
import { Session, type SealedSession } from '@ledgerline/contracts';

/** Shown when the server answers as if the budget were not locked: every budget is (D-102). */
export const NOT_LOCKED =
  'The server says your budget isn’t locked. Nothing was sent. Update Ledgerline to continue.';

export interface SessionDeps {
  /** The copy is open: it can answer for the budget. */
  ready: () => boolean;
  /** The copy's own answer to `GET /api/session`. */
  local: () => Promise<{ status: number; body: string }>;
  /** Tells the copy that the budget is sealed. */
  note: (s: SealedSession) => void;
  /** The mock API (dev and tests): it answers as the device's copy would, with a plain session. */
  mock?: boolean;
  /** Keeps the session with the copy, for a start with no signal. */
  keep: (s: Session) => Promise<void>;
  now?: () => Date;
}

/** What the app shows as the session, from the server's answer and, for a sealed budget, from the copy. */
export async function sessionFor(server: Session | SealedSession, d: SessionDeps): Promise<Session> {
  // A locked budget does not become a plain one because the server says so: the app would then send the budget's
  // changes in the clear.
  if (!('sealed' in server)) {
    if (d.mock) return server;
    throw new Error(NOT_LOCKED);
  }
  d.note(server);
  if (d.ready()) {
    const m = mergedSession(server, await d.local());
    if (m) {
      await d.keep(m).catch(() => undefined);
      return m;
    }
  }
  // Before the copy is open, nothing of the budget is known here: enough to open the copy with, and no more.
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  return {
    ...accountOf(server),
    budget: {
      id: server.budgetId,
      name: '',
      startMonth: null,
      timeZone: 'UTC',
      currentMonth: today.slice(0, 7) as Session['budget']['currentMonth'],
      today: today as Session['budget']['today'],
      setupStep: 'done',
    },
    settings: { tracking: false, noteButton: false },
  };
}

const accountOf = (server: SealedSession) => ({
  user: { email: server.user.email, login: null },
  appVersion: server.appVersion,
  writeState: server.writeState,
  readOnlyUntil: server.readOnlyUntil,
  readsPaused: server.readsPaused,
  canLinkBanks: server.canLinkBanks,
  hostedLink: true,
});

/**
 * The budget's facts from the copy's own answer to `GET /api/session`, the account's from the server; null when
 * the copy gave no answer for this budget.
 */
export function mergedSession(server: SealedSession, r: { status: number; body: string }): Session | null {
  if (r.status !== 200) return null;
  let body: unknown;
  try {
    body = JSON.parse(r.body);
  } catch {
    return null;
  }
  const local = Session.safeParse(body);
  if (!local.success || local.data.budget.id !== server.budgetId) return null;
  return { ...local.data, ...accountOf(server) };
}
