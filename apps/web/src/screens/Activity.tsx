// Activity: search, All / Needs attention / Not posted yet. Needs attention groups: Money to match, Transfers
// to sort out, Needs category (with Select several and the category picker), Check these. Under All the same
// groups sit on top, then Pending, Upcoming and Posted. Categorizing shows an Undo toast and, when every past
// transaction from the payee used the same category, offers "Always" (a rule).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { TxnListRow } from '@ledgerline/contracts';
import { api, type ActivityFilter } from '../api/endpoints';
import { adjustAttention, qk, useActivity, useMoneyMutation } from '../api/hooks';
import { toast } from '../components/Toast';
import {
  Chip,
  CountBadge,
  DesktopHeader,
  EmptyNote,
  HeaderAction,
  ErrorNote,
  Loading,
  PhoneHeader,
  PrimaryButton,
  ScreenBody,
  SearchField,
  SoftButton,
  softButtonClass,
  useIsDesktop,
  useShortcuts,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { usage } from '../usage/tracker';
import { useQueryClient } from '@tanstack/react-query';
import { sheetPath, Section, TxnRow, type NeedsRow, type Picking } from './ActivityRows';
import { ActivityCategoryPicker, NeedsCategory } from './ActivityNeeds';

export { TxnRow } from './ActivityRows';

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <DesktopHeader title="Activity" right={addButton} below={[searchBox, chips]} />
      ) : (
        <PhoneHeader title="Activity" right={addButton} below={[searchBox, chips]} />
      )}
      <ScreenBody>
        {!v && (query.error ? <ErrorNote error={query.error} /> : <Loading />)}
        {empty && <EmptyNote>No transactions match.</EmptyNote>}
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
                    className={softButtonClass()}
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
                    className={softButtonClass()}
                  >
                    Pick
                  </Link>
                }
              />
            ))}
          </Section>
        )}
        {v && showNeeds && (
          <NeedsCategory
            needs={needs}
            openNeeds={openNeeds}
            q={q}
            chosen={chosen}
            selecting={selecting}
            setSelecting={setSelecting}
            sel={sel}
            setSel={setSel}
            openPicker={openPicker}
          />
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
                      className={softButtonClass()}
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
      </ScreenBody>
      {selecting && (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-line bg-surface px-4 py-2.5">
          <span className="flex-1 text-[14px] font-semibold">{selKeys.length} selected</span>
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
