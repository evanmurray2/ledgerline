// Settings: categories and groups (archive / restore with Undo), rules (with live preview), payees (merge,
// rename), bank connections (Item meter, confirm before Link), import and export, appearance and preferences.
// There is no email setting: the app sends no email (decisions.md D-24).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { RuleBody } from '@ledgerline/contracts';
import { api, exportUrls } from '../api/endpoints';
import {
  qk,
  useAccounts,
  useCategoriesSettings,
  useConnections,
  useMoneyMutation,
  usePayees,
  useRules,
  useSession,
} from '../api/hooks';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import {
  BackHeader,
  Button,
  Card,
  cx,
  ErrorNote,
  Field,
  Icon,
  inputClass,
  Label,
  Loading,
  PrimaryButton,
  SecondaryButton,
  Segmented,
  Toggle,
  useIsDesktop,
} from '../components/ui';
import { useThemePref, writeThemePref, type ThemePref } from '../lib/theme';
import { formatCents, parseCents, centsToInput } from '../lib/money';
import { dayLabel, monthLabel, syncedLabel } from '../lib/dates';
import { rowMeta, useCategoryOptions, useScreen } from '../lib/common';
import { runPlaidLink } from '../lib/plaid';
import { usage } from '../usage/tracker';
import { useCanWrite } from '../state/connectivity';

// ------------------------------------------------------------------ layout

const SECTIONS: { id: string; name: string; to: string }[] = [
  { id: 'appearance', name: 'Appearance and preferences', to: '/settings/appearance' },
  { id: 'categories', name: 'Categories and groups', to: '/settings/categories' },
  { id: 'rules', name: 'Rules', to: '/settings/rules' },
  { id: 'payees', name: 'Payees', to: '/settings/payees' },
  { id: 'connections', name: 'Bank connections', to: '/settings/connections' },
  { id: 'data', name: 'Import and export', to: '/settings/data' },
];

function useSectionMeta() {
  const cats = useCategoriesSettings().data;
  const rules = useRules().data;
  const conns = useConnections().data;
  const payees = usePayees().data;
  const mine = cats ? cats.groups.filter((g) => !g.system) : [];
  const nCats = mine.reduce((s, g) => s + g.categories.length, 0);
  const needRepair = conns?.items.filter((i) => i.status === 'login_required' || i.status === 'error') ?? [];
  return {
    appearance: 'Light, Dark or Match device',
    categories: cats ? `${nCats} of yours in ${mine.length} groups · ${cats.archived.length} archived` : '',
    rules: rules ? `${rules.rules.length} rules` : '',
    payees: payees ? `Rename and merge · ${payees.payees.length} payees` : 'Rename and merge',
    connections: conns
      ? `${conns.used} of ${conns.limit} links used${needRepair[0] ? ` · ${needRepair[0].institution} needs repair` : ''}`
      : '',
    data: 'History import · CSV and JSON export · backups',
  } as Record<string, string>;
}

export function SettingsLayout() {
  const desktop = useIsDesktop();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const meta = useSectionMeta();
  const sub = path.replace(/^\/settings\/?/, '');
  const active = sub.split('/')[0] || 'appearance';
  useScreen(sub ? `settings.${active}` : 'settings');
  if (!desktop) return sub ? <Outlet /> : <SettingsHome />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 items-center border-b border-line bg-surface px-6">
        <h1 className="m-0 text-[22px] font-bold">Settings</h1>
      </header>
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
                  'flex flex-col gap-0.5 rounded-lg px-3 py-2 no-underline',
                  on ? 'bg-accent-soft text-accent' : 'text-ink-2',
                )}
              >
                <span className="text-[14px] font-semibold">{s.name}</span>
                <span
                  className={cx(
                    'text-[12px]',
                    s.id === 'connections' && meta.connections?.includes('repair')
                      ? 'text-under-fg'
                      : 'text-muted',
                  )}
                >
                  {meta[s.id]}
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
function Page({
  title,
  back,
  right,
  children,
}: {
  title: string;
  back: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <div className="flex items-center justify-between px-6 pt-5">
          <h2 className="m-0 text-[18px] font-bold">{title}</h2>
          {right}
        </div>
      ) : (
        <BackHeader
          title={title}
          onBack={() => void navigate({ to: back })}
          backLabel={`Back to ${back === '/settings' ? 'settings' : back === '/accounts' ? 'accounts' : 'list'}`}
          right={right}
        />
      )}
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3',
          desktop ? 'px-6 pb-8' : 'px-4 pb-6',
        )}
      >
        <div className={cx('flex flex-col gap-3', desktop && 'max-w-[680px]')}>{children}</div>
      </div>
    </div>
  );
}

function RowLink({ to, name, meta, track }: { to: string; name: string; meta: string; track: string }) {
  return (
    <Link
      to={to}
      data-track={track}
      className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-[12px] text-muted">{meta}</span>
      </span>
      <Icon name="chevR" size={18} className="text-faint" />
    </Link>
  );
}

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
          <span className="flex flex-col gap-px text-[15px] font-semibold">
            Time zone
            <span className="text-[12px] font-normal text-muted">
              Decides which day and month a transaction falls in
            </span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-[14px] text-ink-2">
            {s.budget.timeZone === 'America/Los_Angeles' ? 'US Pacific' : s.budget.timeZone}
          </span>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-divider px-3 py-2">
          <span className="flex flex-col gap-px text-[15px] font-semibold">
            Budget started
            <span className="text-[12px] font-normal text-muted">Earlier transactions are history only</span>
          </span>
          <span className="shrink-0 whitespace-nowrap text-[14px] text-ink-2">
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
      {trackNote && (
        <p role="status" className="m-0 rounded-xl bg-page p-3 text-[13px] text-muted">
          {trackNote}
        </p>
      )}
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Sign-in</h2>
      <Card className="p-3">
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">GitHub with passkey</span>
          <span className="text-[13px] leading-snug text-muted">
            Signed in as {s.user.login ?? s.user.email} · session ends after 24 hours. Sign-in is handled by
            Cloudflare Access, so Ledgerline never stores a password.
          </span>
        </div>
      </Card>
      <a
        href="/cdn-cgi/access/logout"
        data-track="settings.sign_out"
        className="flex h-12 items-center justify-center rounded-xl border border-line-strong bg-surface text-[16px] font-bold text-over-fg no-underline"
      >
        Sign out
      </a>
    </>
  );
}

function SettingsHome() {
  const navigate = useNavigate();
  const meta = useSectionMeta();
  const pref = useThemePref();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BackHeader
        title="Settings"
        onBack={() => void navigate({ to: '/accounts' })}
        backLabel="Back to accounts"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6 pt-3">
        <h2 className="m-0 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Budget</h2>
        <Card>
          <RowLink
            to="/settings/categories"
            name="Categories and groups"
            meta={meta.categories ?? ''}
            track="settings.categories"
          />
          <RowLink to="/settings/rules" name="Rules" meta={meta.rules ?? ''} track="settings.rules" />
          <RowLink to="/settings/payees" name="Payees" meta={meta.payees ?? ''} track="settings.payees" />
        </Card>
        <h2 className="m-0 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Data</h2>
        <Card>
          <RowLink
            to="/settings/connections"
            name="Bank connections"
            meta={meta.connections ?? ''}
            track="settings.connections"
          />
          <RowLink
            to="/settings/data"
            name="Import and export"
            meta={meta.data ?? ''}
            track="settings.data"
          />
        </Card>
        <h2 className="m-0 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
          Preferences
        </h2>
        <Card>
          <div className="flex flex-col gap-2 px-3 py-3">
            <span className="flex flex-col gap-px text-[15px] font-semibold">
              Appearance<span className="text-[12px] font-normal text-muted">Saved on this device</span>
            </span>
            <div
              role="radiogroup"
              aria-label="Appearance"
              className="grid grid-cols-3 gap-1 rounded-[10px] bg-sunken p-[3px]"
            >
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={pref === t.id}
                  data-track={`settings.theme.${t.id}`}
                  onClick={() => setTheme(t.id)}
                  className={cx(
                    'hit h-9 rounded-lg text-[14px] font-bold text-ink',
                    pref === t.id ? 'bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.08)]' : 'bg-transparent',
                  )}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        </Card>
        <Preferences />
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const pref = useThemePref();
  return (
    <Page title="Appearance" back="/settings">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={pref === t.id}
            data-track={`settings.theme.${t.id}`}
            onClick={() => setTheme(t.id)}
            className={cx(
              'flex flex-col gap-2 rounded-xl border-2 bg-surface p-3 text-left',
              pref === t.id ? 'border-accent' : 'border-line',
            )}
          >
            <span aria-hidden="true" className="flex h-14 overflow-hidden rounded-lg border border-line">
              <span className="flex-1" style={{ background: t.id === 'dark' ? '#181B21' : '#FFFFFF' }} />
              <span
                className="flex-1"
                style={{ background: t.id === 'light' ? '#F5F6F8' : t.id === 'dark' ? '#0E1014' : '#181B21' }}
              />
            </span>
            <span className="text-[14px] font-bold">{t.name}</span>
            <span className="text-[12px] text-muted">{t.desc}</span>
          </button>
        ))}
      </div>
      <p className="m-0 text-[13px] text-muted">
        Saved on this device. Every screen follows it, on phone and desktop.
      </p>
      <h2 className="m-0 mt-2 text-[15px] font-bold">Preferences</h2>
      <Preferences />
    </Page>
  );
}

// ------------------------------------------------------------------ categories

export function CategoriesScreen() {
  useScreen('settings.categories');
  const q = useCategoriesSettings();
  const archive = useMoneyMutation(
    (v: { id: string; archived: boolean }) => api.archiveCategory(v.id, v.archived),
    { invalidate: [qk.categories] },
  );
  const [editing, setEditing] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const v = q.data;
  const doArchive = async (id: string, name: string, archived: boolean) => {
    try {
      await archive.mutateAsync({ id, archived });
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
      return;
    }
    toast.show({
      text: `${name} ${archived ? 'archived' : 'restored'}`,
      undo: async () => {
        await archive.mutateAsync({ id, archived: !archived });
        usage.undo(archived ? 'archive' : 'restore');
      },
    });
  };
  return (
    <Page
      title="Categories"
      back="/settings"
      right={
        <button
          type="button"
          data-track="categories.edit"
          onClick={() => setEditing(!editing)}
          className="hit h-9 px-2 text-[15px] font-bold text-accent"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      }
    >
      <p className="m-0 text-[13px] leading-snug text-muted">
        You make all categories. The only ones the app makes are card payments, one per card. Money you front
        for others isn’t a category: it’s tracked on the Owed to you list.
      </p>
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v?.groups.map((g) => (
        <section key={g.id} className="flex shrink-0 flex-col gap-1.5">
          <div className="flex min-h-9 items-center justify-between px-0.5">
            <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">{g.name}</h2>
            <span className="text-[12px] text-muted">
              {g.system ? 'made by the app' : g.categories.length}
            </span>
          </div>
          <Card>
            {g.categories.map((c) => (
              <div
                key={c.id}
                className="flex min-h-14 items-center gap-2 border-t border-divider px-3 first:border-t-0"
              >
                {editing && !g.system && (
                  <span aria-hidden="true" className="text-faint">
                    ⋮⋮
                  </span>
                )}
                {g.system ? (
                  <span className="flex flex-1 flex-col gap-0.5 py-2">
                    <span className="text-[15px] font-semibold">{c.name}</span>
                    <span className="text-[12px] text-muted">{c.meta}</span>
                  </span>
                ) : (
                  <Link
                    to={`/settings/categories/${c.id}`}
                    data-track="categories.open"
                    className="flex flex-1 flex-col gap-0.5 py-2 text-ink no-underline"
                  >
                    <span className="text-[15px] font-semibold">{c.name}</span>
                    <span className="text-[12px] text-muted">{c.meta}</span>
                  </Link>
                )}
                {editing && !g.system && (
                  <Button
                    mutates
                    track="categories.archive"
                    aria-label={`Archive ${c.name}`}
                    onClick={() => void doArchive(c.id, c.name, true)}
                    className="hit h-9 shrink-0 rounded-full border border-line-strong px-3 text-[13px] font-bold text-ink-2"
                  >
                    Archive
                  </Button>
                )}
              </div>
            ))}
          </Card>
        </section>
      ))}
      {v && editing && (
        <div className="flex gap-2">
          <Link
            to="/settings/categories/new"
            data-track="categories.add"
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-dashed border-accent text-[14px] font-bold text-accent no-underline"
          >
            + Category
          </Link>
          <Link
            to="/settings/categories/new-group"
            data-track="categories.add_group"
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-dashed border-accent text-[14px] font-bold text-accent no-underline"
          >
            + Group
          </Link>
        </div>
      )}
      {v && v.archived.length > 0 && (
        <>
          <button
            type="button"
            data-track="categories.show_archived"
            onClick={() => setShowArchived(!showArchived)}
            className="min-h-9 self-start text-[14px] font-bold text-accent"
          >
            {showArchived ? 'Hide archived' : `Show archived (${v.archived.length})`}
          </button>
          {showArchived && (
            <Card>
              {v.archived.map((a) => (
                <div
                  key={a.id}
                  className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 first:border-t-0"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{a.name}</span>
                    <span className="text-[12px] text-muted">{a.meta}</span>
                  </span>
                  <Button
                    mutates
                    track="categories.restore"
                    onClick={() => void doArchive(a.id, a.name, false)}
                    className="hit h-9 rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent"
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        Archived categories keep their history in reports. Archiving one that still has money moves the money
        to Ready to Assign first.
      </p>
      <Outlet />
    </Page>
  );
}

export function CategoryEditSheet() {
  const { categoryId } = useParams({ strict: false }) as { categoryId: string };
  const isGroup = categoryId === 'new-group';
  const isNew = categoryId === 'new' || isGroup;
  useScreen(isGroup ? 'settings.group.new' : isNew ? 'settings.category.new' : 'settings.category.edit');
  const q = useCategoriesSettings();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const close = () => void navigate({ to: '/settings/categories' });
  const existing = q.data?.groups
    .flatMap((g) => g.categories.map((c) => ({ ...c, groupId: g.id })))
    .find((c) => c.id === categoryId);
  const groups = (q.data?.groups ?? []).filter((g) => !g.system);
  const [name, setName] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [kind, setKind] = useState<'spending' | 'saving' | null>(null);
  const [isBills, setIsBills] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canWrite = useCanWrite();
  const n = name ?? existing?.name ?? '';
  const g = groupId ?? existing?.groupId ?? groups[0]?.id ?? '';
  const k = kind ?? (existing?.kind === 'saving' ? 'saving' : 'spending');
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isGroup) await api.upsertGroup({ name: n.trim(), isBills });
      else
        await api.upsertCategory({
          id: isNew ? undefined : categoryId,
          name: n.trim(),
          groupId: g || null,
          kind: k,
        });
      await qc.invalidateQueries({ queryKey: qk.categories });
      void qc.invalidateQueries({ queryKey: ['budget'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!existing) return;
    await api.archiveCategory(existing.id, true);
    await qc.invalidateQueries({ queryKey: qk.categories });
    void qc.invalidateQueries({ queryKey: ['budget'] });
    toast.show({
      text: `${existing.name} archived`,
      undo: async () => {
        await api.archiveCategory(existing.id, false);
        usage.undo('archive');
        void qc.invalidateQueries({ queryKey: qk.categories });
        void qc.invalidateQueries({ queryKey: ['budget'] });
      },
    });
    close();
  };
  const title = isGroup ? 'New group' : isNew ? 'New category' : 'Edit category';
  return (
    <Sheet
      label={title}
      track="category_edit"
      onClose={close}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">{title}</h1>}
    >
      <div className="flex flex-col gap-3.5 pb-4">
        <Field label="Name">
          <input
            className={inputClass}
            value={n}
            maxLength={60}
            placeholder={isGroup ? 'e.g. Kids' : 'e.g. Climbing'}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {isGroup ? (
          <Toggle
            label="Bills group"
            help="Bills are never shown as Low"
            checked={isBills}
            onChange={setIsBills}
          />
        ) : (
          <>
            <Field label="Group">
              <select className={inputClass} value={g} onChange={(e) => setGroupId(e.target.value)}>
                {groups.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-semibold text-ink-2">
                In reports, money out of it counts as
              </span>
              <Segmented
                label="Counts as"
                value={k}
                onChange={setKind}
                options={[
                  ['spending', 'Spending'],
                  ['saving', 'Saving or investing'],
                ]}
              />
              <span className="text-[12px] leading-snug text-muted">
                {k === 'saving'
                  ? 'Use for money leaving your budget to grow somewhere else, like a brokerage or an IRA. Shown as Invested, not Spent.'
                  : 'Most categories. Sinking funds like Vacation or Car insurance are Spending too: the money is spent when you use it.'}
              </span>
            </div>
            {!isNew && existing && (
              <Link
                to={`/budget/category/${existing.id}/target`}
                data-track="category_edit.target"
                className="flex min-h-14 items-center justify-between rounded-xl border border-line px-3 text-ink no-underline"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-[15px] font-semibold">Target</span>
                  <span className="text-[12px] text-muted">{existing.meta}</span>
                </span>
                <Icon name="chevR" size={18} className="text-faint" />
              </Link>
            )}
            {!isNew && existing && (
              <div className="flex flex-col gap-1">
                <Button
                  mutates
                  track="category_edit.archive"
                  onClick={() => void archive()}
                  className="min-h-9 self-start text-[14px] font-bold text-over-fg"
                >
                  Archive {existing.name}
                </Button>
                <span className="text-[12px] leading-snug text-muted">
                  Its {formatCents(existing.available)} goes back to Ready to Assign. Past transactions keep
                  the category, and reports still show it.
                </span>
              </div>
            )}
          </>
        )}
        {error ? <ErrorNote error={error} /> : null}
        <PrimaryButton
          mutates
          track="category_edit.save"
          disabled={!n.trim() || busy || !canWrite}
          onClick={() => void save()}
        >
          {isNew ? (isGroup ? 'Add group' : 'Add category') : 'Save'}
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ rules

export function RulesScreen() {
  useScreen('settings.rules');
  const q = useRules();
  const v = q.data;
  return (
    <Page
      title="Rules"
      back="/settings"
      right={
        <Link
          to="/settings/rules/new"
          data-track="rules.new"
          className="hit flex h-9 items-center px-2 text-[15px] font-bold text-accent no-underline"
        >
          + New rule
        </Link>
      }
    >
      <p className="m-0 text-[13px] leading-snug text-muted">
        Rules run top to bottom on each new transaction; the first match wins. They never change a category
        you set yourself.
      </p>
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <Card>
          {v.rules.map((r, i) => {
            const [when, then] = r.summary.includes(' → ') ? r.summary.split(' → ') : [r.summary, ''];
            return (
              <Link
                key={r.id}
                to={`/settings/rules/${r.id}`}
                data-track="rules.open"
                className="flex min-h-14 items-center gap-3 border-t border-divider px-3 py-2 text-ink no-underline first:border-t-0"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[12px] font-bold text-ink-2"
                >
                  {i + 1}
                </span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-semibold">{when}</span>
                  {then && <span className="text-[13px] text-ink-2">→ {then}</span>}
                  <span className="text-[12px] text-muted">
                    {r.enabled
                      ? `Used ${r.matches90d} ${r.matches90d === 1 ? 'time' : 'times'} in 90 days`
                      : 'Turned off'}
                  </span>
                </span>
                <Icon name="chevR" size={18} className="text-faint" />
              </Link>
            );
          })}
        </Card>
      )}
      <span className="text-[12px] text-muted">
        To make a rule quickly, categorize a payee the same way twice; Activity will offer “Always”.
      </span>
    </Page>
  );
}

type CondField = 'payee' | 'description' | 'amount';
interface Cond {
  id: number;
  field: CondField;
  value: string;
  min: string;
  max: string;
}
type OwedOpt = 'none' | 'half' | 'all' | 'fixed';

function condsFromRule(r: RuleBody): Cond[] {
  let id = 0;
  const out: Cond[] = [];
  for (const c of r.conditions.all) {
    id += 1;
    if (c.field === 'payee' || c.field === 'description')
      out.push({ id, field: c.field, value: c.value, min: '', max: '' });
    else if (c.field === 'amount' && c.op === 'between')
      out.push({
        id,
        field: 'amount',
        value: '',
        min: centsToInput(Math.abs(c.max)),
        max: centsToInput(Math.abs(c.min)),
      });
  }
  const anyPayees = (r.conditions.any ?? []).flat().filter((c) => c.field === 'payee');
  if (anyPayees.length)
    out.unshift({
      id: 99,
      field: 'payee',
      value: anyPayees.map((c) => ('value' in c ? String(c.value) : '')).join(' or '),
      min: '',
      max: '',
    });
  return out.length ? out : [{ id: 1, field: 'payee', value: '', min: '', max: '' }];
}

export function RuleEditScreen() {
  const { ruleId } = useParams({ strict: false }) as { ruleId: string };
  const isNew = ruleId === 'new';
  useScreen(isNew ? 'settings.rule.new' : 'settings.rule.edit');
  const q = useRules();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { groups } = useCategoryOptions();
  const back = () => void navigate({ to: '/settings/rules' });
  const rule = q.data?.rules.find((r) => r.id === ruleId);
  const idx = q.data?.rules.findIndex((r) => r.id === ruleId) ?? -1;
  const [conds, setConds] = useState<Cond[] | null>(null);
  const [cat, setCat] = useState<string | null>(null);
  const [owed, setOwed] = useState<OwedOpt>('none');
  const [owedFixed, setOwedFixed] = useState('');
  const [prev, setPrev] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{
    n: number;
    rows: { key: string; date: string; payee: string; amount: number; meta: string }[];
    uncategorized: number;
  } | null>(null);
  const canWrite = useCanWrite();

  useEffect(() => {
    if (conds || (!isNew && !rule)) return;
    if (!rule) {
      setConds([{ id: 1, field: 'payee', value: '', min: '', max: '' }]);
      return;
    }
    setConds(condsFromRule(rule));
    const sc = rule.actions.find((a) => a.type === 'set_category');
    setCat(sc && sc.type === 'set_category' ? sc.categoryId : '');
    const mo = rule.actions.find((a) => a.type === 'mark_owed');
    if (mo && mo.type === 'mark_owed') {
      if (mo.fixed) {
        setOwed('fixed');
        setOwedFixed(centsToInput(mo.fixed));
      } else setOwed(mo.num === mo.den ? 'all' : 'half');
    }
    setPrev(rule.actions.some((a) => a.type === 'previous_month_if_within_days'));
  }, [rule, isNew, conds]);

  const body = useMemo<RuleBody | null>(() => {
    if (!conds) return null;
    const all: RuleBody['conditions']['all'] = [];
    const any: RuleBody['conditions']['all'][] = [];
    for (const c of conds) {
      if (c.field === 'payee' && c.value.trim()) {
        const names = c.value
          .split(/\s+or\s+/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (names.length > 1)
          any.push(...names.map((n) => [{ field: 'payee' as const, op: 'is' as const, value: n }]));
        else all.push({ field: 'payee', op: 'is', value: names[0]! });
      } else if (c.field === 'description' && c.value.trim())
        all.push({ field: 'description', op: 'contains', value: c.value.trim() });
      else if (c.field === 'amount') {
        const lo = parseCents(c.min);
        const hi = parseCents(c.max);
        if (lo !== null && hi !== null) all.push({ field: 'amount', op: 'between', min: -hi, max: -lo });
      }
    }
    if (all.length === 0 && any.length === 0) return null;
    const actions: RuleBody['actions'] = [];
    if (cat) actions.push({ type: 'set_category', categoryId: cat });
    if (owed === 'half') actions.push({ type: 'mark_owed', num: 1, den: 2 });
    if (owed === 'all') actions.push({ type: 'mark_owed', num: 1, den: 1 });
    const fixed = parseCents(owedFixed);
    if (owed === 'fixed' && fixed) actions.push({ type: 'mark_owed', fixed });
    if (prev) actions.push({ type: 'previous_month_if_within_days', days: 5 });
    if (actions.length === 0) actions.push({ type: 'flag_review' });
    const nameFrom = conds.find((c) => c.value.trim())?.value.trim() ?? 'Rule';
    return {
      id: isNew ? undefined : ruleId,
      name: rule?.name ?? nameFrom.slice(0, 80),
      conditions: any.length ? { all, any } : { all },
      actions,
      applyToPending: rule?.applyToPending ?? true,
      stopAfter: rule?.stopAfter ?? true,
      enabled: rule?.enabled ?? true,
    };
  }, [conds, cat, owed, owedFixed, prev, isNew, ruleId, rule]);

  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    if (!body) {
      setPreview(null);
      return;
    }
    const id = setTimeout(() => {
      api
        .previewRule(body)
        .then((p) =>
          setPreview({
            n: p.matches.length,
            uncategorized: p.uncategorizedMatches,
            rows: p.matches
              .slice(0, 5)
              .map((m) => ({ key: m.key, date: m.date, payee: m.payee, amount: m.amount, meta: rowMeta(m) })),
          }),
        )
        .catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(id);
    // bodyKey captures every field of body
  }, [bodyKey]);

  if (!conds)
    return (
      <Page title="Rule" back="/settings/rules">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Page>
    );
  const upd = (id: number, p: Partial<Cond>) =>
    setConds(conds.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const save = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveRule(body);
      await qc.invalidateQueries({ queryKey: qk.rules });
      back();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api.deleteRule(ruleId);
    await qc.invalidateQueries({ queryKey: qk.rules });
    back();
  };
  const title = isNew ? 'New rule' : `Rule ${idx + 1} · ${rule?.name ?? ''}`;
  return (
    <Page title={title} back="/settings/rules">
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[13px] font-bold text-ink-2">When all of these match</h2>
        {conds.map((c, i) => (
          <div key={c.id} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)_32px] items-center gap-2">
            <select
              aria-label={`Field for condition ${i + 1}`}
              className={cx(inputClass, 'px-2 text-[14px]')}
              value={c.field}
              onChange={(e) => upd(c.id, { field: e.target.value as CondField })}
            >
              <option value="payee">Payee is</option>
              <option value="description">Description contains</option>
              <option value="amount">Amount between</option>
            </select>
            {c.field === 'amount' ? (
              <span className="flex min-w-0 items-center gap-1">
                <input
                  aria-label={`Lowest amount for condition ${i + 1}`}
                  inputMode="decimal"
                  className={cx(inputClass, 'tnum')}
                  placeholder="0.00"
                  value={c.min}
                  onChange={(e) => upd(c.id, { min: e.target.value })}
                />
                <span className="text-muted">–</span>
                <input
                  aria-label={`Highest amount for condition ${i + 1}`}
                  inputMode="decimal"
                  className={cx(inputClass, 'tnum')}
                  placeholder="0.00"
                  value={c.max}
                  onChange={(e) => upd(c.id, { max: e.target.value })}
                />
              </span>
            ) : (
              <input
                aria-label={`Value for condition ${i + 1}`}
                className={cx(inputClass, 'min-w-0')}
                value={c.value}
                onChange={(e) => upd(c.id, { value: e.target.value })}
              />
            )}
            {conds.length > 1 ? (
              <button
                type="button"
                aria-label={`Remove condition ${i + 1}`}
                onClick={() => setConds(conds.filter((x) => x.id !== c.id))}
                className="hit h-11 w-8 text-[20px] text-muted"
              >
                ×
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
        <button
          type="button"
          data-track="rule.add_condition"
          onClick={() =>
            setConds([
              ...conds,
              {
                id: Math.max(0, ...conds.map((c) => c.id)) + 1,
                field: 'description',
                value: '',
                min: '',
                max: '',
              },
            ])
          }
          className="hit h-9 self-start text-[14px] font-bold text-accent"
        >
          + Add condition
        </button>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-[13px] font-bold text-ink-2">Then</h2>
        <Field label="Category">
          <select className={inputClass} value={cat ?? ''} onChange={(e) => setCat(e.target.value)}>
            <option value="">Don’t set a category</option>
            {groups.map((g) => (
              <optgroup key={g.id} label={g.name}>
                {g.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Card className="flex flex-col gap-2 p-3">
          <span className="flex flex-col gap-px text-[15px] font-semibold">
            Owed to you
            <span className="text-[12px] font-normal text-muted">
              {owed === 'none'
                ? 'Nothing owed'
                : owed === 'half'
                  ? 'Half of each payment'
                  : owed === 'all'
                    ? 'All of it'
                    : `${owedFixed ? formatCents(parseCents(owedFixed) ?? 0) : 'A set amount'} of each payment`}
            </span>
          </span>
          <Segmented
            label="Owed to you"
            value={owed}
            onChange={setOwed}
            options={[
              ['none', 'None'],
              ['half', 'Half'],
              ['all', 'All'],
              ['fixed', 'Amount'],
            ]}
          />
          {owed === 'fixed' && (
            <input
              aria-label="Amount owed"
              inputMode="decimal"
              className={cx(inputClass, 'tnum')}
              placeholder="0.00"
              value={owedFixed}
              onChange={(e) => setOwedFixed(e.target.value)}
            />
          )}
        </Card>
        <Card>
          <Toggle
            label="Count in the previous month"
            help="If it posts on day 1–5 of a month"
            checked={prev}
            onChange={setPrev}
          />
        </Card>
      </section>
      <section className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[13px] font-bold text-ink-2">
          Matches in the last 90 days · {preview ? preview.n : '…'}
        </h2>
        {preview && preview.rows.length > 0 && (
          <Card>
            {preview.rows.map((m) => (
              <div
                key={m.key}
                className="flex items-center justify-between gap-2 border-t border-divider px-3 py-2 text-[14px] first:border-t-0"
              >
                <span className="flex flex-col">
                  <span className="font-semibold">
                    {dayLabel(m.date)} · {m.payee}
                  </span>
                  <span className="text-[12px] text-muted">{m.meta}</span>
                </span>
                <span className="tnum font-bold">{formatCents(m.amount)}</span>
              </div>
            ))}
          </Card>
        )}
        <span className="text-[12px] text-muted">
          Already-categorized matches keep their category. Changes apply to new transactions.
          {preview && preview.uncategorized > 0
            ? ` ${preview.uncategorized} uncategorized ${preview.uncategorized === 1 ? 'match' : 'matches'} can be categorized after saving.`
            : ''}
        </span>
        {!isNew && preview && preview.uncategorized > 0 && (
          <SecondaryButton
            mutates
            track="rule.apply"
            onClick={async () => {
              await api.applyRule(ruleId);
              void qc.invalidateQueries({ queryKey: ['activity'] });
              void qc.invalidateQueries({ queryKey: ['budget'] });
              toast.show({ text: 'Rule applied to uncategorized transactions' });
            }}
          >
            Apply to {preview.uncategorized} uncategorized
          </SecondaryButton>
        )}
      </section>
      {!isNew &&
        (asking ? (
          <div
            role="alertdialog"
            aria-label="Delete rule"
            className="flex flex-col gap-2.5 rounded-xl bg-over-bg p-3 text-over-fg"
          >
            <span className="text-[14px] leading-snug">
              Delete this rule? Transactions it already categorized keep their categories; new ones from this
              payee will need a category.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAsking(false)}
                className="h-11 flex-1 rounded-[10px] border border-line-strong bg-surface text-[14px] font-bold text-ink-2"
              >
                Keep it
              </button>
              <Button
                mutates
                track="rule.delete.confirm"
                onClick={() => void remove()}
                className="h-11 flex-1 rounded-[10px] bg-danger text-[14px] font-bold text-on-danger"
              >
                Delete rule
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-track="rule.delete"
            onClick={() => setAsking(true)}
            className="min-h-9 self-start text-[14px] font-bold text-over-fg"
          >
            Delete rule
          </button>
        ))}
      {error ? <ErrorNote error={error} /> : null}
      <PrimaryButton
        mutates
        track="rule.save"
        disabled={!body || busy || !canWrite}
        onClick={() => void save()}
      >
        Save rule
      </PrimaryButton>
    </Page>
  );
}

// ------------------------------------------------------------------ payees

export function PayeesScreen() {
  useScreen('settings.payees');
  const q = usePayees();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [merged, setMerged] = useState<string | null>(null);
  const v = q.data;
  const list = (v?.payees ?? []).filter(
    (p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Page title="Payees" back="/settings">
      <label className="flex min-h-11 items-center gap-2 rounded-xl bg-sunken px-3 text-muted">
        <Icon name="search" size={18} />
        <input
          aria-label="Search payees"
          placeholder="Search payees"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="min-h-10 flex-1 border-none bg-transparent text-[16px] text-ink outline-none"
        />
      </label>
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v?.suggestions
        .filter((s) => !kept[s.name])
        .map((s) => (
          <section
            key={s.name}
            className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-accent bg-accent-soft p-3"
          >
            <span className="text-[12px] font-bold uppercase tracking-[0.4px] text-accent">
              Looks like the same payee
            </span>
            <div className="flex flex-wrap gap-1.5">
              {s.rawNames.map((r) => (
                <span key={r} className="rounded-md bg-surface px-2 py-1 font-mono text-[12px] text-ink-2">
                  {r}
                </span>
              ))}
            </div>
            <span className="text-[13px] text-ink-2">
              Merge into <strong>{s.name}</strong>? Rules and past transactions follow.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-track="payees.keep_separate"
                onClick={() => setKept({ ...kept, [s.name]: true })}
                className="hit h-9 flex-1 rounded-full border border-line-strong bg-surface text-[13px] font-bold text-ink-2"
              >
                Keep separate
              </button>
              <Button
                mutates
                track="payees.merge"
                onClick={async () => {
                  await api.mergePayees({ ids: s.payeeIds, name: s.name });
                  usage.suggestion('payee_merge', 'merged');
                  setMerged(s.name);
                  void qc.invalidateQueries({ queryKey: qk.payees });
                }}
                className="hit h-9 flex-1 rounded-full bg-accent text-[13px] font-bold text-on-accent"
              >
                Merge {s.rawNames.length}
              </Button>
            </div>
          </section>
        ))}
      {merged && (
        <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[14px] text-funded-fg">
          Merged into {merged}
        </p>
      )}
      {v && (
        <Card>
          {list.map((p) => (
            <div
              key={p.id}
              className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 first:border-t-0"
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-semibold">{p.name}</span>
                <span className="text-[12px] text-muted">
                  {p.transactions} {p.transactions === 1 ? 'transaction' : 'transactions'}
                  {p.defaultCategory ? ` · usually ${p.defaultCategory}` : ''}
                </span>
              </span>
              <Link
                to={`/settings/payees/${p.id}`}
                data-track="payees.rename"
                aria-label={`Rename ${p.name}`}
                className="hit flex h-9 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
              >
                Rename
              </Link>
            </div>
          ))}
        </Card>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        Renames and merges only change how payees are shown and matched. The bank’s original description is
        always kept on each transaction.
      </p>
      <Outlet />
    </Page>
  );
}

export function RenamePayeeSheet() {
  const { payeeId } = useParams({ strict: false }) as { payeeId: string };
  useScreen('settings.payee.rename');
  const q = usePayees();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const close = () => void navigate({ to: '/settings/payees' });
  const p = q.data?.payees.find((x) => x.id === payeeId);
  const [name, setName] = useState<string | null>(null);
  const [into, setInto] = useState('');
  const [error, setError] = useState<unknown>(null);
  const raw = q.data?.suggestions.find((s) => s.payeeIds.includes(payeeId))?.rawNames ?? [];
  if (!p)
    return (
      <Sheet label="Rename payee" track="payee.rename" onClose={close} gap="auto">
        {q.error ? <ErrorNote error={q.error} /> : <Loading />}
      </Sheet>
    );
  const value = name ?? p.name;
  const save = async () => {
    setError(null);
    try {
      if (into) {
        const target = q.data!.payees.find((x) => x.id === into)!;
        await api.mergePayees({ ids: [into, p.id], name: target.name });
      } else await api.renamePayee(p.id, { name: value.trim(), remember: p.remember });
      await qc.invalidateQueries({ queryKey: qk.payees });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      close();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Sheet
      label="Rename payee"
      track="payee.rename"
      onClose={close}
      gap="auto"
      header={<h1 className="m-0 text-[20px] font-bold">Rename payee</h1>}
    >
      <div className="flex flex-col gap-3 pb-4">
        <Field label="Show as">
          <input
            className={inputClass}
            value={value}
            disabled={!!into}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {raw.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Bank names that become this payee</Label>
            <Card>
              {raw.map((r) => (
                <div
                  key={r}
                  className="border-t border-divider px-3 py-2.5 font-mono text-[13px] first:border-t-0"
                >
                  {r}
                </div>
              ))}
            </Card>
          </div>
        )}
        <Field label="Or merge into an existing payee">
          <select className={inputClass} value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Don’t merge</option>
            {q
              .data!.payees.filter((x) => x.id !== p.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </Field>
        <p className="m-0 text-[12px] leading-snug text-muted">
          Applies to past and future transactions. Rules follow the new name. The bank’s description stays on
          each transaction.
        </p>
        {error ? <ErrorNote error={error} /> : null}
        <PrimaryButton mutates track="payee.rename.save" disabled={!value.trim()} onClick={() => void save()}>
          Save
        </PrimaryButton>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ connections

export function LinkMeter({ used, limit }: { used: number; limit: number }) {
  const left = Math.max(0, limit - used);
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-bold" data-testid="link-meter">
          {used} of {limit} links used
        </span>
        <span className="text-[13px] text-muted">{left} left, for good</span>
      </div>
      <div aria-hidden="true" className="flex gap-1">
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={cx('h-2 flex-1 rounded-sm', i < used ? 'bg-accent' : 'bg-track')} />
        ))}
      </div>
      <span className="text-[12px] leading-snug text-muted">
        The free Plaid plan allows {limit} bank logins ever. Removing one doesn’t give it back, so repair a
        broken login instead of re-adding it.
      </span>
    </section>
  );
}

/** "Link a bank" with a confirm step first, since each link uses one of the 10 for good. */
export function LinkBankFlow({ onLinked, label }: { onLinked?: () => void; label?: string }) {
  const conns = useConnections();
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'confirm' | 'linking' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const canWrite = useCanWrite();
  const v = conns.data;
  if (!v) return null;
  const left = v.limit - v.used;
  const start = async () => {
    setStep('linking');
    setError(null);
    try {
      const r = await runPlaidLink('new');
      if (r.status === 'exited') return setStep('idle');
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.connections }),
        qc.invalidateQueries({ queryKey: qk.accounts }),
      ]);
      usage.record('task', 'link_bank');
      setStep('done');
      onLinked?.();
    } catch (e) {
      setError(e);
      setStep('confirm');
    }
  };
  if (left <= 0)
    return (
      <p className="m-0 rounded-xl bg-under-bg p-3 text-[13px] text-under-fg">
        All {v.limit} links are used. Import a CSV from Import and export instead.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      {step === 'confirm' || step === 'linking' ? (
        <div
          role="alertdialog"
          aria-label="Use a link"
          className="flex flex-col gap-2.5 rounded-[14px] border border-accent bg-accent-soft p-3"
        >
          <span className="text-[15px] font-bold">Use 1 of your {left} remaining links?</span>
          <span className="text-[13px] leading-snug text-ink-2">
            After this, {v.used + 1} of {v.limit} links are used, for good. If a bank you already linked
            stopped syncing, repair it from Accounts instead. Linking opens Plaid’s secure window; Ledgerline
            never sees your bank password.
          </span>
          <div className="flex gap-2">
            <SecondaryButton className="flex-1" onClick={() => setStep('idle')} disabled={step === 'linking'}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              mutates
              track="connections.link.confirm"
              className="flex-[2]"
              disabled={step === 'linking' || !canWrite}
              onClick={() => void start()}
            >
              {step === 'linking' ? 'Opening Plaid…' : 'Link a bank'}
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <Button
          mutates
          track="connections.link"
          onClick={() => setStep('confirm')}
          className="flex h-12 w-full items-center justify-center rounded-xl border border-dashed border-accent text-[15px] font-bold text-accent disabled:border-line disabled:text-disabled"
        >
          {label ?? `+ Link another bank (uses 1 of ${left})`}
        </Button>
      )}
      {step === 'done' && (
        <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[13px] text-funded-fg">
          Linked. Transactions will show up in Activity after the first sync, usually within a few minutes.
        </p>
      )}
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

export function ConnectionsScreen() {
  useScreen('settings.connections');
  const q = useConnections();
  const session = useSession();
  const accounts = useAccounts();
  const v = q.data;
  const today = session.data?.budget.today ?? '';
  const status = (s: string) =>
    s === 'ok'
      ? { text: 'Synced', cls: 'bg-funded-bg text-funded-fg' }
      : s === 'login_required'
        ? { text: 'Sign in again', cls: 'bg-under-bg text-under-fg' }
        : s === 'error'
          ? { text: 'Sync failed', cls: 'bg-over-bg text-over-fg' }
          : { text: 'Still counts', cls: 'bg-none-bg text-none-fg' };
  return (
    <Page title="Bank connections" back="/settings">
      {!v && (q.error ? <ErrorNote error={q.error} /> : <Loading />)}
      {v && (
        <>
          <LinkMeter used={v.used} limit={v.limit} />
          <Card>
            {v.items.map((it) => {
              const st = status(it.status);
              const repair = accounts.data?.repairs.find((r) => r.connectionId === it.id);
              return (
                <div
                  key={it.id}
                  className="flex flex-col gap-2 border-t border-divider px-3 py-2.5 first:border-t-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex flex-col gap-0.5">
                      <span
                        className={cx('text-[15px] font-semibold', it.status === 'removed' && 'text-muted')}
                      >
                        {it.institution}
                        {it.status === 'removed' ? ' (removed)' : ''}
                      </span>
                      <span className="text-[12px] text-muted">
                        {it.accounts} · linked {syncedLabel(it.linkedAt, '')}
                      </span>
                    </span>
                    <span className={cx('shrink-0 rounded-full px-2.5 py-1 text-[12px] font-bold', st.cls)}>
                      {it.status === 'ok' && it.lastSynced
                        ? `Synced ${syncedLabel(it.lastSynced, today)}`
                        : st.text}
                    </span>
                  </div>
                  {repair && (
                    <Link
                      to={`/accounts/repair/${it.id}`}
                      data-track="connections.repair"
                      className="hit flex h-9 items-center self-start rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
                    >
                      Repair on Accounts
                    </Link>
                  )}
                </div>
              );
            })}
          </Card>
          <LinkBankFlow />
          {v.environment === 'sandbox' && (
            <p className="m-0 text-[12px] text-muted">Plaid Sandbox: test banks only.</p>
          )}
        </>
      )}
    </Page>
  );
}

// ------------------------------------------------------------------ import and export

export function DataScreen() {
  useScreen('settings.data');
  const accounts = useAccounts();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = useCanWrite();
  const accts = (accounts.data?.groups ?? []).flatMap((g) => g.accounts);
  const acct = accountId || accts[0]?.id || '';
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    setFile({
      name: f.name,
      text,
      rows: Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1),
    });
    setResult(null);
  };
  const doImport = async () => {
    if (!file || !acct) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.importCsv({ accountId: acct, csv: file.text });
      setResult(
        `Imported ${r.imported.toLocaleString('en-US')} transactions as history. ${r.skipped.toLocaleString('en-US')} overlap your linked accounts and were skipped. Payee names were added to Payees.`,
      );
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['reports'] });
      void qc.invalidateQueries({ queryKey: qk.payees });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const exportsList: [string, string, string][] = [
    ['Transactions (CSV)', 'Every transaction with category, memo and owed amounts', exportUrls.csv],
    ['Everything (JSON)', 'Full export, including rules and payee merges', exportUrls.json],
    ['Rules (JSON)', 'Your rules, in order', exportUrls.rules],
    ['Usage and notes (JSON)', 'How you use the app, for reviewing what to change', exportUrls.usage],
  ];
  return (
    <Page title="Import and export" back="/settings">
      <section className="flex shrink-0 flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3">
        <span className="text-[15px] font-bold">Import past transactions</span>
        {!file ? (
          <>
            <span className="text-[13px] leading-snug text-muted">
              Upload a CSV export from your old budgeting app or bank. Its transactions become history:
              searchable and in reports, never in a budget month.
            </span>
            <label
              className={cx(
                'hit flex h-11 cursor-pointer items-center justify-center self-start rounded-full px-4 text-[14px] font-bold',
                canWrite ? 'bg-accent-soft text-accent' : 'bg-sunken text-disabled',
              )}
            >
              Choose file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={!canWrite}
                data-track="data.import.choose"
                onChange={(e) => void pick(e.target.files?.[0])}
              />
            </label>
          </>
        ) : (
          <>
            <span className="font-mono text-[13px]">{file.name}</span>
            <div className="flex justify-between text-[14px]">
              <span className="text-muted">Rows</span>
              <span className="tnum font-bold">{file.rows.toLocaleString('en-US')}</span>
            </div>
            <Field label="Account it came from">
              <select className={inputClass} value={acct} onChange={(e) => setAccountId(e.target.value)}>
                {accts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex gap-2">
              <SecondaryButton className="h-10 flex-1" onClick={() => setFile(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton
                mutates
                track="data.import"
                className="h-10 flex-[2]"
                disabled={busy}
                onClick={() => void doImport()}
              >
                Import {file.rows.toLocaleString('en-US')}
              </PrimaryButton>
            </div>
          </>
        )}
        {result && (
          <p role="status" className="m-0 rounded-xl bg-success-soft p-3 text-[13px] text-funded-fg">
            {result}
          </p>
        )}
        {error ? <ErrorNote error={error} /> : null}
      </section>
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Export</h2>
      <Card>
        {exportsList.map(([name, meta, href]) => (
          <div
            key={name}
            className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2 first:border-t-0"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{name}</span>
              <span className="text-[12px] text-muted">{meta}</span>
            </span>
            <a
              href={href}
              download
              data-track="data.export"
              aria-label={`Download ${name}`}
              className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
            >
              Download
            </a>
          </div>
        ))}
      </Card>
      <h2 className="m-0 mt-1 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">Backups</h2>
      <Card>
        <div className="flex min-h-14 items-center justify-between gap-2 px-3 py-2">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Nightly backup</span>
            <span className="text-[12px] text-muted">Encrypted copy kept for 90 days</span>
          </span>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-2 border-t border-divider px-3 py-2">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold">Undo window</span>
            <span className="text-[12px] text-muted">The database can be rewound to any minute</span>
          </span>
          <span className="text-[13px] text-ink-2">Last 7 days</span>
        </div>
      </Card>
      <span className="text-[12px] text-muted">
        Restores are done from the repository, not from this screen, so a stolen session can’t wipe your data.
      </span>
    </Page>
  );
}
