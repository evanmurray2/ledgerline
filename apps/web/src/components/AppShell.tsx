// Phone: screen content above a bottom tab bar (Budget, Activity, Accounts, Reports). Desktop: a left sidebar
// replaces the tab bar and a right-hand panel holds sheets. The offline / read-only banner sits on top.
import { RecoveryNotice } from '../screens/Signup';
import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { PanelSlotContext, useModalOpen } from './Sheet';
import { ToastHost } from './Toast';
import { BlockedAction } from './BlockedAction';
import { AlertBadge, cx, Icon, useIsDesktop, type IconName } from './ui';
import { NoteSheet } from '../screens/Note';
import { useBadgeCounts, useBudget, useSession } from '../api/hooks';
import { useCopy } from '../copy/copy';
import { useCanWrite, useConnectivity } from '../state/connectivity';
import { budgetTime } from '../lib/dates';
import { dailyResetTime } from '../api/client';
import { formatCents } from '../lib/money';
import { useTabMonth } from '../state/month';
import { returnOrigin, useHere } from '../lib/back';

type Tab = 'budget' | 'activity' | 'accounts' | 'reports' | 'settings';

export function tabFor(path: string, search?: Record<string, unknown>): Tab {
  // A screen opened from another tab lights the tab it came from, where Back or closing returns (lib/back.ts).
  const origin = search && returnOrigin(search);
  if (origin) return tabFor(origin.path, origin.search);
  // Owed to you opens from Budget and from Accounts' net worth card; it lights the tab it came from.
  if (path.startsWith('/owed') && search?.from === 'accounts') return 'accounts';
  // One category's transactions open from Reports, with Back to it.
  if (path.startsWith('/activity') && search?.category) return 'reports';
  if (path.startsWith('/activity')) return 'activity';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/accounts')) return 'accounts';
  if (path.startsWith('/reports')) return 'reports';
  return 'budget';
}

/**
 * Which tabs need you, each shown as a red "!". Activity and Accounts come from a cheap endpoint (the full views read
 * every transaction). Budget's comes from this month's budget, worked out on the device (D-45) and shared with the
 * Budget screen's own query: anything in its Needs attention list, or Ready to Assign below zero.
 */
function useBadges() {
  const b = useBadgeCounts();
  const session = useSession();
  const budget = useBudget(session.data?.budget.currentMonth);
  return {
    budget: !!budget.data && budget.data.attention.some((a) => a.section !== 'Low'),
    activity: (b.data?.activity ?? 0) > 0,
    accounts: (b.data?.accounts ?? 0) > 0,
    reports: false,
    settings: false,
    rta: b.data?.rta,
    rtaUpdating: b.data?.rtaUpdating ?? false,
  };
}

// The three month tabs side by side, then Accounts (today's balances, no month) with Settings behind it.
// `alert` is what VoiceOver hears after the tab's name when the tab shows its "!".
const TABS: { id: Tab; name: string; to: string; icon: IconName; alert: string }[] = [
  { id: 'budget', name: 'Budget', to: '/budget', icon: 'budget', alert: 'needs attention' },
  { id: 'activity', name: 'Activity', to: '/activity', icon: 'activity', alert: 'needs attention' },
  { id: 'reports', name: 'Reports', to: '/reports', icon: 'reports', alert: '' },
  { id: 'accounts', name: 'Accounts', to: '/accounts', icon: 'accounts', alert: 'a bank needs repair' },
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
      className="safe-tabs grid min-h-[72px] shrink-0 grid-cols-4 border-t border-line bg-surface px-2 pt-1.5 short:min-h-0 short:pt-0.5"
    >
      {TABS.map((t) => {
        const on = t.id === current;
        const alert = badges[t.id];
        return (
          <Link
            key={t.id}
            to={t.to}
            search={tabSearch(t.id, month)}
            data-track={`tabs.${t.id}`}
            aria-current={on ? 'page' : undefined}
            aria-label={alert ? `${t.name}, ${t.alert}` : t.name}
            className={cx(
              'relative flex min-h-12 flex-col items-center justify-center gap-[3px] text-xs no-underline',
              on ? 'font-bold text-accent' : 'font-medium text-muted',
            )}
          >
            <Icon name={t.icon} size={22} />
            {alert && <AlertBadge className="absolute left-1/2 top-0.5 ml-1.5" />}
            <span aria-hidden="true" className="short:hidden">
              {t.name}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

function DNav({ active, onNote, noteButton }: { active: Tab; onNote: () => void; noteButton: boolean }) {
  const badges = useBadges();
  // Assigning works offline with the copy on this device (D-45), like the Assign sheet itself.
  const canWrite = useCanWrite({ offline: true });
  const month = useTabMonth();
  const here = useHere();
  const rta = badges.rta;
  const items: { id: Tab; name: string; to: string; alert: string }[] = [
    ...TABS,
    { id: 'settings', name: 'Settings', to: '/settings', alert: '' },
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
            aria-label={badges[n.id] ? `${n.name}, ${n.alert}` : undefined}
            className={cx(
              'hit flex h-10 items-center justify-between rounded-md px-2.5 text-md font-semibold no-underline',
              on ? 'bg-accent-soft text-accent' : 'bg-transparent text-ink-2',
            )}
          >
            <span>{n.name}</span>
            {badges[n.id] && <AlertBadge />}
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
        {/* On one line: a long amount steps down a size rather than leave its minus sign on a line of its own. */}
        <span
          className={cx(
            'tnum whitespace-nowrap font-bold',
            // The card is 172 px inside: the longest amounts ("-$100,001,999.89") step down twice.
            rta === undefined || formatCents(rta).length <= 12
              ? 'text-3xl'
              : formatCents(rta).length <= 14
                ? 'text-2xl'
                : 'text-lg',
          )}
          data-testid="nav-rta"
        >
          {badges.rtaUpdating ? 'Updating' : rta === undefined ? '—' : formatCents(rta)}
        </span>
        {/* The one Assign button on desktop, on every screen, so the amount isn't repeated in a header. */}
        {!done &&
          (canWrite && negative ? (
            // Below zero the job is to take money back, which Budget offers at the top (as on a phone).
            <Link
              to="/budget"
              search={tabSearch('budget', month)}
              data-track="nav.take_back"
              className="hit mt-1.5 flex h-9 items-center justify-center rounded-full bg-on-danger text-md font-bold text-danger no-underline"
            >
              Take back
            </Link>
          ) : canWrite ? (
            <Link
              to="/budget/assign"
              // From another tab, closing Assign comes back to it (lib/back.ts).
              search={here.startsWith('/budget') ? undefined : { close: here }}
              data-track="nav.assign"
              className="hit mt-1.5 flex h-9 items-center justify-center rounded-full bg-rta-fg text-md font-bold text-rta-btn-fg no-underline"
            >
              Assign
            </Link>
          ) : (
            <BlockedAction
              track="nav.assign.blocked"
              className="mt-1.5 flex h-9 items-center justify-center rounded-full bg-rta-fg/50 text-md font-bold text-rta-btn-fg"
            >
              Assign
            </BlockedAction>
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
  const loaded = c.loadedAt ? budgetTime(c.loadedAt) : null;
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
            ? `Some changes still work and are sent when you’re back online.${copy.queued ? ` ${copy.queued} waiting to send.` : ''}${
                // With no saved copy, waiting changes live only in memory (copy/copy.ts).
                copy.queued && !copy.saved
                  ? ' Keep Ledgerline open until they’re sent. Closing it loses them.'
                  : ''
              }`
            : `${loaded ? `Showing what was loaded at ${loaded}.` : 'Showing what was last loaded.'} Changes are off.`}
        </span>
      </div>
    );
  const until = (c.readOnlyUntil && budgetTime(c.readOnlyUntil)) || dailyResetTime();
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
      <span className="text-md font-bold">Paused until {until}</span>
      <span className="text-sm leading-snug">Screens show what’s saved on this device. Nothing is lost.</span>
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
          Today’s free limit for changes is used up. Changes and bank sync start again at {until}. Nothing is
          lost.
        </span>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const active = tabFor(path, search);
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
            <RecoveryNotice />
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
        <RecoveryNotice />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        <TabBar active={active} />
      </div>
      {noteButton && (
        <button
          type="button"
          data-track="app.note"
          aria-label="Write a note about this screen"
          onClick={() => setNoteOpen(true)}
          className="fixed bottom-[calc(164px+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-raised"
        >
          <Icon name="note" size={18} />
        </button>
      )}
      <ToastHost aboveTabs />
      {noteOpen && <NoteSheet onClose={() => setNoteOpen(false)} />}
    </PanelSlotContext.Provider>
  );
}
