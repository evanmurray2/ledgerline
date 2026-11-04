// Settings: the layout, the home page, appearance and preferences. Each section has its own file in settings/:
// categories and groups, rules (with live preview), payees, bank connections (Item meter, confirm before Link), and
// import and export. There is no email setting: the app sends no email (decisions.md D-24).
import { SignInSection } from './Auth';
import { useId, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/endpoints';
import { qk, useConnections, usePayees, useSession } from '../api/hooks';
import {
  BackHeader,
  PageFrame,
  Banner,
  Card,
  cx,
  DesktopHeader,
  Loading,
  ScreenBody,
  SectionTitle,
  Toggle,
  useIsDesktop,
} from '../components/ui';
import { useThemePref, writeThemePref, type ThemePref } from '../lib/theme';
import { monthLabel } from '../lib/dates';
import { useScreen } from '../lib/common';
import { usage } from '../usage/tracker';
import { Page, RowLink } from './settings/common';

// ------------------------------------------------------------------ layout

const SECTIONS: { id: string; name: string; to: string }[] = [
  { id: 'appearance', name: 'Appearance and preferences', to: '/settings/appearance' },
  { id: 'payees', name: 'Payees', to: '/settings/payees' },
  { id: 'connections', name: 'Bank connections', to: '/settings/connections' },
  { id: 'data', name: 'Import and export', to: '/settings/data' },
];

function useSectionMeta() {
  const conns = useConnections().data;
  const payees = usePayees().data;
  const needRepair = conns?.items.filter((i) => i.status === 'login_required' || i.status === 'error') ?? [];
  const text: Record<string, string> = {
    appearance: 'Light, Dark or Match device',
    payees: payees ? `Rename and join · ${payees.payees.length} payees` : 'Rename and join',
    connections: conns
      ? `${conns.used} of ${conns.limit} links used${needRepair[0] ? ` · ${needRepair[0].institution} needs repair` : ''}`
      : '',
    data: 'History import · CSV and JSON export · recovery',
  };
  return { text, repair: needRepair.length > 0 };
}

export function SettingsLayout() {
  const desktop = useIsDesktop();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const meta = useSectionMeta();
  const sub = path.replace(/^\/settings\/?/, '');
  const active = sub.split('/')[0] || 'appearance';
  // While leaving Settings this still renders once with the next page's path: keep the last screen id then, or
  // every exit would record a visit to Appearance.
  const screen = useRef('settings');
  if (path.startsWith('/settings')) screen.current = sub ? `settings.${active}` : 'settings';
  useScreen(screen.current);
  if (!desktop) return sub ? <Outlet /> : <SettingsHome />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DesktopHeader title="Settings" wide />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-[260px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface p-3"
        >
          {SECTIONS.map((s) => {
            const on = s.id === active;
            return (
              <Link
                key={s.id}
                to={s.to}
                data-track={`settings.section.${s.id}`}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'flex flex-col gap-0.5 rounded-md px-3 py-2 no-underline',
                  on ? 'bg-accent-soft text-accent' : 'text-ink-2',
                )}
              >
                <span className="text-md font-semibold">{s.name}</span>
                <span
                  className={cx(
                    'text-xs',
                    s.id === 'connections' && meta.repair ? 'text-warn-fg' : 'text-muted',
                  )}
                >
                  {meta.text[s.id]}
                </span>
              </Link>
            );
          })}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {sub ? <Outlet /> : <AppearanceSection />}
        </div>
      </div>
    </div>
  );
}

/** Desktop pages render inside the settings layout without their own back header. */
const THEMES: { id: ThemePref; name: string; desc: string }[] = [
  { id: 'light', name: 'Light', desc: 'Always light' },
  { id: 'dark', name: 'Dark', desc: 'Always dark' },
  { id: 'device', name: 'Match device', desc: 'Follows your phone or computer' },
];

function setTheme(p: ThemePref) {
  writeThemePref(p);
  usage.record('tap', `settings.theme.${p}`);
}

function Preferences() {
  const session = useSession();
  const qc = useQueryClient();
  const s = session.data;
  const [trackNote, setTrackNote] = useState<string | null>(null);
  const patch = async (body: { tracking?: boolean; noteButton?: boolean }) => {
    await api.patchSettings(body);
    await qc.invalidateQueries({ queryKey: qk.session });
    if (body.tracking === false)
      setTrackNote(
        'Collection stopped. Nothing new is recorded; stored events are deleted after 90 days, and you can export them first from Import and export.',
      );
    if (body.tracking === true) setTrackNote(null);
  };
  if (!s) return <Loading />;
  return (
    <>
      <Card>
        <div className="flex min-h-14 items-center justify-between gap-3 px-3 py-2">
          <span className="flex flex-col gap-px text-base font-semibold">
            Time zone
            <span className="text-xs font-normal text-muted">
              Decides which day and month a transaction falls in
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-md text-ink-2">
            {s.budget.timeZone === 'America/Los_Angeles' ? 'US Pacific' : s.budget.timeZone}
          </span>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2">
          <span className="flex flex-col gap-px text-base font-semibold">
            Budget started
            <span className="text-xs font-normal text-muted">Earlier transactions are history only</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-md text-ink-2">
            {s.budget.startMonth ? monthLabel(s.budget.startMonth).replace(/^(\w{3})\w*/, '$1') : '—'}
          </span>
        </div>
        <Toggle
          mutates
          track="settings.tracking"
          label="Record how I use the app"
          help="Taps and timings only, no amounts or names. Export it from Import and export."
          checked={s.settings.tracking}
          onChange={(v) => void patch({ tracking: v })}
        />
        <Toggle
          mutates
          track="settings.note_button"
          label="Show Note button"
          help="A small button on every screen for quick feedback notes"
          checked={s.settings.noteButton}
          onChange={(v) => void patch({ noteButton: v })}
        />
      </Card>
      {trackNote && <Banner tone="neutral">{trackNote}</Banner>}
      <SignInSection />
    </>
  );
}

function SettingsHome() {
  const navigate = useNavigate();
  const meta = useSectionMeta();
  return (
    <PageFrame>
      <BackHeader
        title="Settings"
        onBack={() => void navigate({ to: '/accounts' })}
        backLabel="Back to accounts"
      />
      <ScreenBody>
        <SectionTitle>Budget</SectionTitle>
        <Card>
          <RowLink
            to="/settings/payees"
            name="Payees"
            meta={meta.text.payees ?? ''}
            track="settings.payees"
          />
        </Card>
        <SectionTitle>Data</SectionTitle>
        <Card>
          <RowLink
            to="/settings/connections"
            name="Bank connections"
            meta={meta.text.connections ?? ''}
            warn={meta.repair}
            track="settings.connections"
          />
          <RowLink
            to="/settings/data"
            name="Import and export"
            meta={meta.text.data ?? ''}
            track="settings.data"
          />
        </Card>
        <SectionTitle note="Saved on this device">Appearance</SectionTitle>
        <ThemeChoice />
        <SectionTitle>Preferences</SectionTitle>
        <Preferences />
      </ScreenBody>
    </PageFrame>
  );
}

/** The one Appearance control, on the phone's Settings home and in the desktop Appearance pane. */
function ThemeChoice() {
  const pref = useThemePref();
  const id = useId();
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-2">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={pref === t.id}
          aria-label={t.name}
          aria-describedby={`${id}-${t.id}`}
          data-track={`settings.theme.${t.id}`}
          onClick={() => setTheme(t.id)}
          className={cx(
            'flex min-w-0 flex-col gap-1.5 rounded-lg border-2 bg-surface p-2.5 text-left',
            pref === t.id ? 'border-accent' : 'border-line',
          )}
        >
          <span aria-hidden="true" className="flex h-10 overflow-hidden rounded-md border border-line">
            {/* data-theme draws each half from that theme's tokens. Match device: half light, half dark. */}
            <span data-theme={t.id === 'dark' ? 'dark' : 'light'} className="flex-1 bg-surface" />
            <span
              data-theme={t.id === 'light' ? 'light' : 'dark'}
              className={cx('flex-1', t.id === 'device' ? 'bg-surface' : 'bg-page')}
            />
          </span>
          <span className="text-md font-bold leading-tight">{t.name}</span>
          <span id={`${id}-${t.id}`} className="text-xs leading-snug text-muted">
            {t.desc}
          </span>
        </button>
      ))}
    </div>
  );
}

export function AppearanceSection() {
  return (
    <Page title="Appearance" back="/settings">
      <ThemeChoice />
      <p className="m-0 text-sm text-muted">
        Saved on this device. Every screen follows it, on phone and desktop.
      </p>
      <SectionTitle>Preferences</SectionTitle>
      <Preferences />
    </Page>
  );
}

export { CategoriesScreen, CategoryEditSheet } from './settings/Categories';
export { PayeesScreen, RenamePayeeSheet } from './settings/Payees';
export { ConnectionsScreen, LinkBankFlow, LinkMeter } from './settings/Connections';
export { DataScreen } from './settings/Data';
