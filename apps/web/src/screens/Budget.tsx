// Budget (home): month switcher, All / Needs attention, card payment rows pinned first, the Owed to you row,
// collapsible groups with totals, status words and bars. Desktop shows the same data, bars and status words as
// a table with Assigned, Spent and Available columns (BudgetTable). Needs attention offers one-tap fixes with
// amounts (BudgetAttention); the phone list is BudgetRows, the notes above it BudgetStates.
import { useRef } from 'react';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import type { BudgetView } from '@ledgerline/contracts';
import { useBudget, useSession } from '../api/hooks';
import {
  Chip,
  CountBadge,
  cx,
  ErrorNote,
  Icon,
  Loading,
  OverflowMenu,
  ScreenBody,
  HeaderAction,
  useIsDesktop,
} from '../components/ui';
import { MonthBar, TabHeader } from '../components/MonthBar';
import { formatCents } from '../lib/money';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { AllGroups, allAssignedZero } from './BudgetRows';
import { AttentionList } from './BudgetAttention';
import { FirstBudget, NewMonth, OverAssigned, PastNote } from './BudgetStates';
import { DesktopTable } from './BudgetTable';

type View = 'all' | 'attention' | 'low';

export interface BudgetSearch {
  month?: string;
  view?: View;
}

export function useBudgetMonth(): { month: string | undefined; current: string | undefined } {
  const search = useSearch({ strict: false }) as BudgetSearch;
  const session = useSession();
  const current = session.data?.budget.currentMonth;
  return { month: search.month ?? current, current };
}

// ------------------------------------------------------------------ screen

function RtaBar({ b, onFix }: { b: BudgetView; onFix: () => void }) {
  const canWrite = useCanWrite();
  const neg = b.rta < 0;
  // Every dollar assigned: a quiet line, nothing to do.
  if (b.rta === 0 && !b.rtaUpdating)
    return (
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 text-[13px] text-muted">
        <span className="font-semibold">All money assigned</span>
        <span className="tnum font-bold text-ink-2" data-testid="rta">
          {formatCents(0)}
        </span>
      </div>
    );
  return (
    <div
      className={cx(
        'flex shrink-0 items-center justify-between gap-3 px-4 py-2.5',
        neg ? 'bg-danger text-on-danger' : 'bg-rta-bg text-rta-fg',
      )}
    >
      <div className="flex flex-col gap-px">
        <span className="text-[12px] font-semibold">Ready to Assign</span>
        <span className="tnum text-[22px] font-bold" data-testid="rta">
          {b.rtaUpdating ? 'Updating' : formatCents(b.rta)}
        </span>
      </div>
      {canWrite && neg ? (
        // Below zero the job is to take money back, which the list above offers: go there.
        <button
          type="button"
          data-track="budget.over.fix"
          onClick={onFix}
          className="hit flex h-10 items-center rounded-full bg-on-danger px-[22px] text-[15px] font-bold text-danger"
        >
          Take back
        </button>
      ) : canWrite ? (
        <Link
          to="/budget/assign"
          data-track="budget.assign"
          className="hit flex h-10 items-center rounded-full bg-rta-fg px-[22px] text-[15px] font-bold text-rta-btn-fg no-underline"
        >
          Assign
        </Link>
      ) : (
        <span
          aria-disabled="true"
          className="flex h-10 items-center rounded-full bg-on-accent/50 px-[22px] text-[15px] font-bold text-muted"
        >
          Assign
        </span>
      )}
    </div>
  );
}

function MonthNav({ b, month, view }: { b: BudgetView; month: string; view: View }) {
  const navigate = useNavigate();
  const go = (m: string) =>
    void navigate({
      to: '/budget',
      search: { month: m === b.currentMonth ? undefined : m, view: view === 'all' ? undefined : view },
    });
  return <MonthBar month={month} current={b.currentMonth} min={b.minMonth} max={b.maxMonth} onGo={go} />;
}

function ViewChips({
  view,
  count,
  lowCount,
  month,
  current,
}: {
  view: View;
  count: number;
  lowCount: number;
  month: string;
  current: string;
}) {
  const navigate = useNavigate();
  const set = (v: View) =>
    navigate({
      to: '/budget',
      search: { month: month === current ? undefined : month, view: v === 'all' ? undefined : v },
    });
  // A filter with nothing in it is hidden, unless it's the one showing.
  const showAttention = count > 0 || view === 'attention';
  const showLow = lowCount > 0 || view === 'low';
  if (!showAttention && !showLow) return null;
  return (
    <div role="group" aria-label="Show" className="flex gap-2">
      <Chip pressed={view === 'all'} onClick={() => set('all')} track="budget.filter.all">
        All
      </Chip>
      {showAttention && (
        <Chip pressed={view === 'attention'} onClick={() => set('attention')} track="budget.filter.attention">
          Needs attention <CountBadge n={count} inverted={view === 'attention'} />
        </Chip>
      )}
      {showLow && (
        <Chip pressed={view === 'low'} onClick={() => set('low')} track="budget.filter.low">
          Low <CountBadge n={lowCount} inverted={view === 'low'} />
        </Chip>
      )}
    </div>
  );
}

function SyncProblem({ text }: { text: string }) {
  return (
    <Link
      to="/accounts"
      className="flex items-center gap-2 bg-warn-bg px-4 py-2 text-[13px] font-semibold text-warn-fg no-underline"
    >
      <Icon name="alert" size={16} stroke={2.6} />
      {text} · see Accounts
    </Link>
  );
}

export function BudgetScreen() {
  const desktop = useIsDesktop();
  const search = useSearch({ strict: false }) as BudgetSearch;
  const view: View = search.view === 'attention' || search.view === 'low' ? search.view : 'all';
  const { month, current } = useBudgetMonth();
  useScreen(view === 'attention' ? 'budget.attention' : view === 'low' ? 'budget.low' : 'budget');
  const q = useBudget(month);
  const session = useSession();
  const b = q.data;
  const scroller = useRef<HTMLDivElement>(null);

  if (!month || !current) return <Loading />;
  if (q.error && !b)
    return (
      <div className="p-4">
        <ErrorNote error={q.error} />
      </div>
    );
  if (!b) return <Loading />;

  const empty = allAssignedZero(b) && b.cards.every((c) => c.available === 0);
  const targetsSearch = { month: month === b.currentMonth ? undefined : month };
  const today = session.data?.budget.today ?? '';
  const newMonth =
    month === b.currentMonth &&
    today.endsWith('-01') &&
    !empty &&
    b.groups.every((g) => g.categories.every((c) => c.assigned === 0));
  const lowCount = b.attention.filter((a) => a.section === 'Low').length;
  const count = b.attention.length - lowCount;
  const content = (
    <>
      <PastNote month={month} current={b.currentMonth} />
      <OverAssigned b={b} month={month} />
      {empty && <FirstBudget b={b} />}
      {newMonth && <NewMonth b={b} month={month} />}
      {view !== 'all' ? (
        <AttentionList b={b} month={month} low={view === 'low'} />
      ) : desktop ? (
        <DesktopTable b={b} month={month} />
      ) : (
        <AllGroups b={b} month={month} />
      )}
    </>
  );

  if (desktop) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TabHeader
          name="Budget"
          month={<MonthNav b={b} month={month} view={view} />}
          right={
            <>
              {/* The header narrows when a side panel opens: these two fold into a menu instead of wrapping. */}
              <span className="hidden gap-2 @min-[560px]:flex">
                <HeaderAction
                  to="/categories"
                  track="budget.edit_categories"
                  icon="pencil"
                  label="Edit categories"
                />
                <HeaderAction
                  to="/targets"
                  search={targetsSearch}
                  track="budget.set_targets"
                  icon="target"
                  label="Set targets"
                />
              </span>
              <OverflowMenu
                label="More budget actions"
                className="@min-[560px]:hidden"
                items={[
                  { to: '/categories', name: 'Edit categories', track: 'budget.edit_categories' },
                  { to: '/targets', search: targetsSearch, name: 'Set targets', track: 'budget.set_targets' },
                ]}
              />
            </>
          }
          below={
            count > 0 || lowCount > 0 || view !== 'all' ? (
              <ViewChips
                view={view}
                count={count}
                lowCount={lowCount}
                month={month}
                current={b.currentMonth}
              />
            ) : undefined
          }
        />
        {b.syncProblem && <SyncProblem text={b.syncProblem} />}
        <ScreenBody>{content}</ScreenBody>
        <Outlet />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TabHeader
        name="Budget"
        month={<MonthNav b={b} month={month} view={view} />}
        right={
          // Categories and targets belong to the budget, so they sit at the top of it; Settings stays behind the
          // gear on Accounts.
          <OverflowMenu
            label="More budget actions"
            items={[
              { to: '/targets', search: targetsSearch, name: 'Set targets', track: 'budget.set_targets' },
              { to: '/categories', name: 'Edit categories', track: 'budget.edit_categories' },
            ]}
          />
        }
        below={
          count > 0 || lowCount > 0 || view !== 'all' ? (
            <ViewChips view={view} count={count} lowCount={lowCount} month={month} current={b.currentMonth} />
          ) : undefined
        }
      />
      {b.syncProblem && <SyncProblem text={b.syncProblem} />}
      <ScreenBody scrollRef={scroller}>{content}</ScreenBody>
      <RtaBar b={b} onFix={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
      <Outlet />
    </div>
  );
}
