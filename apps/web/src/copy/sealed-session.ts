// The session of a person whose budget is sealed (docs/privacy.md 6.2): the server says who is signed in and
// what the account may do; the budget's own facts (its name, its time zone, the month, how far setup is) come
// from the copy on this device, which answers the same question the server used to.
import { Session, type SealedSession } from '@ledgerline/contracts';

export interface SessionDeps {
  /** The copy is open: it can answer for the budget. */
  ready: () => boolean;
  /** The copy's own answer to `GET /api/session`. */
  local: () => Promise<{ status: number; body: string }>;
  /** Tells the copy that the budget is sealed (or is not). */
  note: (s: SealedSession | null) => void;
  /** Keeps the session with the copy, for a start with no signal. */
  keep: (s: Session) => Promise<void>;
  now?: () => Date;
}

/** What the app shows as the session, from the server's answer and, for a sealed budget, from the copy. */
export async function sessionFor(server: Session | SealedSession, d: SessionDeps): Promise<Session> {
  if (!('sealed' in server)) {
    d.note(null);
    return server;
  }
  d.note(server);
  const account = {
    user: { email: server.user.email, login: null },
    appVersion: server.appVersion,
    writeState: server.writeState,
    readOnlyUntil: server.readOnlyUntil,
    readsPaused: server.readsPaused,
    canLinkBanks: server.canLinkBanks,
    hostedLink: true,
    recoveryNoticeAt: server.recoveryNoticeAt,
  };
  if (d.ready()) {
    const r = await d.local();
    const local = r.status === 200 ? Session.safeParse(JSON.parse(r.body)) : null;
    if (local?.success && local.data.budget.id === server.budgetId) {
      const merged: Session = { ...local.data, ...account };
      await d.keep(merged).catch(() => undefined);
      return merged;
    }
  }
  // Before the copy is open, nothing of the budget is known here: enough to open the copy with, and no more.
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  return {
    ...account,
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
