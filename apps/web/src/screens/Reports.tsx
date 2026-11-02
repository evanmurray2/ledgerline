// Reports: month to date by default. Spending (tiles, by category net of paybacks), Trends (last 6 months),
// Net worth. Desktop shows all three at once.
import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReportsView } from '@ledgerline/contracts';
import { useAccounts, useReports, useSession } from '../api/hooks';
import { cx, ErrorNote, Icon, Loading, Segmented, useIsDesktop } from '../components/ui';
import { formatCents, percentOf } from '../lib/money';
import { addMonths, compareMonths, monthLabel, monthShort } from '../lib/dates';
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
        <div key={k} className="flex flex-col gap-0.5 rounded-xl border border-line bg-surface p-2.5">
          <span className="text-[12px] text-muted">{k}</span>
          <span className="tnum text-[16px] font-bold">{formatCents(v)}</span>
          {desktop && <span className="text-[12px] text-muted">{note}</span>}
        </div>
      ))}
    </section>
  );
}

function ByCategory({ r }: { r: ReportsView }) {
  const navigate = useNavigate();
  const sorted = [...r.byCategory].sort((a, b) => b.spent - a.spent);
  const max = sorted[0]?.spent ?? 1;
  return (
    <section className="flex shrink-0 flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      {sorted.length === 0 && <p className="m-0 p-4 text-[14px] text-muted">No spending yet.</p>}
      {sorted.map((c) => (
        <button
          key={c.categoryId}
          type="button"
          data-track="reports.category"
          onClick={() => void navigate({ to: '/activity', search: { q: c.name } })}
          className="flex min-h-12 flex-col justify-center gap-1.5 border-t border-divider px-3 py-2 text-left first:border-t-0"
        >
          <span className="flex justify-between text-[14px]">
            <span className="font-semibold">{c.name}</span>
            <span className="tnum font-bold">{formatCents(c.spent)}</span>
          </span>
          <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-sm bg-track">
            <span
              className="block h-1.5 rounded-sm bg-accent"
              style={{ width: `${percentOf(c.spent, max)}%` }}
            />
          </span>
        </button>
      ))}
    </section>
  );
}

function Trend({ r }: { r: ReportsView }) {
  const top = Math.max(1, ...r.trend.map((t) => t.spent));
  const label = r.trend
    .map(
      (t, i) =>
        `${monthShort(t.month)} ${kShort(t.spent)}${i === r.trend.length - 1 && r.monthToDate ? ' so far' : ''}`,
    )
    .join(', ');
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
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
        {r.monthToDate ? `${monthShort(r.month)} is month to date. ` : ''}Tap a category on the Spending view
        to see its transactions.
      </span>
    </section>
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
    <section className="shrink-0 overflow-hidden rounded-[14px] border border-line bg-surface">
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex justify-between border-t border-divider px-3 py-2.5 text-[14px] first:border-t-0"
        >
          <span className="text-muted">{k}</span>
          <span className="tnum font-bold">{formatCents(v)}</span>
        </div>
      ))}
    </section>
  );
}

function NetWorth({ r }: { r: ReportsView }) {
  const pts = r.netWorth;
  const last = pts[pts.length - 1];
  if (!last) return <p className="m-0 text-[14px] text-muted">No history yet.</p>;
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
    <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
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
    </section>
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
    <section className="shrink-0 overflow-hidden rounded-[14px] border border-line bg-surface">
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex justify-between border-t border-divider px-3 py-2.5 text-[14px] first:border-t-0"
        >
          <span className={k === 'Net worth' ? 'font-bold' : 'text-muted'}>{k}</span>
          <span className={cx('tnum font-bold', v < 0 && 'text-over-fg')}>{formatCents(v)}</span>
        </div>
      ))}
    </section>
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
  const atEnd = !!month && !!current && compareMonths(month, current) >= 0;
  const note = r
    ? r.monthToDate
      ? `Month to date. Your share only: amounts owed to you are left out.${r.stillOwed ? ` ${formatCents(r.stillOwed)} is still owed to you.` : ''}`
      : 'Whole month. Your share only.'
    : '';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className={cx(
          'flex min-h-14 shrink-0 items-center justify-between border-b border-line bg-surface',
          desktop ? 'px-6' : 'pl-4 pr-1',
        )}
      >
        <h1 className="m-0 text-[22px] font-bold">Reports</h1>
        {month && (
          <div className="flex items-center">
            <button
              type="button"
              data-track="reports.month.prev"
              aria-label="Previous month"
              onClick={() => go(addMonths(month, -1))}
              className="flex h-11 w-11 items-center justify-center text-ink-2"
            >
              <Icon name="chevL" size={20} />
            </button>
            <span className="min-w-[84px] text-center text-[15px] font-bold">{monthLabel(month)}</span>
            <button
              type="button"
              data-track="reports.month.next"
              aria-label="Next month"
              disabled={atEnd}
              onClick={() => go(addMonths(month, 1))}
              className="flex h-11 w-11 items-center justify-center text-ink-2 disabled:text-line-strong"
            >
              <Icon name="chevR" size={20} />
            </button>
          </div>
        )}
      </header>
      <div
        className={cx('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto py-3', desktop ? 'px-6' : 'px-4')}
      >
        {!r ? (
          q.error ? (
            <ErrorNote error={q.error} />
          ) : (
            <Loading />
          )
        ) : desktop ? (
          <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4">
            <Tiles r={r} desktop />
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <h2 className="m-0 text-[15px] font-bold">Spending by category</h2>
                <span className="text-[12px] text-muted">{note}</span>
                <ByCategory r={r} />
              </div>
              <div className="flex flex-col gap-3">
                <Trend r={r} />
                <NetWorth r={r} />
              </div>
            </div>
          </div>
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
                <Trend r={r} />
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
      </div>
    </div>
  );
}
