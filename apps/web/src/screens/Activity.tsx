// Activity: search, All / Needs attention / Not posted yet; Not posted yet shows first (D-97). Needs attention groups: Transfers to sort
// out, Same purchase?, Needs category (with Select several and the category picker), Check these. Under All the same
// groups sit on top, then Pending, Upcoming and Posted. A row can carry a suggested category with OK, and OK all
// takes every strong suggestion (docs/payees.md 2.2). Categorizing shows an Undo toast.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { TxnListRow } from '@ledgerline/contracts';
import { api, type ActivityFilter } from '../api/endpoints';
import { ApiError, errorMessage } from '../api/client';
import { adjustAttention, qk, useActivity, useBudget, useMoneyMutation, useSession } from '../api/hooks';
import { MonthBar, TabHeader } from '../components/MonthBar';
import { BackHeader, PageFrame } from '../components/headers';
import { monthName } from '../lib/dates';
import { useBack } from '../lib/back';
import { clampMonth } from '../state/month';
import { toast } from '../components/Toast';
import {
  Chip,
  CountBadge,
  EmptyNote,
  FloatingAction,
  HeaderAction,
  ErrorNote,
  Loading,
  PrimaryButton,
  ScreenBody,
  SearchField,
  SectionTitle,
  SoftButton,
  useIsDesktop,
  useShortcuts,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { foldSearch } from '@ledgerline/domain';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';
import { useQueryClient } from '@tanstack/react-query';
import { Section, TxnRow, type Chosen, type NeedsRow, type Picking } from './ActivityRows';
import { ActivityCategoryPicker, NeedsCategory } from './ActivityNeeds';
import { primeKeyboard } from '../components/CategoryPicker';
import { SamePurchase } from './ActivitySame';
import { RemovedByBank } from './ActivityRemoved';
import { CheckThese, TransfersToSort } from './ActivityAttention';
import { useMorePosted } from './ActivityMore';
import { useRowPicker } from './ActivityRowPick';

export { TxnRow } from './ActivityRows';

export function ActivityScreen() {
  const search = useSearch({ strict: false }) as {
    filter?: ActivityFilter;
    q?: string;
    category?: string;
    month?: string;
    back?: string;
  };
  const navigate = useNavigate();
  // One category's list opened from a category sheet: Back returns there; from Reports, to the report's month.
  const back = useBack();
  // The app's month (docs/month-header.md): this month by default, never past it.
  const current = useSession().data?.budget.currentMonth;
  const min = useBudget(current).data?.minMonth;
  const month = clampMonth(search.month, min, current) ?? current;
  const past = !!month && !!current && month !== current;
  const desktop = useIsDesktop();
  const [qInput, setQInput] = useState(search.q ?? '');
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcuts({ '/': () => searchRef.current?.focus() }, desktop);
  const [q, setQ] = useState(search.q ?? '');
  /** The search the URL holds: what was typed is written there, so a reload or Back keeps it. */
  const inUrl = useRef(search.q ?? '');
  useEffect(() => {
    const id = setTimeout(() => {
      const next = qInput.replace(/\s+/g, ' ').trim();
      setQ(next);
      if (next === inUrl.current) return;
      inUrl.current = next;
      void navigate({ to: '.', search: (p: object) => ({ ...p, q: next || undefined }), replace: true });
    }, 250);
    return () => clearTimeout(id);
  }, [qInput, navigate]);
  useEffect(() => {
    // A search from outside (a link, Back): only when it isn't the one this screen just wrote.
    if ((search.q ?? '') === inUrl.current) return;
    inUrl.current = search.q ?? '';
    setQInput(search.q ?? '');
    setQ(search.q ?? '');
  }, [search.q]);

  // A search looks through every month, and so does one category's list (Reports → a category).
  const category = search.category;
  const allMonths = !!q || !!category;
  const counts = useActivity('attention', '');
  // Not posted yet belongs to this month: on a past month the filter shows everything instead. With no filter
  // chosen, Activity opens on Not posted yet (D-97), or on All when there is none or for a search.
  const noneNotPosted = counts.data?.notPostedCount === 0;
  const chosenFilter = search.filter ?? (past || allMonths || noneNotPosted ? 'all' : 'pending');
  const filter: ActivityFilter = chosenFilter === 'pending' && past ? 'all' : chosenFilter;
  useScreen(filter === 'all' ? 'activity' : `activity.${filter}`);
  const query = useActivity(filter, q, allMonths ? undefined : month, category);
  const v = query.data;
  const more = useMorePosted(v, filter, q, allMonths ? undefined : month, category);
  // Desktop: each row's category menu (ActivityRowPick.tsx).
  const rowPick = useRowPicker(v?.categoryPicker);
  const picked = (r: TxnListRow) => {
    const action = rowPick.action(r);
    return { action, hideCategory: !!action };
  };
  const canWrite = useCanWrite({ offline: true });
  const qc = useQueryClient();
  // The list keeps categorized rows in place and the counts are adjusted here, so Activity isn't refetched after
  // each categorize (every refetch reads the database); it refreshes on the next visit.
  const categorize = useMoneyMutation(api.categorize, { quiet: ['activity'] });
  const review = useMoneyMutation(api.reviewTxn);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [picking, setPicking] = useState<Picking | null>(null);
  /** Rows categorized while on this screen stay in place with their new category, as in the prototype. */
  const [chosen, setChosen] = useState<Record<string, Chosen>>({});
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
  const openNeeds = needs.filter(
    (r) => !chosen[r.key] || (chosen[r.key]!.categoryId === null && !chosen[r.key]!.toRta),
  );

  // Not posted yet lists only what hasn't posted: a to-do about a posted row waits under All and Needs attention.
  const unposted = filter === 'pending';
  const toSort = (v?.transfersToSort ?? []).filter((r) => !unposted || r.status !== 'posted');
  const toCheck = (v?.checkThese ?? []).filter((r) => !unposted || r.status !== 'posted');
  const sameCards = (v?.samePurchase ?? []).filter(
    (c) => !unposted || [c.row, ...c.candidates].some((r) => r.status !== 'posted'),
  );
  const total = v
    ? toSort.length +
      toCheck.length +
      sameCards.length +
      v.removedByBank.length +
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
    navigate({
      to: '/activity',
      search: {
        filter: f,
        q: q || undefined,
        category,
        month: search.month,
        back: search.back,
      },
    });
  const goMonth = (m: string) =>
    void navigate({
      to: '/activity',
      search: {
        filter: search.filter,
        q: q || undefined,
        category,
        month: m === current ? undefined : m,
        back: search.back,
      },
    });

  const pickerGroups = v?.categoryPicker ?? [];
  const availOf = (id: string) =>
    pickerGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.available;
  const nameOf = (id: string) =>
    pickerGroups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? 'category';

  const openPicker = (p: Picking) => {
    primeKeyboard();
    usage.startTask('categorize');
    setPicking(p);
  };

  /** Where rows go: a category, or Ready to Assign (`categoryId` null, money in only). */
  type Target = { categoryId: string | null; toRta?: boolean; name: string };

  const assign = async (keys: string[], categoryId: string) =>
    assignAll([{ keys, target: { categoryId, name: nameOf(categoryId) } }]);

  /** Categorizes each group of rows in one request per target, with one toast and one Undo for all of them. */
  const assignAll = async (parts: { keys: string[]; target: Target }[], okAll = false) => {
    const keys = parts.flatMap((p) => p.keys);
    if (!keys.length) return;
    const prev = Object.fromEntries(
      keys.map((k) => [
        k,
        chosen[k] ? { categoryId: chosen[k]!.categoryId, toRta: !!chosen[k]!.toRta } : null,
      ]),
    );
    const before = new Map(
      parts.map((p) => [p.target.categoryId, p.target.categoryId ? availOf(p.target.categoryId) : undefined]),
    );
    setPicking(null);
    setSelecting(false);
    setSel({});
    const done: string[] = [];
    try {
      for (const p of parts) {
        await categorize.mutateAsync({
          keys: p.keys,
          categoryId: p.target.categoryId,
          toRta: p.target.toRta,
        });
        done.push(...p.keys);
      }
    } catch (e) {
      toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t categorize that. Try again.' });
      if (!done.length) return;
    }
    usage.endTask('categorize');
    adjustAttention(qc, -done.filter((k) => prev[k] === null).length);
    const byKey = new Map(parts.flatMap((p) => p.keys.map((k) => [k, p.target] as const)));
    setChosen((c) => ({
      ...c,
      ...Object.fromEntries(
        needs
          .filter((r) => done.includes(r.key))
          .map((r) => {
            const t = byKey.get(r.key)!;
            return [r.key, { row: r, categoryId: t.categoryId, toRta: !!t.toRta, name: t.name }];
          }),
      ),
    }));
    // What each category has left after these rows, from what the picker showed before: below 0 is overspent.
    const after = (p: (typeof parts)[number]) => {
      const b = p.target.categoryId ? before.get(p.target.categoryId) : undefined;
      if (b === undefined) return null;
      return b + needs.filter((r) => p.keys.includes(r.key)).reduce((a, r) => a + r.amount, 0);
    };
    const over = parts.filter((p) => (after(p) ?? 0) < 0);
    const first = needs.find((r) => r.key === keys[0]);
    const one = parts.length === 1 ? parts[0]! : null;
    const left = one ? after(one) : null;
    const warn =
      one && left !== null && left < 0 ? ` · Overspent by ${formatCents(-left)}. Cover it on Budget.` : '';
    const overAll = over.length
      ? ` · ${over.length} ${over.length === 1 ? 'category' : 'categories'} now overspent`
      : '';
    const count = (n: number) => `${n} ${n === 1 ? 'transaction' : 'transactions'}`;
    const text = okAll
      ? `${count(done.length)} categorized${overAll}`
      : `${keys.length === 1 && first ? first.payee : count(keys.length)} → ${one?.target.name ?? 'category'}${warn}`;
    toast.show({
      text,
      undo: async () => {
        try {
          const back = done.filter((k) => prev[k] === null);
          if (back.length) {
            await categorize.mutateAsync({ keys: back, categoryId: null });
            adjustAttention(qc, back.length);
          }
          for (const k of done.filter((x) => prev[x]))
            await categorize.mutateAsync({
              keys: [k],
              categoryId: prev[k]!.categoryId,
              toRta: prev[k]!.toRta || undefined,
            });
        } catch (e) {
          toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t undo that. Try again.' });
          return;
        }
        usage.undo('categorize');
        setChosen((c) => {
          const drop = new Set(done);
          return Object.fromEntries(Object.entries(c).filter(([k]) => !drop.has(k)));
        });
      },
    });
  };

  /** OK on one row: categorize it with its suggestion. */
  const accept = (r: NeedsRow) => {
    const sug = r.suggestion;
    if (!sug) return;
    usage.startTask('categorize');
    void assignAll([
      { keys: [r.key], target: { categoryId: sug.categoryId, toRta: sug.toRta, name: sug.name } },
    ]);
  };

  /** Join a new payee into your payee of the same name (docs/payees.md 4.3), with Undo; Activity loads again. */
  const join = async (r: NeedsRow) => {
    if (!r.sameAs || !r.payeeId) return;
    const into = r.sameAs;
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: qk.payees });
    };
    try {
      const res = await api.mergePayees({ keep: into.id, ids: [into.id, r.payeeId] });
      refresh();
      toast.show({
        text: `Joined into ${into.name}`,
        undo: async () => {
          try {
            await api.undoMergePayees(res.undoId);
            usage.undo('payee_join');
          } catch (e) {
            toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t undo that. Try again.' });
          }
          refresh();
        },
      });
    } catch (e) {
      toast.show({
        text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t join those payees. Try again.',
      });
    }
  };

  /** OK all: every open row shown (under the search) with a strong suggestion, one request per category. */
  const strongRows = (rows: NeedsRow[]) => rows.filter((r) => r.suggestion?.strong);
  const acceptAll = (rows: NeedsRow[]) => {
    const groups = new Map<string, { keys: string[]; target: Target }>();
    for (const r of strongRows(rows)) {
      const s = r.suggestion!;
      const k = s.toRta ? 'rta' : s.categoryId!;
      const g = groups.get(k) ?? {
        keys: [],
        target: { categoryId: s.categoryId, toRta: s.toRta, name: s.name },
      };
      g.keys.push(r.key);
      groups.set(k, g);
    }
    usage.startTask('categorize');
    void assignAll([...groups.values()], true);
  };

  const dismiss = async (r: TxnListRow) => {
    try {
      // OK is shown on bank rows with an alert; they have no expected entry, so the alert itself is marked reviewed.
      await review.mutateAsync(r.key);
      toast.show({ text: `${r.payee} · marked OK` });
    } catch (e) {
      toast.show({ text: e instanceof ApiError ? errorMessage(e) : 'Couldn’t save that. Try again.' });
    }
  };

  const selKeys = openNeeds.filter((r) => sel[r.key]).map((r) => r.key);
  // Under All it sets the groups that need you apart from Pending and Posted; the Needs attention filter's chip
  // already says it.
  const showAttnHead = filter === 'all' && !allMonths && (v?.attentionCount ?? 0) > 0;
  const attentionCount = counts.data?.attentionCount ?? v?.attentionCount ?? 0;
  const notPostedCount = counts.data?.notPostedCount ?? v?.notPostedCount ?? 0;
  // A filter with nothing in it is hidden, unless it's the one showing; with neither, the chip row goes too.
  const showAttentionChip = attentionCount > 0 || filter === 'attention';
  const showPendingChip = !past && (notPostedCount > 0 || filter === 'pending');
  // The server matched its rows to the search (payee, amount or category); rows kept here after you categorized
  // them are matched by payee.
  const liveNeeds = new Set((v?.needsCategory ?? []).map((r) => r.key));
  const shownNeeds = needs.filter(
    (r) => !q || liveNeeds.has(r.key) || foldSearch(r.payee).includes(foldSearch(q)),
  );
  const showNeeds = filter !== 'pending' && shownNeeds.length > 0;
  const empty = v && total === 0 && !showNeeds && !(filter === 'attention' && !q);
  // One category's list, opened on a category that no longer exists.
  const gone = !!category && v?.categoryName === null;

  // The sheet keeps the list's month, filter and search, so the list under it doesn't change.
  const addSearch = { month: search.month, filter: search.filter, q: search.q, category, back: search.back };
  // On a phone Add floats at the bottom right, in thumb reach (D-71); it steps aside while Select is on.
  const addButton = desktop && (
    <HeaderAction
      to="/activity/add"
      search={addSearch}
      track="activity.add"
      icon="plus"
      label="Add transaction"
    />
  );
  const addFab = !desktop && !selecting && !category && (
    <FloatingAction
      to="/activity/add"
      search={addSearch}
      track="activity.add"
      icon="plus"
      label="Add transaction"
    />
  );
  const searchBox = (
    <SearchField
      key="search"
      ref={searchRef}
      value={qInput}
      onChange={setQInput}
      label="Search transactions"
      placeholder={desktop ? 'Search payee or amount  ( / )' : 'Search payee or amount'}
      shortcut={desktop ? '/' : undefined}
    />
  );
  const chips = (showAttentionChip || showPendingChip) && (
    <div key="chips" role="group" aria-label="Filter" className="chip-row">
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
    <PageFrame still={!category}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {category ? (
          // Reports → a category: a page of its own, with Back to the report's month.
          <BackHeader
            title={v ? (v.categoryName ?? 'Category') : ''}
            // A link to a category that was removed: no months to show.
            sub={gone ? undefined : 'All months'}
            backLabel={back?.label ?? 'Back to Reports'}
            onBack={back ? back.go : () => void navigate({ to: '/reports', search: { month: search.month } })}
            below={searchBox}
          />
        ) : (
          <TabHeader
            name="Activity"
            month={
              month &&
              current && <MonthBar month={month} current={current} min={min} max={current} onGo={goMonth} />
            }
            right={addButton}
            below={[searchBox, chips]}
          />
        )}
        <ScreenBody className={addFab ? 'pb-20' : undefined}>
          {q && !category && month && (
            <p className="m-0 px-0.5 text-sm text-muted" data-testid="all-months">
              Searching all months
            </p>
          )}
          {!v && (query.error ? <ErrorNote error={query.error} /> : <Loading />)}
          {gone && <EmptyNote>This category was removed.</EmptyNote>}
          {empty && !gone && (
            <EmptyNote>
              {allMonths || filter !== 'all' || !month
                ? 'No transactions match.'
                : `No transactions in ${monthName(month)}.`}
            </EmptyNote>
          )}
          {v && showAttnHead && (
            // The count is already on the filter chip above.
            // Same look as every other section heading (small capitals).
            <SectionTitle>Needs attention</SectionTitle>
          )}
          {v &&
            filter === 'attention' &&
            !q &&
            v.attentionCount === 0 &&
            openNeeds.length === 0 &&
            !showNeeds && (
              <p className="m-0 rounded-lg bg-funded-bg p-4 text-center text-base font-semibold text-funded-fg">
                Nothing needs attention.
              </p>
            )}
          {v && toSort.length > 0 && <TransfersToSort rows={toSort} />}
          {v && sameCards.length > 0 && <SamePurchase cards={sameCards} />}
          {v && showNeeds && (
            <NeedsCategory
              needs={shownNeeds}
              openNeeds={openNeeds}
              chosen={chosen}
              selecting={selecting}
              setSelecting={setSelecting}
              sel={sel}
              setSel={setSel}
              openPicker={openPicker}
              onAccept={accept}
              onAcceptAll={acceptAll}
              onJoin={(r) => void join(r)}
            />
          )}
          {v && toCheck.length > 0 && <CheckThese rows={toCheck} onDismiss={(r) => void dismiss(r)} />}
          {v && v.removedByBank.length > 0 && <RemovedByBank rows={v.removedByBank} />}
          {v && v.pending.length > 0 && (
            <Section title="Pending" note={`counts now · ${formatCents(v.pendingTotal)}`}>
              {v.pending.map((r) => (
                <TxnRow key={r.key} r={r} base="/activity" {...picked(r)} />
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
              {[...v.posted, ...more.rows].map((r) => (
                <TxnRow key={r.key} r={r} base="/activity" style="posted" {...picked(r)} />
              ))}
            </Section>
          )}
          {v && v.posted.length > 0 && more.cursor && (
            <SoftButton track="activity.more" disabled={more.loading} onClick={() => void more.load()}>
              {more.loading ? 'Loading…' : 'Show more'}
            </SoftButton>
          )}
        </ScreenBody>
        {selecting && (
          <div className="flex shrink-0 items-center gap-2.5 border-t border-line bg-surface px-4 py-2.5">
            <span className="flex-1 text-md font-semibold">{selKeys.length} selected</span>
            {/* The button keeps its own width next to the count. */}
            <div className="shrink-0">
              <PrimaryButton
                mutates="offline"
                track="activity.select.choose"
                disabled={selKeys.length === 0 || !canWrite}
                onClick={() => openPicker({ keys: selKeys, row: null })}
              >
                Choose category
              </PrimaryButton>
            </div>
          </div>
        )}
        {addFab}
        {rowPick.sheet}
        {picking && v && (
          <ActivityCategoryPicker
            picking={picking}
            groups={v.categoryPicker}
            onPick={(id) => void assign(picking.keys, id)}
            onClose={() => {
              usage.cancelTask('categorize');
              setPicking(null);
            }}
            onSplit={(key) => {
              setPicking(null);
              void navigate({ to: `/activity/txn/${encodeURIComponent(key)}/split`, search: true });
            }}
            onTransfer={(key) => {
              setPicking(null);
              void navigate({ to: `/activity/transfer/${encodeURIComponent(key)}`, search: true });
            }}
          />
        )}
        <Outlet />
      </div>
    </PageFrame>
  );
}
