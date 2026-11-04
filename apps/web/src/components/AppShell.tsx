// Phone: screen content above a bottom tab bar (Budget, Activity, Accounts, Reports). Desktop: a left sidebar
// replaces the tab bar and a right-hand panel holds sheets. The offline / read-only banner sits on top.
import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { PanelSlotContext, useModalOpen } from './Sheet';
import { ToastHost } from './Toast';
import { CountBadge, cx, Icon, useIsDesktop, type IconName } from './ui';
import { NoteSheet } from '../screens/Note';
import { useBadgeCounts, useSession } from '../api/hooks';
import { useCopy } from '../copy/copy';
import { useCanWrite, useConnectivity } from '../state/connectivity';
import { pacificTime } from '../lib/dates';
import { formatCents } from '../lib/money';
import { useTabMonth } from '../state/month';

type Tab = 'budget' | 'activity' | 'accounts' | 'reports' | 'settings';

export function tabFor(path: string): Tab {
  if (path.startsWith('/activity')) return 'activity';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/accounts')) return 'accounts';
  if (path.startsWith('/reports')) return 'reports';
  return 'budget';
}

/** The tab badges come from a cheap endpoint: the full Activity and Accounts views read every transaction. */
function useBadges() {
  const b = useBadgeCounts();
  return {
    activity: b.data?.activity ?? 0,
    accounts: b.data?.accounts ?? 0,
    rta: b.data?.rta,
    rtaUpdating: b.data?.rtaUpdating ?? false,
  };
}

// The three month tabs side by side, then Accounts (today's balances, no month) with Settings behind it.
const TABS: { id: Tab; name: string; to: string; icon: IconName; what: string }[] = [
  { id: 'budget', name: 'Budget', to: '/budget', icon: 'budget', what: '' },
  { id: 'activity', name: 'Activity', to: '/activity', icon: 'activity', what: 'need attention' },
  { id: 'reports', name: 'Reports', to: '/reports', icon: 'reports', what: '' },
  { id: 'accounts', name: 'Accounts', to: '/accounts', icon: 'accounts', what: 'connection problem' },
];

/** The app's month goes with the tab links to Budget, Activity and Reports (docs/month-header.md). */
function tabSearch(id: Tab, month: string | undefined) {
  return id === 'budget' || id === 'activity' || id === 'reports' ? { month } : undefined;
}

function TabBar({ active }: { active: Tab }) {
  const badges = useBadges();
  const month = useTabMonth();
  const current = active === 'settings' ? 'accounts' : active;
  return (
    <nav
      aria-label="Main"
      className="safe-tabs grid min-h-[72px] shrink-0 grid-cols-4 border-t border-line bg-surface px-2 pt-1.5"
    >
      {TABS.map((t) => {
        const on = t.id === current;
        const badge = t.id === 'activity' ? badges.activity : t.id === 'accounts' ? badges.accounts : 0;
        // Activity counts to-dos (gray); Accounts counts broken bank links (red).
        const problem = t.id === 'accounts';
        return (
          <Link
            key={t.id}
            to={t.to}
            search={tabSearch(t.id, month)}
            data-track={`tabs.${t.id}`}
            aria-current={on ? 'page' : undefined}
            aria-label={badge > 0 ? `${t.name}, ${badge} ${t.what}` : t.name}
            className={cx(
              'relative flex min-h-12 flex-col items-center justify-center gap-[3px] text-xs no-underline',
              on ? 'font-bold text-accent' : 'font-medium text-muted',
            )}
          >
            <Icon name={t.icon} size={22} />
            {badge > 0 && (
              <CountBadge n={badge} danger={problem} size="sm" className="absolute left-1/2 top-0.5 ml-1.5" />
            )}
            <span aria-hidden="true">{t.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function DNav({ active, onNote, noteButton }: { active: Tab; onNote: () => void; noteButton: boolean }) {
  const badges = useBadges();
  const canWrite = useCanWrite();
  const month = useTabMonth();
  const rta = badges.rta;
  const items: { id: Tab; name: string; to: string; badge: number }[] = [
    { id: 'budget', name: 'Budget', to: '/budget', badge: 0 },
    { id: 'activity', name: 'Activity', to: '/activity', badge: badges.activity },
    { id: 'reports', name: 'Reports', to: '/reports', badge: 0 },
    { id: 'accounts', name: 'Accounts', to: '/accounts', badge: badges.accounts },
    { id: 'settings', name: 'Settings', to: '/settings', badge: 0 },
  ];
  const negative = rta !== undefined && rta < 0;
  const done = rta === 0 && !badges.rtaUpdating;
  return (
    <nav
      aria-label="Main"
      className="flex h-full w-[220px] shrink-0 flex-col gap-1 border-r border-line bg-surface px-3 py-5"
    >
      <span className="px-2.5 pb-4 text-xl font-bold">Ledgerline</span>
      {items.map((n) => {
        const on = n.id === active;
        return (
          <Link
            key={n.id}
            to={n.to}
            search={tabSearch(n.id, month)}
            data-track={`nav.${n.id}`}
            aria-current={on ? 'page' : undefined}
            className={cx(
              'hit flex h-10 items-center justify-between rounded-md px-2.5 text-md font-semibold no-underline',
              on ? 'bg-accent-soft text-accent' : 'bg-transparent text-ink-2',
            )}
          >
            <span>{n.name}</span>
            {n.badge > 0 && <CountBadge n={n.badge} danger={n.id === 'accounts'} />}
          </Link>
        );
      })}
      {noteButton && (
        <button
          type="button"
          data-track="nav.note"
          onClick={onNote}
          className="mt-2 flex h-10 items-center gap-2 rounded-md px-2.5 text-md font-semibold text-ink-2"
        >
          <Icon name="note" size={18} /> Note
        </button>
      )}
      <div
        className={cx(
          'mt-auto flex flex-col gap-0.5 rounded-lg p-3',
          negative
            ? 'bg-danger text-on-danger'
            : done
              ? 'border border-line text-muted'
              : 'bg-rta-bg text-rta-fg',
        )}
      >
        <span className="text-xs font-semibold">{done ? 'All money assigned' : 'Ready to Assign'}</span>
        <span className="tnum text-3xl font-bold" data-testid="nav-rta">
          {badges.rtaUpdating ? 'Updating' : rta === undefined ? '—' : formatCents(rta)}
        </span>
        {/* The one Assign button on desktop, on every screen, so the amount isn't repeated in a header. */}
        {!done &&
          (canWrite ? (
            <Link
              to="/budget/assign"
              data-track="nav.assign"
              className="hit mt-1.5 flex h-9 items-center justify-center rounded-full bg-rta-fg text-md font-bold text-rta-btn-fg no-underline"
            >
              Assign
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="mt-1.5 flex h-9 items-center justify-center rounded-full bg-rta-fg/50 text-md font-bold text-rta-btn-fg"
            >
              Assign
            </span>
          ))}
      </div>
    </nav>
  );
}

/** Offline and daily-limit banners. Shown on every screen while they apply. */
export function StatusBanner() {
  const c = useConnectivity();
  const copy = useCopy();
  const offline = !c.online || c.networkFailed;
  if (!offline && !c.readOnly && !c.readsPaused) return null;
  const loaded = c.loadedAt ? pacificTime(c.loadedAt) : null;
  if (offline)
    return (
      <div
        role="status"
        data-testid="offline-banner"
        className="flex shrink-0 flex-col gap-1 border-b border-line bg-sunken px-4 py-2.5 text-none-fg"
      >
        <span className="text-md font-bold">You’re offline</span>
        <span className="text-sm leading-snug">
          {copy.status === 'ready'
            ? `Categorizing, editing a transaction and assigning still work${copy.queued ? ` (${copy.queued} waiting to send)` : ''}; they’re sent when you’re back online. Other changes are off.`
            : `${loaded ? `Showing what was loaded at ${loaded}.` : 'Showing what was last loaded.'} Changes are off until you’re back online.`}
        </span>
      </div>
    );
  const until = c.readOnlyUntil ? pacificTime(c.readOnlyUntil) : 'midnight UTC';
  if (c.readsPaused) return <RestingBanner until={until} />;
  return <ReadOnlyBanner until={until} />;
}

/** 95% of a daily limit: nothing is loaded until the reset, so the app never hits Cloudflare's hard stop. */
function RestingBanner({ until }: { until: string }) {
  return (
    <div
      role="status"
      data-testid="resting-banner"
      className="flex shrink-0 flex-col gap-1 border-b border-warn-border bg-warn-bg px-4 py-2 text-warn-fg"
    >
      <span className="text-md font-bold">Resting until {until}</span>
      <span className="text-sm leading-snug">
        The app has nearly used today’s free allowance, so it has stopped loading and saving to stay online.
        Screens show what was last saved on this device. Nothing is lost.
      </span>
    </div>
  );
}

function ReadOnlyBanner({ until }: { until: string }) {
  const [why, setWhy] = useState(false);
  return (
    <div
      role="status"
      data-testid="readonly-banner"
      className="flex shrink-0 flex-col gap-1 border-b border-warn-border bg-warn-bg px-4 py-2 text-warn-fg"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-md font-bold">View only until {until}</span>
        <button
          type="button"
          data-track="banner.readonly.why"
          aria-expanded={why}
          onClick={() => setWhy(!why)}
          className="hit h-7 shrink-0 text-md font-bold underline"
        >
          {why ? 'Hide' : 'Why?'}
        </button>
      </div>
      {why && (
        <span className="text-sm leading-snug">
          The app has used today’s free allowance for saving changes. Changes start again at {until}, and bank
          sync catches up then. Nothing is lost.
        </span>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = tabFor(path);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const session = useSession();
  const noteButton = !!session.data?.settings.noteButton;
  // While a sheet covers the screen, the screen under it can't be reached with VoiceOver or Tab.
  const modal = useModalOpen();

  if (desktop) {
    return (
      <PanelSlotContext.Provider value={slot}>
        <div className="safe-top flex h-full bg-page" inert={modal || undefined}>
          <DNav active={active} onNote={() => setNoteOpen(true)} noteButton={noteButton} />
          <div className="flex min-w-0 flex-1 flex-col">
            <StatusBanner />
            <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          </div>
          <div
            ref={setSlot}
            data-testid="side-panel"
            className="h-full w-[400px] shrink-0 overflow-hidden border-l border-line bg-surface empty:hidden"
          />
        </div>
        <ToastHost aboveTabs={false} />
        {noteOpen && <NoteSheet onClose={() => setNoteOpen(false)} />}
      </PanelSlotContext.Provider>
    );
  }
  return (
    <PanelSlotContext.Provider value={null}>
      <div
        className="safe-top safe-x mx-auto flex h-full max-w-[1023px] flex-col bg-page"
        inert={modal || undefined}
      >
        <StatusBanner />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        <TabBar active={active} />
      </div>
      {noteButton && (
        <button
          type="button"
          data-track="app.note"
          aria-label="Write a note about this screen"
          onClick={() => setNoteOpen(true)}
          className="fixed bottom-[calc(150px+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-raised"
        >
          <Icon name="note" size={18} />
        </button>
      )}
      <ToastHost aboveTabs />
      {noteOpen && <NoteSheet onClose={() => setNoteOpen(false)} />}
    </PanelSlotContext.Provider>
  );
}
