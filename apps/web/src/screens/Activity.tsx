// Activity: search, All / Needs attention / Not posted yet. Needs attention groups: Money to match, Transfers
// to sort out, Needs category (with Select several and the category picker), Check these. Under All the same
// groups sit on top, then Pending, Upcoming and Posted. Categorizing shows an Undo toast and, when every past
// transaction from the payee used the same category, offers "Always" (a rule).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { ActivityView, TxnListRow } from '@ledgerline/contracts';
import { api, type ActivityFilter } from '../api/endpoints';
import { adjustAttention, qk, useActivity, useMoneyMutation } from '../api/hooks';
import { CategoryPickerSheet } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import {
  badgeClass,
  Button,
  Chip,
  CountBadge,
  cx,
  DESKTOP_WIDTH,
  DesktopHeader,
  HeaderAction,
  ErrorNote,
  Icon,
  Loading,
  SectionTitle,
  SoftButton,
  useIsDesktop,
  useShortcuts,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { rowMeta, useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';
import { useQueryClient } from '@tanstack/react-query';

type NeedsRow = ActivityView['needsCategory'][number];

export function sheetPath(base: string, r: Pick<TxnListRow, 'key' | 'sheet'>): string {
  const seg =
    r.sheet === 'transfer'
      ? 'transfer'
      : r.sheet === 'match'
        ? 'match'
        : r.sheet === 'checkPending'
          ? 'check'
          : 'txn';
  return `${base}/${seg}/${encodeURIComponent(r.key)}`;
}

function amountClass(r: TxnListRow) {
  if (r.wontClear) return 'text-faint line-through';
  return r.amount > 0 ? 'text-funded-fg' : 'text-ink';
}

export function TxnRow({
  r,
  base,
  style = 'list',
  action,
}: {
  r: TxnListRow;
  base: string;
  style?: 'list' | 'posted' | 'register';
  action?: React.ReactNode;
}) {
  const desktop = useIsDesktop();
  // On a phone a row with a button stacks: the text gets the full width, and the badge and button share a line.
  const stacked = !!action && !desktop;
  const badge = r.badge && (
    <span className={cx('self-start rounded-md px-2 py-0.5 text-[12px] font-bold', badgeClass(r.badgeKind))}>
      {r.badge}
    </span>
  );
  return (
    <div
      className={cx(
        'flex gap-2.5 border-t border-divider px-3 py-2 first:border-t-0',
        stacked ? 'flex-col' : 'items-center',
        desktop && 'hover:bg-surface-2',
      )}
    >
      <Link
        to={sheetPath(base, r)}
        data-track="activity.row"
        className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-2.5 text-ink no-underline"
      >
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className={cx('text-[15px] font-semibold', r.wontClear && 'text-faint line-through')}>
            {r.payee}
          </span>
          <span className={cx('text-muted', desktop ? 'text-[13px]' : 'text-[12px]')}>
            {rowMeta(r, style)}
          </span>
          {!stacked && badge}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className={cx('tnum text-[15px] font-bold', amountClass(r))}>
            {r.sheet === 'txn' && r.badge === 'Transfer'
              ? formatCents(Math.abs(r.amount))
              : formatCents(r.amount, { plus: true })}
          </span>
          {r.sub && style !== 'register' && <span className="text-[12px] text-muted">{r.sub}</span>}
        </span>
      </Link>
      {stacked ? (
        <div className="flex items-center justify-between gap-2.5">
          {badge || <span />}
          {action}
        </div>
      ) : (
        action
      )}
    </div>
  );
}

function Section({
  title,
  note,
  children,
  action,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex shrink-0 flex-col gap-1.5">
      <SectionTitle note={note} action={action}>
        {title}
      </SectionTitle>
      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">{children}</div>
    </section>
  );
}

interface Picking {
  keys: string[];
  row: NeedsRow | null;
}

export function ActivityScreen() {
  const search = useSearch({ strict: false }) as { filter?: 'attention' | 'pending'; q?: string };
  const filter: ActivityFilter = search.filter ?? 'all';
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  useScreen(filter === 'all' ? 'activity' : `activity.${filter}`);
  const [qInput, setQInput] = useState(search.q ?? '');
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcuts({ '/': () => searchRef.current?.focus() }, desktop);
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    const id = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(id);
  }, [qInput]);
  useEffect(() => {
    setQInput(search.q ?? '');
  }, [search.q]);

  const query = useActivity(filter, q);
  const counts = useActivity('attention', '');
  const v = query.data;
  const canWrite = useCanWrite({ offline: true });
  const qc = useQueryClient();
  // The list keeps categorized rows in place and the counts are adjusted here, so Activity isn't refetched after
  // each categorize (every refetch reads the database); it refreshes on the next visit.
  const categorize = useMoneyMutation(api.categorize, { quiet: ['activity'] });
  const review = useMoneyMutation(api.reviewTxn);
  const saveRule = useMoneyMutation(api.saveRule, { money: false, invalidate: [qk.rules] });
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState<Picking | null>(null);
  /** Rows categorized while on this screen stay in place with their new category, as in the prototype. */
  const [chosen, setChosen] = useState<
    Record<string, { row: NeedsRow; categoryId: string | null; name: string }>
  >({});
  const reportedEmpty = useRef('');

  /** Keys in the order the server first listed them, so categorized rows keep their place. */
  const order = useRef<string[]>([]);
  const needs: NeedsRow[] = useMemo(() => {
    const live = v?.needsCategory ?? [];
    for (const r of live) if (!order.current.includes(r.key)) order.current.push(r.key);
    const kept = Object.values(chosen)
      .filter((c) => !live.some((r) => r.key === c.row.key))
      .map((c) => c.row);
    const pos = (k: string) => order.current.indexOf(k);
    return [...live, ...kept].sort((a, b) => pos(a.key) - pos(b.key));
  }, [v, chosen]);
  const openNeeds = needs.filter((r) => !chosen[r.key] || chosen[r.key]!.categoryId === null);

  const total = v
    ? v.moneyToMatch.length +
      v.transfersToSort.length +
      v.checkThese.length +
      (v.needsCategory?.length ?? 0) +
      (v.posted.length + v.pending.length + v.upcoming.length)
    : 0;
  useEffect(() => {
    if (!v || !q || query.isFetching) return;
    if (total === 0 && reportedEmpty.current !== q) {
      reportedEmpty.current = q;
      usage.searchNoResults(q.length);
    }
  }, [v, q, total, query.isFetching]);

  const setFilter = (f: ActivityFilter) =>
    navigate({ to: '/activity', search: { filter: f === 'all' ? undefined : f, q: q || undefined } });

  const pickerGroups = v?.categoryPicker ?? [];
  const availOf = (id: string) =>
    pickerGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.available;
  const nameOf = (id: string) =>
    pickerGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'category';

  const openPicker = (p: Picking) => {
    usage.startTask('categorize');
    setPicking(p);
  };

  const assign = async (keys: string[], categoryId: string) => {
    const rows = needs.filter((r) => keys.includes(r.key));
    const prev = Object.fromEntries(keys.map((k) => [k, chosen[k]?.categoryId ?? null]));
    const name = nameOf(categoryId);
    const before = availOf(categoryId);
    setPicking(null);
    setSelecting(false);
    setSel({});
    try {
      await categorize.mutateAsync({ keys, categoryId });
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t categorize that.' });
      return;
    }
    usage.endTask('categorize');
    adjustAttention(qc, -keys.filter((k) => prev[k] === null).length);
    setChosen((c) => ({
      ...c,
      ...Object.fromEntries(rows.map((r) => [r.key, { row: r, categoryId, name }])),
    }));
    const spent = rows.reduce((s, r) => s - r.amount, 0);
    const after = before === undefined ? null : before - spent;
    const warn =
      after !== null && after < 0
        ? ` · ${name} is now overspent by ${formatCents(-after)}. Cover it on Budget.`
        : '';
    const first = rows[0];
    const text = `${rows.length === 1 && first ? first.payee : `${rows.length} transactions`} → ${name}${warn}`;
    const offerRule = rows.length === 1 && first?.history?.consistent && first.history.categories[0] === name;
    const id = toast.show({
      text,
      undo: async () => {
        const back = keys.filter((k) => prev[k] === null);
        if (back.length) {
          await categorize.mutateAsync({ keys: back, categoryId: null });
          adjustAttention(qc, back.length);
        }
        for (const k of keys.filter((x) => prev[x]))
          await categorize.mutateAsync({ keys: [k], categoryId: prev[k]! });
        usage.undo('categorize');
        setChosen((c) => {
          const drop = new Set(keys);
          return Object.fromEntries(Object.entries(c).filter(([k]) => !drop.has(k)));
        });
      },
      offer:
        offerRule && first
          ? {
              text: `Put every ${first.payee} in ${name} from now on?`,
              label: 'Always',
              onIgnore: () => usage.suggestion('rule_offer', 'ignored'),
              onAccept: async () => {
                usage.suggestion('rule_offer', 'always');
                await saveRule.mutateAsync({
                  name: first.payee,
                  conditions: { all: [{ field: 'payee', op: 'is', value: first.payee }] },
                  actions: [{ type: 'set_category', categoryId }],
                  applyToPending: true,
                  stopAfter: true,
                  enabled: true,
                });
                toast.update(id, { text: `${text} · rule made`, offer: undefined, ms: 6000 });
              },
            }
          : undefined,
    });
  };

  const dismiss = async (r: TxnListRow) => {
    try {
      // OK is shown on bank rows with an alert; they have no expected entry, so the alert itself is marked reviewed.
      await review.mutateAsync(r.key);
      toast.show({ text: `${r.payee} · new amount accepted` });
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
    }
  };

  const selKeys = openNeeds.filter((r) => sel[r.key]).map((r) => r.key);
  const showAttnHead = filter !== 'pending' && !q && (v?.attentionCount ?? 0) > 0;
  const attentionCount = counts.data?.attentionCount ?? v?.attentionCount ?? 0;
  const notPostedCount = counts.data?.notPostedCount ?? v?.notPostedCount ?? 0;
  // A filter with nothing in it is hidden, unless it's the one showing; with neither, the chip row goes too.
  const showAttentionChip = attentionCount > 0 || filter === 'attention';
  const showPendingChip = notPostedCount > 0 || filter === 'pending';
  const showNeeds =
    filter !== 'pending' &&
    needs.filter((r) => !q || r.payee.toLowerCase().includes(q.toLowerCase())).length > 0;
  const empty = v && total === 0 && !showNeeds && !(filter === 'attention' && !q);

  const addButton = (
    <HeaderAction
      to="/activity/add"
      track="activity.add"
      icon="plus"
      label={desktop ? 'Add transaction' : 'Add'}
      ariaLabel={desktop ? undefined : 'Add transaction'}
    />
  );
  const searchBox = (
    <label key="search" className="flex min-h-11 items-center gap-2 rounded-xl bg-sunken px-3 text-muted">
      <Icon name="search" size={18} />
      <span className="sr-only">Search transactions</span>
      <input
        ref={searchRef}
        type="search"
        value={qInput}
        onChange={(e) => setQInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && qInput && (e.stopPropagation(), setQInput(''))}
        placeholder={desktop ? 'Search payee or amount  ( / )' : 'Search payee or amount'}
        aria-keyshortcuts={desktop ? '/' : undefined}
        className="min-h-10 flex-1 border-none bg-transparent text-[16px] text-ink outline-none placeholder:text-faint"
      />
    </label>
  );
  const chips = (showAttentionChip || showPendingChip) && (
    <div key="chips" role="group" aria-label="Filter" className="flex gap-2 overflow-x-auto pb-0.5">
      <Chip pressed={filter === 'all'} onClick={() => void setFilter('all')} track="activity.filter.all">
        All
      </Chip>
      {showAttentionChip && (
        <Chip
          pressed={filter === 'attention'}
          onClick={() => void setFilter('attention')}
          track="activity.filter.attention"
        >
          Needs attention <CountBadge n={attentionCount} inverted={filter === 'attention'} />
        </Chip>
      )}
      {showPendingChip && (
        <Chip
          pressed={filter === 'pending'}
          onClick={() => void setFilter('pending')}
          track="activity.filter.pending"
        >
          Not posted yet
        </Chip>
      )}
    </div>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <DesktopHeader title="Activity" right={addButton} below={[searchBox, chips]} />
      ) : (
        <header className="flex shrink-0 flex-col gap-2.5 border-b border-line bg-surface px-4 pb-2.5 pt-3">
          <div className="flex items-center justify-between gap-3">
            <h1 className="m-0 text-[22px] font-bold">Activity</h1>
            {addButton}
          </div>
          {searchBox}
          {chips}
        </header>
      )}
      <div
        className={cx(
          'flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pt-3',
          desktop ? 'px-6 pb-8' : 'px-4 pb-6',
        )}
      >
        <div className={cx('flex flex-col gap-3.5', desktop && DESKTOP_WIDTH)}>
          {!v && (query.error ? <ErrorNote error={query.error} /> : <Loading />)}
          {empty && <p className="m-0 p-4 text-center text-[14px] text-muted">No transactions match.</p>}
          {v && showAttnHead && (
            // The count is already on the filter chip above.
            <h2 className="m-0 px-0.5 text-[15px] font-bold">Needs attention</h2>
          )}
          {v && filter === 'attention' && !q && v.attentionCount === 0 && openNeeds.length === 0 && (
            <p className="m-0 rounded-[14px] bg-funded-bg p-4 text-center text-[15px] font-semibold text-funded-fg">
              Nothing needs attention.
            </p>
          )}
          {v && v.moneyToMatch.length > 0 && (
            <Section title="Money to match">
              {v.moneyToMatch.map((r) => (
                <TxnRow
                  key={r.key}
                  r={r}
                  base="/activity"
                  action={
                    <Link
                      to={sheetPath('/activity', r)}
                      data-track="activity.match"
                      aria-label={`Match ${r.payee}`}
                      className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
                    >
                      Match
                    </Link>
                  }
                />
              ))}
            </Section>
          )}
          {v && v.transfersToSort.length > 0 && (
            <Section title="Transfers to sort out">
              {v.transfersToSort.map((r) => (
                <TxnRow
                  key={r.key}
                  r={r}
                  base="/activity"
                  action={
                    <Link
                      to={sheetPath('/activity', r)}
                      data-track="activity.transfer.pick"
                      aria-label={`Pick ${r.payee}`}
                      className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
                    >
                      Pick
                    </Link>
                  }
                />
              ))}
            </Section>
          )}
          {v && showNeeds && (
            <section className="flex shrink-0 flex-col gap-1.5">
              <div className="flex min-h-9 items-center justify-between px-0.5">
                <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
                  Needs category{' '}
                  <span className="font-semibold normal-case tracking-normal text-muted">
                    ·{' '}
                    {openNeeds.length === 0
                      ? 'done'
                      : `${openNeeds.length} · ${formatCents(openNeeds.reduce((s, r) => s + r.amount, 0))}`}
                  </span>
                </h2>
                {openNeeds.length > 1 && (
                  <button
                    type="button"
                    data-track="activity.select"
                    onClick={() => {
                      setSelecting((x) => !x);
                      setSel({});
                    }}
                    className="hit h-9 px-2.5 text-[14px] font-bold text-accent"
                  >
                    {selecting ? 'Cancel' : 'Select'}
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
                {openNeeds.length === 0 && (
                  <p className="m-0 px-3 py-3.5 text-[14px] font-semibold text-funded-fg">
                    Everything has a category.
                  </p>
                )}
                {needs
                  .filter((r) => !q || r.payee.toLowerCase().includes(q.toLowerCase()))
                  .map((r) => {
                    const c = chosen[r.key];
                    const label = c && c.categoryId ? c.name : null;
                    const on = !!sel[r.key];
                    return (
                      <div
                        key={r.key}
                        className={cx(
                          'flex items-center gap-2.5 border-t border-divider px-3 py-2 first:border-t-0',
                          selecting && on ? 'bg-accent-soft' : 'bg-surface',
                        )}
                      >
                        {selecting && !label && (
                          <input
                            type="checkbox"
                            className="hit h-[22px] w-[22px] shrink-0 accent-[var(--ll-accent)]"
                            checked={on}
                            aria-label={`Select ${r.payee} ${formatCents(r.amount)}`}
                            onChange={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))}
                          />
                        )}
                        <Link
                          to={sheetPath('/activity', r)}
                          className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px] text-ink no-underline"
                        >
                          <span className="flex justify-between gap-2">
                            <span className="text-[15px] font-semibold">{r.payee}</span>
                            <span className="tnum text-[15px] font-bold">{formatCents(r.amount)}</span>
                          </span>
                          <span className="text-[12px] text-muted">{rowMeta(r, 'needs')}</span>
                        </Link>
                        {!selecting && (
                          <Button
                            mutates="offline"
                            track="activity.category.choose"
                            aria-label={`${label ? 'Change category for' : 'Choose category for'} ${r.payee} ${formatCents(r.amount)}`}
                            onClick={() => openPicker({ keys: [r.key], row: r })}
                            className={cx(
                              'hit h-9 max-w-[112px] shrink-0 truncate whitespace-nowrap rounded-full px-3 text-[13px] font-bold disabled:opacity-50',
                              label ? 'bg-sunken text-none-fg' : 'bg-accent-soft text-accent',
                            )}
                          >
                            {label ?? 'Choose'}
                          </Button>
                        )}
                      </div>
                    );
                  })}
              </div>
            </section>
          )}
          {v && v.checkThese.length > 0 && (
            <Section title="Check these">
              {v.checkThese.map((r) => (
                <TxnRow
                  key={r.key}
                  r={r}
                  base="/activity"
                  action={
                    r.action === 'dismiss' ? (
                      <SoftButton
                        mutates
                        track="activity.check.ok"
                        aria-label={`OK ${r.payee}`}
                        onClick={() => void dismiss(r)}
                      >
                        OK
                      </SoftButton>
                    ) : (
                      <Link
                        to={sheetPath('/activity', r)}
                        data-track="activity.check.review"
                        aria-label={`Review ${r.payee}`}
                        className="hit flex h-9 shrink-0 items-center rounded-full bg-accent-soft px-3 text-[13px] font-bold text-accent no-underline"
                      >
                        Review
                      </Link>
                    )
                  }
                />
              ))}
            </Section>
          )}
          {v && v.pending.length > 0 && (
            <Section title="Pending" note={`counts now · ${formatCents(v.pendingTotal)}`}>
              {v.pending.map((r) => (
                <TxnRow key={r.key} r={r} base="/activity" />
              ))}
            </Section>
          )}
          {v && v.upcoming.length > 0 && (
            <Section title="Upcoming" note="counts on its date">
              {v.upcoming.map((r) => (
                <TxnRow key={r.key} r={r} base="/activity" />
              ))}
            </Section>
          )}
          {v && v.posted.length > 0 && (
            <Section title="Posted" note="newest first">
              {v.posted.map((r) => (
                <TxnRow key={r.key} r={r} base="/activity" style="posted" />
              ))}
            </Section>
          )}
        </div>
      </div>
      {selecting && (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-line bg-surface px-4 py-2.5">
          <span className="flex-1 text-[14px] font-semibold">{selKeys.length} selected</span>
          <Button
            mutates="offline"
            track="activity.select.choose"
            disabled={selKeys.length === 0 || !canWrite}
            onClick={() => openPicker({ keys: selKeys, row: null })}
            className="h-11 rounded-xl bg-accent px-[18px] text-[15px] font-bold text-on-accent disabled:bg-disabled disabled:text-on-accent"
          >
            Choose category
          </Button>
        </div>
      )}
      {picking && v && (
        <CategoryPicker
          picking={picking}
          groups={v.categoryPicker}
          onPick={(id) => void assign(picking.keys, id)}
          onClose={() => {
            usage.cancelTask('categorize');
            setPicking(null);
          }}
          onSplit={(key) => {
            setPicking(null);
            void navigate({ to: `/activity/txn/${encodeURIComponent(key)}/split` });
          }}
          onTransfer={(key) => {
            setPicking(null);
            void navigate({ to: `/activity/txn/${encodeURIComponent(key)}` });
          }}
        />
      )}
      <Outlet />
    </div>
  );
}

function CategoryPicker({
  picking,
  groups,
  onPick,
  onClose,
  onSplit,
  onTransfer,
}: {
  picking: Picking;
  groups: ActivityView['categoryPicker'];
  onPick: (id: string) => void;
  onClose: () => void;
  onSplit: (key: string) => void;
  onTransfer: (key: string) => void;
}) {
  const row = picking.row;
  const byName = new Map(groups.flatMap((g) => g.categories.map((c) => [c.name, c.id] as const)));
  const suggested = (row?.history?.categories ?? []).flatMap((n) => {
    const id = byName.get(n);
    return id ? [id] : [];
  });
  const canWrite = useCanWrite({ offline: true });
  return (
    <CategoryPickerSheet
      track="activity.picker"
      onClose={onClose}
      onPick={onPick}
      disabled={!canWrite}
      groups={groups.map((g) => ({ key: g.group, name: g.group, categories: g.categories }))}
      suggested={suggested}
      suggestedTitle={row?.history?.title}
      sub={
        row
          ? `${row.payee} · ${formatCents(row.amount)} · ${rowMeta(row, 'needs')}`
          : `${picking.keys.length} transactions`
      }
    >
      {row && (
        <div className="flex gap-4 pt-1">
          <button
            type="button"
            data-track="activity.picker.split"
            onClick={() => onSplit(row.key)}
            className="hit flex h-10 items-center text-[14px] font-bold text-accent"
          >
            Split it…
          </button>
          <button
            type="button"
            data-track="activity.picker.transfer"
            onClick={() => onTransfer(row.key)}
            className="hit flex h-10 items-center text-[14px] font-bold text-accent"
          >
            It’s a transfer…
          </button>
        </div>
      )}
    </CategoryPickerSheet>
  );
}
