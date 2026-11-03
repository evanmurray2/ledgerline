// Reports: month to date by default. Spending (tiles, by category net of paybacks), Trends (last 6 months),
// Net worth. Desktop shows all three at once.
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReportsView } from '@ledgerline/contracts';
import { useAccounts, useBudget, useReports, useSession } from '../api/hooks';
import {
  Card,
  cx,
  DesktopHeader,
  EmptyNote,
  ErrorNote,
  Icon,
  Loading,
  PhoneHeader,
  ScreenBody,
  SectionTitle,
  Segmented,
  useIsDesktop,
} from '../components/ui';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { formatCents, percentOf } from '../lib/money';
import { monthLabel, monthShort } from '../lib/dates';
import { useScreen } from '../lib/common';

type View = 'spend' | 'trend' | 'worth';

function kShort(cents: number) {
  const dollars = Math.round(cents / 100);
  return dollars >= 1000 ? `$${(dollars / 1000).toFixed(1)}k` : `$${dollars}`;
}

function Tiles({ r, desktop }: { r: ReportsView; desktop: boolean }) {
  const tiles: [string, number, string][] = [
    ['Spent', r.tiles.spent, r.monthToDate ? 'month to date' : 'whole month'],
    ['Invested', r.tiles.invested, 'saving or investing'],
    ['Income', r.tiles.income, 'to Ready to Assign'],
  ];
  if (desktop) tiles.push(['Rewards', r.tiles.rewards, 'card points']);
  return (
    <section className={cx('grid shrink-0 gap-2', desktop ? 'grid-cols-4' : 'grid-cols-3')}>
      {tiles.map(([k, v, note]) => (
        <Card key={k} className="flex flex-col gap-0.5 p-2.5">
          <span className="text-[12px] text-muted">{k}</span>
          <span className="tnum text-[16px] font-bold">{formatCents(v)}</span>
          {desktop && <span className="text-[12px] text-muted">{note}</span>}
        </Card>
      ))}
    </section>
  );
}

function ByCategory({ r }: { r: ReportsView }) {
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const sorted = [...r.byCategory].sort((a, b) => b.spent - a.spent);
  const max = sorted[0]?.spent ?? 1;
  return (
    <Card className="flex flex-col">
      {sorted.length === 0 && <EmptyNote inCard>No spending yet.</EmptyNote>}
      {sorted.map((c) => (
        <button
          key={c.categoryId}
          type="button"
          data-track="reports.category"
          onClick={() => void navigate({ to: '/activity', search: { q: c.name } })}
          aria-label={`${c.name}, ${formatCents(c.spent)}: see its transactions`}
          className={cx(
            'flex min-h-12 flex-col justify-center gap-1.5 border-t border-divider px-3 py-2 text-left first:border-t-0',
            desktop && 'hover:bg-surface-2',
          )}
        >
          <span className="flex items-center justify-between gap-2 text-[14px]">
            <span className="font-semibold">{c.name}</span>
            <span className="flex items-center gap-1">
              <span className="tnum font-bold">{formatCents(c.spent)}</span>
              <Icon name="chevR" size={18} className="text-faint" />
            </span>
          </span>
          <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-sm bg-track">
            <span
              className="block h-1.5 rounded-sm bg-accent"
              style={{ width: `${percentOf(c.spent, max)}%` }}
            />
          </span>
        </button>
      ))}
    </Card>
  );
}

function Trend({ r, desktop }: { r: ReportsView; desktop: boolean }) {
  const top = Math.max(1, ...r.trend.map((t) => t.spent));
  const label = r.trend
    .map(
      (t, i) =>
        `${monthShort(t.month)} ${kShort(t.spent)}${i === r.trend.length - 1 && r.monthToDate ? ' so far' : ''}`,
    )
    .join(', ');
  return (
    <Card className="flex flex-col gap-2 p-3">
      <span className="text-[14px] font-bold">Spent, last {r.trend.length} months</span>
      <div role="img" aria-label={`Spending by month: ${label}`} className="flex h-[170px] items-end gap-2">
        {r.trend.map((t, i) => {
          const last = i === r.trend.length - 1;
          return (
            <div key={t.month} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="tnum text-[12px] text-muted">{kShort(t.spent)}</span>
              <span
                className={cx(
                  'w-full max-w-9 rounded-t-md',
                  last && r.monthToDate ? 'bg-disabled' : 'bg-accent',
                )}
                style={{ height: `${Math.round((t.spent * 120) / top)}px` }}
              />
              <span className="text-[12px] text-muted">{monthShort(t.month)}</span>
            </div>
          );
        })}
      </div>
      <span className="text-[12px] text-muted">
        {r.monthToDate ? `${monthShort(r.month)} is month to date. ` : ''}
        {desktop
          ? 'Click a category under Spending by category to see its transactions.'
          : 'Tap a category on the Spending view to see its transactions.'}
      </span>
    </Card>
  );
}

function IncomeTable({ r }: { r: ReportsView }) {
  const prev = r.trend[r.trend.length - 2];
  if (!prev) return null;
  const rows: [string, number][] = [
    [`Income, ${monthShort(prev.month)}`, prev.income],
    [`Spent, ${monthShort(prev.month)}`, prev.spent],
    [`Invested, ${monthShort(prev.month)}`, prev.invested],
  ];
  return (
    <Card>
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex justify-between border-t border-divider px-3 py-2.5 text-[14px] first:border-t-0"
        >
          <span className="text-muted">{k}</span>
          <span className="tnum font-bold">{formatCents(v)}</span>
        </div>
      ))}
    </Card>
  );
}

function NetWorth({ r }: { r: ReportsView }) {
  const pts = r.netWorth;
  const last = pts[pts.length - 1];
  if (!last) return <EmptyNote>No history yet.</EmptyNote>;
  const min = Math.min(...pts.map((p) => p.value));
  const max = Math.max(...pts.map((p) => p.value));
  const span = Math.max(1, max - min);
  const d = pts
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${((i * 300) / Math.max(1, pts.length - 1)).toFixed(1)},${(90 - ((p.value - min) * 80) / span).toFixed(1)}`,
    )
    .join(' ');
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[14px] font-bold">Net worth</span>
        <span className="tnum text-[20px] font-bold">{formatCents(last.value)}</span>
      </div>
      <svg
        role="img"
        aria-label={`Net worth from ${monthLabel(pts[0]!.month)} to ${monthLabel(last.month)}`}
        viewBox="0 0 300 100"
        className="h-[110px] w-full"
        preserveAspectRatio="none"
      >
        <path
          d={d}
          fill="none"
          stroke="var(--ll-accent)"
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="flex justify-between text-[12px] text-muted">
        <span>
          {monthShort(pts[0]!.month)} {pts[0]!.month.slice(0, 4)}
        </span>
        <span>
          {monthShort(last.month)} {last.month.slice(0, 4)}
        </span>
      </div>
    </Card>
  );
}

function WorthTable() {
  const a = useAccounts().data;
  if (!a) return null;
  const rows: [string, number][] = [
    ...a.groups.map((g) => [g.name, g.total] as [string, number]),
    ['Net worth', a.netWorth],
  ];
  return (
    <Card>
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex justify-between border-t border-divider px-3 py-2.5 text-[14px] first:border-t-0"
        >
          <span className={k === 'Net worth' ? 'font-bold' : 'text-muted'}>{k}</span>
          <span className={cx('tnum font-bold', v < 0 && 'text-over-fg')}>{formatCents(v)}</span>
        </div>
      ))}
    </Card>
  );
}

export function ReportsScreen() {
  const search = useSearch({ strict: false }) as { month?: string };
  const session = useSession();
  const current = session.data?.budget.currentMonth;
  const month = search.month ?? current;
  const [view, setView] = useState<View>('spend');
  useScreen(`reports.${view}`);
  const q = useReports(month);
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const r = q.data;
  const go = (m: string) =>
    void navigate({ to: '/reports', search: { month: m === current ? undefined : m } });
  // The budget's first month: there is nothing to report before it.
  const min = useBudget(current).data?.minMonth;
  const note = r
    ? r.monthToDate
      ? `Month to date. Your share only: amounts owed to you are left out.${r.stillOwed ? ` ${formatCents(r.stillOwed)} is still owed to you.` : ''}`
      : 'Whole month. Your share only.'
    : '';
  const monthNav = month && (
    <MonthSwitcher month={month} min={min} max={current} onGo={go} track="reports.month" />
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {desktop ? (
        <DesktopHeader title="Reports" right={monthNav} />
      ) : (
        <PhoneHeader title="Reports" right={monthNav} />
      )}
      <ScreenBody>
        {!r ? (
          q.error ? (
            <ErrorNote error={q.error} />
          ) : (
            <Loading />
          )
        ) : desktop ? (
          <>
            <Tiles r={r} desktop />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <SectionTitle>Spending by category</SectionTitle>
                <p className="m-0 px-0.5 pb-1 text-[12px] leading-snug text-muted">{note}</p>
                <ByCategory r={r} />
              </div>
              <div className="flex flex-col gap-3">
                <Trend r={r} desktop />
                <NetWorth r={r} />
              </div>
            </div>
          </>
        ) : (
          <>
            <Segmented
              label="View"
              track="reports.view"
              value={view}
              onChange={setView}
              options={[
                ['spend', 'Spending'],
                ['trend', 'Trends'],
                ['worth', 'Net worth'],
              ]}
            />
            {view === 'spend' && (
              <>
                <Tiles r={r} desktop={false} />
                <p className="m-0 text-[12px] leading-snug text-muted">{note}</p>
                <ByCategory r={r} />
              </>
            )}
            {view === 'trend' && (
              <>
                <Trend r={r} desktop={false} />
                <IncomeTable r={r} />
              </>
            )}
            {view === 'worth' && (
              <>
                <NetWorth r={r} />
                <WorthTable />
                <p className="m-0 text-[12px] leading-snug text-muted">
                  Bank and card accounts only. Owed to you ({formatCents(r.stillOwed)}) is not counted until
                  it’s paid back.
                </p>
              </>
            )}
          </>
        )}
      </ScreenBody>
    </div>
  );
}
