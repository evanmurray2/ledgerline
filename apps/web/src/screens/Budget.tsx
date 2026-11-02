// Budget (home): month switcher, All / Needs attention, card payment rows pinned first, the Owed to you row,
// collapsible groups with totals, status words and bars. Desktop shows the same data as a table with
// Assigned, Spent and Available columns. Needs attention offers one-tap fixes with amounts.
import { useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import type { AttentionItem, BudgetCategoryRow, BudgetView, CardRow } from '@ledgerline/contracts';
import { api } from '../api/endpoints';
import { useAssignView, useBudget, useMoneyMutation, useSession } from '../api/hooks';
import {
  Banner,
  Bar,
  Button,
  Card,
  Chip,
  CountBadge,
  cx,
  ErrorNote,
  Icon,
  Loading,
  Pill,
  PrimaryButton,
  SecondaryButton,
  SoftButton,
  STATUS,
  StatusWord,
  TONE,
  useIsDesktop,
  type IconName,
  type Tone,
} from '../components/ui';
import { formatCents } from '../lib/money';
import { addMonths, compareMonths, monthLabel, monthName } from '../lib/dates';
import { useScreen } from '../lib/common';
import { useCanWrite } from '../state/connectivity';
import { toast } from '../components/Toast';
import { usage } from '../usage/tracker';

type View = 'all' | 'attention' | 'low';

export interface BudgetSearch {
  month?: string;
  view?: View;
}

const COLLAPSE_KEY = 'ledgerline-collapsed';
function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}
function writeCollapsed(v: Record<string, boolean>) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v));
  } catch {
    // per-device convenience only
  }
}

export function useBudgetMonth(): { month: string | undefined; current: string | undefined } {
  const search = useSearch({ strict: false }) as BudgetSearch;
  const session = useSession();
  const current = session.data?.budget.currentMonth;
  return { month: search.month ?? current, current };
}

interface DoneFix {
  key: string;
  categoryId: string;
  name: string;
  delta: number;
}

const SECTION_ORDER: AttentionItem['section'][] = [
  'Ready to Assign',
  'Overspent',
  'Underfunded',
  'Low',
  'Overfunded',
  'Owed to you',
];
const SECTION_TONE: Record<AttentionItem['section'], { tone: Tone; icon: IconName }> = {
  'Ready to Assign': { tone: 'over', icon: 'alert' },
  Overspent: { tone: 'over', icon: 'alert' },
  Underfunded: { tone: 'under', icon: 'half' },
  Low: { tone: 'low', icon: 'down' },
  Overfunded: { tone: 'overfunded', icon: 'up' },
  'Owed to you': { tone: 'under', icon: 'alert' },
};

function fixLabel(fix: NonNullable<AttentionItem['fix']>): string {
  if (fix.verb === 'Review' || fix.verb === 'Move money') return fix.verb;
  return `${fix.verb} ${formatCents(Math.abs(fix.amount))}`;
}

function useFixes(month: string) {
  const [done, setDone] = useState<DoneFix[]>([]);
  const assign = useMoneyMutation(api.assign);
  const apply = async (items: { key: string; categoryId: string; name: string; amount: number }[]) => {
    const started = Date.now();
    await assign.mutateAsync({
      month,
      items: items.map((i) => ({ categoryId: i.categoryId, amount: i.amount })),
    });
    usage.record('task', 'fix', Date.now() - started);
    setDone((d) => [
      ...items.map((i) => ({ key: i.key, categoryId: i.categoryId, name: i.name, delta: i.amount })),
      ...d.filter((x) => !items.some((i) => i.key === x.key)),
    ]);
  };
  const undo = async (f: DoneFix) => {
    await assign.mutateAsync({ month, items: [{ categoryId: f.categoryId, amount: -f.delta }] });
    usage.undo('fix');
    setDone((d) => d.filter((x) => x.key !== f.key));
  };
  return { done, apply, undo, pending: assign.isPending };
}

// ------------------------------------------------------------------ rows

function catTone(row: BudgetCategoryRow): Tone {
  return STATUS[row.status].tone;
}

/** Healthy rows stay quiet (no status word, no colored pill) so the ones that need you stand out. */
function isQuiet(status: BudgetCategoryRow['status']): boolean {
  return status === 'funded' || status === 'invested' || status === 'no_target';
}

function CategoryRowPhone({ row, month }: { row: BudgetCategoryRow; month: string }) {
  const st = STATUS[row.status];
  const quiet = isQuiet(row.status);
  return (
    <Link
      to={`/budget/category/${row.id}`}
      search={{ month }}
      data-track="budget.category"
      className="flex min-h-11 flex-col gap-[7px] border-t border-divider px-3 py-2.5 text-ink no-underline first:border-t-0"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-[15px] font-semibold">{row.name}</span>
          <span className="truncate text-[12px] leading-[1.45] text-muted">
            {quiet ? (
              <span className="sr-only">{st.word} · </span>
            ) : (
              <>
                <StatusWord word={st.word} tone={st.tone} icon={st.icon} /> ·{' '}
              </>
            )}
            {row.detail}
          </span>
        </div>
        {quiet ? (
          <span className="tnum shrink-0 px-2.5 text-[15px] font-semibold">{formatCents(row.available)}</span>
        ) : (
          <Pill tone={catTone(row)}>{formatCents(row.available)}</Pill>
        )}
      </div>
      {row.leftPercent !== null && <Bar percent={row.leftPercent} tone={catTone(row)} />}
    </Link>
  );
}

function CardRowPhone({ card }: { card: CardRow }) {
  const tone: Tone = card.status === 'short' ? 'over' : 'funded';
  return (
    <Link
      to={`/accounts/${card.accountId}`}
      data-track="budget.card"
      className="flex min-h-11 flex-col gap-[7px] border-t border-divider px-3 py-2.5 text-ink no-underline first:border-t-0"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-[15px] font-semibold">{card.name}</span>
          <span className="truncate text-[12px] leading-[1.45] text-muted">
            {card.status === 'short' ? (
              <>
                <StatusWord word="Short" tone={tone} icon="alert" /> ·{' '}
              </>
            ) : (
              <span className="sr-only">Covered · </span>
            )}
            {card.detail}
          </span>
        </div>
        {card.status === 'short' ? (
          <Pill tone={tone}>{formatCents(card.available)}</Pill>
        ) : (
          <span className="tnum shrink-0 px-2.5 text-[15px] font-semibold">
            {formatCents(card.available)}
          </span>
        )}
      </div>
    </Link>
  );
}

function owedTone(b: BudgetView): { tone: Tone; word: string; icon: IconName } {
  return b.owed.status === 'late'
    ? { tone: 'under', word: `${b.owed.late} late`, icon: 'clock' }
    : { tone: 'none', word: 'Tracking', icon: 'dash' };
}

function OwedRowPhone({ b }: { b: BudgetView }) {
  const t = owedTone(b);
  return (
    <Link
      to="/owed"
      data-track="budget.owed"
      className="flex min-h-11 flex-col gap-[7px] px-3 py-2.5 text-ink no-underline"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="text-[15px] font-semibold">Owed to you</span>
          <span className="text-[12px] leading-[1.45] text-muted">
            <StatusWord word={t.word} tone={t.tone} icon={t.icon} /> · {formatCents(b.owed.out)} out · comes
            back to Ready to Assign
          </span>
        </div>
        <Pill tone={t.tone}>{formatCents(b.owed.out)} out</Pill>
      </div>
    </Link>
  );
}

function Group({
  id,
  name,
  total,
  children,
  collapsed,
  toggle,
}: {
  id: string;
  name: string;
  total: string;
  children: ReactNode;
  collapsed: boolean;
  toggle: (id: string) => void;
}) {
  return (
    <Card>
      <button
        type="button"
        data-track="budget.group.toggle"
        aria-expanded={!collapsed}
        onClick={() => toggle(id)}
        className={cx(
          'flex min-h-11 w-full items-center justify-between bg-surface-2 px-3',
          !collapsed && 'border-b border-line',
        )}
      >
        <span className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.6px] text-ink-2">
          <Icon name={collapsed ? 'chevR' : 'chevD'} size={14} stroke={2.4} />
          {name}
        </span>
        <span className="tnum text-[12px] text-muted">{total}</span>
      </button>
      {!collapsed && children}
    </Card>
  );
}

// ------------------------------------------------------------------ needs attention

/** Needs attention (everything but Low), or Low on its own filter. */
function AttentionList({ b, month, low = false }: { b: BudgetView; month: string; low?: boolean }) {
  const fixes = useFixes(month);
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  const open = b.attention.filter(
    (a) => !fixes.done.some((d) => d.key === a.key) && (a.section === 'Low') === low,
  );
  const sections = SECTION_ORDER.map((s) => ({
    title: s,
    items: open.filter((a) => a.section === s),
  })).filter((s) => s.items.length);
  const availOf = (id: string) => b.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.available;
  const run = async (a: AttentionItem) => {
    if (!a.fix) return;
    if (a.link === 'owed') return navigate({ to: '/owed' });
    if (a.section === 'Ready to Assign') return navigate({ to: '/budget', search: { month, view: 'all' } });
    if (!a.categoryId) return;
    try {
      await fixes.apply([{ key: a.key, categoryId: a.categoryId, name: a.name, amount: a.fix.amount }]);
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
    }
  };
  const underfunded = open.filter((a) => a.section === 'Underfunded' && a.fix && a.categoryId);
  const fundAll = async () => {
    try {
      await fixes.apply(
        underfunded.map((a) => ({
          key: a.key,
          categoryId: a.categoryId!,
          name: a.name,
          amount: a.fix!.amount,
        })),
      );
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
    }
  };
  return (
    <>
      {open.length === 0 && (
        <p className="m-0 shrink-0 rounded-[14px] bg-funded-bg p-4 text-center text-[15px] font-semibold text-funded-fg">
          {low ? 'Nothing is running low.' : 'Nothing needs attention.'}
        </p>
      )}
      {sections.map((sec) => {
        const t = SECTION_TONE[sec.title];
        return (
          <Card key={sec.title}>
            <div className="flex min-h-11 items-center justify-between border-b border-line bg-surface-2 pl-3 pr-2">
              <h2
                className={cx(
                  'm-0 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.6px]',
                  TONE[t.tone].fg,
                )}
              >
                <Icon name={t.icon} size={14} stroke={2.6} />
                {sec.title}
              </h2>
              {sec.title === 'Underfunded' && underfunded.length > 1 && (
                <Button
                  mutates
                  track="budget.attention.fund_all"
                  onClick={fundAll}
                  className="hit h-9 rounded-full bg-accent px-3 text-[13px] font-bold text-on-accent disabled:bg-disabled-bg disabled:text-muted"
                >
                  Fund all · {formatCents(underfunded.reduce((s, a) => s + a.fix!.amount, 0))}
                </Button>
              )}
            </div>
            {sec.items.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
              >
                <Link
                  to={
                    a.link === 'owed'
                      ? '/owed'
                      : a.categoryId
                        ? `/budget/category/${a.categoryId}`
                        : '/budget'
                  }
                  search={a.categoryId ? { month } : undefined}
                  className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px] text-ink no-underline"
                >
                  <span className="flex justify-between gap-2">
                    <span className="text-[15px] font-semibold">{a.name}</span>
                    <span className={cx('tnum text-[14px] font-bold', TONE[t.tone].fg)}>
                      {formatCents(a.amount)}
                    </span>
                  </span>
                  <span className="text-[12px] text-muted">{a.detail}</span>
                </Link>
                {a.fix && (
                  <SoftButton
                    mutates={a.link !== 'owed'}
                    track={`budget.attention.${a.fix.verb.toLowerCase().replace(' ', '_')}`}
                    aria-label={`${fixLabel(a.fix)} for ${a.name}`}
                    onClick={() => void run(a)}
                    disabled={fixes.pending}
                    className="min-w-[92px]"
                  >
                    {fixLabel(a.fix)}
                  </SoftButton>
                )}
              </div>
            ))}
          </Card>
        );
      })}
      {fixes.done.length > 0 && (
        <Card>
          <div className="flex min-h-11 items-center border-b border-line bg-surface-2 px-3">
            <h2 className="m-0 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.6px] text-funded-fg">
              <Icon name="check" size={14} stroke={2.6} />
              Done just now
            </h2>
          </div>
          {fixes.done.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
            >
              <div className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-[3px]">
                <span className="flex justify-between gap-2">
                  <span className="text-[15px] font-semibold">{f.name}</span>
                  <span className="tnum text-[14px] font-bold text-muted">
                    {formatCents(availOf(f.categoryId) ?? 0)}
                  </span>
                </span>
                <span className="text-[12px] text-muted">
                  {f.delta < 0
                    ? `Moved ${formatCents(-f.delta)} back to Ready to Assign`
                    : `Added ${formatCents(f.delta)} from Ready to Assign`}
                </span>
              </div>
              <Button
                mutates
                track="budget.attention.undo"
                disabled={!canWrite}
                onClick={() => void fixes.undo(f)}
                className="hit h-9 min-w-[92px] shrink-0 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-bold text-ink-2"
              >
                Undo
              </Button>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

// ------------------------------------------------------------------ special states

function OverAssigned({ b, month }: { b: BudgetView; month: string }) {
  const move = useMoneyMutation(api.move);
  const [took, setTook] = useState<{ id: string; name: string; amount: number } | null>(null);
  const need = -b.rta;
  const candidates = b.groups
    .flatMap((g) => g.categories)
    .filter((c) => c.available >= need && c.status !== 'overspent')
    .sort((x, y) =>
      x.status === 'overfunded' ? -1 : y.status === 'overfunded' ? 1 : y.available - x.available,
    )
    .slice(0, 3);
  if (took)
    return (
      <Banner
        tone="success"
        action={
          <Button
            mutates
            track="budget.over.undo"
            className="hit h-9 shrink-0 px-2 text-[13px] font-bold underline"
            onClick={async () => {
              await move.mutateAsync({ month, from: 'rta', to: took.id, amount: took.amount });
              usage.undo('take_back');
              setTook(null);
            }}
          >
            Undo
          </Button>
        }
      >
        Took {formatCents(took.amount)} from {took.name}. Ready to Assign is back to {formatCents(b.rta)}.
      </Banner>
    );
  if (b.rta >= 0) return null;
  return (
    <>
      <div
        role="alert"
        className="flex shrink-0 flex-col gap-1 rounded-xl bg-over-bg px-3 py-2.5 text-over-fg"
      >
        <span className="text-[15px] font-bold">You assigned {formatCents(need)} more than you have</span>
        <span className="text-[13px] leading-snug">
          Take {formatCents(need)} back from a category below. Nothing else is blocked meanwhile.
        </span>
      </div>
      <h2 className="m-0 px-0.5 text-[13px] font-bold uppercase tracking-[0.5px] text-ink-2">
        Take it back from
      </h2>
      <Card>
        {candidates.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 border-t border-divider px-3 py-2.5 first:border-t-0"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">{c.name}</span>
              <span className="text-[12px] text-muted">
                {formatCents(c.available)} · {c.detail}
              </span>
            </span>
            <SoftButton
              mutates
              track="budget.over.take"
              aria-label={`Take ${formatCents(need)} from ${c.name}`}
              onClick={async () => {
                await move.mutateAsync({ month, from: c.id, to: 'rta', amount: need });
                setTook({ id: c.id, name: c.name, amount: need });
              }}
            >
              Take {formatCents(need)}
            </SoftButton>
          </div>
        ))}
      </Card>
      <p className="m-0 text-[12px] leading-snug text-muted">
        The app never takes money from your categories on its own.
      </p>
    </>
  );
}

function allAssignedZero(b: BudgetView) {
  return b.groups.every((g) => g.categories.every((c) => c.assigned === 0 && c.spent === 0));
}

function FirstBudget({ b }: { b: BudgetView }) {
  const owed = b.cards.reduce((s, c) => s + c.owed, 0);
  return (
    <section className="flex shrink-0 flex-col gap-1.5 rounded-[14px] bg-accent-soft p-3.5 text-ink">
      <span className="text-[17px] font-bold">Give your {formatCents(b.rta)} a job</span>
      <span className="text-[13px] leading-snug text-ink-2">
        Fund your card payments first ({formatCents(owed)} owed), then bills, everyday spending and savings.
        Targets tell each category what it needs.
      </span>
      <Link
        to="/budget/targets"
        data-track="budget.first.targets"
        className="hit mt-1 flex h-10 items-center self-start rounded-full bg-accent px-4 text-[14px] font-bold text-on-accent no-underline"
      >
        Set targets
      </Link>
    </section>
  );
}

function NewMonth({ b, month }: { b: BudgetView; month: string }) {
  const assignView = useAssignView(month);
  const assign = useMoneyMutation(api.assign);
  const [filled, setFilled] = useState<{ categoryId: string; amount: number }[] | null>(null);
  const targets = (assignView.data?.suggestions ?? []).filter((s) => s.reason === 'target' && s.amount > 0);
  const total = targets.reduce((s, t) => s + t.amount, 0);
  const prev = addMonths(month, -1);
  return (
    <>
      <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5">
        <h2 className="m-0 text-[17px] font-bold">{monthName(month)} has started</h2>
        <span className="text-[13px] text-muted">
          Nothing moved on its own. Every category keeps what it had left in {monthName(prev)}, and Ready to
          Assign carried over.
        </span>
        <div className="flex items-center justify-between border-t border-divider pt-2 text-[14px]">
          <span className="font-semibold">Ready to Assign</span>
          <span className="tnum font-bold">{formatCents(b.rta)}</span>
        </div>
      </section>
      {total > 0 && (
        <section className="flex shrink-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3.5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-[15px] font-bold">Targets for {monthName(month)}</h2>
            <span className="tnum text-[15px] font-bold">{formatCents(total)}</span>
          </div>
          <span className="text-[13px] text-muted">
            {filled
              ? 'Filled every refill target and this month’s share of each savings goal.'
              : 'Refill targets plus this month’s share of each savings goal.'}
          </span>
          {filled ? (
            <SecondaryButton
              mutates
              track="budget.newmonth.undo"
              onClick={async () => {
                await assign.mutateAsync({
                  month,
                  items: filled.map((f) => ({ categoryId: f.categoryId, amount: -f.amount })),
                });
                usage.undo('fill_targets');
                setFilled(null);
              }}
            >
              Undo
            </SecondaryButton>
          ) : (
            <PrimaryButton
              mutates
              track="budget.newmonth.fill"
              onClick={async () => {
                const items = targets.map((t) => ({ categoryId: t.categoryId, amount: t.amount }));
                await assign.mutateAsync({ month, items });
                setFilled(items);
              }}
            >
              Fill targets · {formatCents(total)}
            </PrimaryButton>
          )}
        </section>
      )}
    </>
  );
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

function MonthNav({
  b,
  month,
  view,
  desktop,
}: {
  b: BudgetView;
  month: string;
  view: View;
  desktop: boolean;
}) {
  const navigate = useNavigate();
  const canPrev = compareMonths(month, b.minMonth) > 0;
  const canNext = compareMonths(month, b.maxMonth) < 0;
  const go = (m: string) =>
    navigate({
      to: '/budget',
      search: { month: m === b.currentMonth ? undefined : m, view: view === 'all' ? undefined : view },
    });
  return (
    <div className={cx('flex items-center', desktop ? 'gap-1' : 'justify-between px-2 py-1.5')}>
      <button
        type="button"
        data-track="budget.month.prev"
        aria-label="Previous month"
        disabled={!canPrev}
        onClick={() => go(addMonths(month, -1))}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 disabled:text-line-strong"
      >
        <Icon name="chevL" size={22} />
      </button>
      <h1
        className={cx(
          'm-0 text-center font-bold',
          desktop ? 'min-w-[170px] text-[20px]' : 'flex-1 pl-11 text-[17px]',
        )}
      >
        {monthLabel(month)}
      </h1>
      <button
        type="button"
        data-track="budget.month.next"
        aria-label="Next month"
        disabled={!canNext}
        onClick={() => go(addMonths(month, 1))}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 disabled:text-line-strong"
      >
        <Icon name="chevR" size={22} />
      </button>
      {!desktop && (
        // Categories belong to the budget; Settings stays behind the gear on Accounts.
        <Link
          to="/categories"
          data-track="budget.edit_categories"
          aria-label="Edit categories"
          className="flex h-11 min-w-11 items-center justify-center px-1 text-[15px] font-bold text-accent no-underline"
        >
          Edit
        </Link>
      )}
    </div>
  );
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
  return (
    <div role="group" aria-label="Show" className="flex gap-2">
      <Chip pressed={view === 'all'} onClick={() => set('all')} track="budget.filter.all">
        All
      </Chip>
      <Chip pressed={view === 'attention'} onClick={() => set('attention')} track="budget.filter.attention">
        Needs attention
        <CountBadge n={count} inverted={view === 'attention'} />
      </Chip>
      <Chip pressed={view === 'low'} onClick={() => set('low')} track="budget.filter.low">
        Low
        <CountBadge n={lowCount} inverted={view === 'low'} />
      </Chip>
    </div>
  );
}

function PastNote({ month, current }: { month: string; current: string }) {
  if (compareMonths(month, current) >= 0) return null;
  return (
    <p className="m-0 shrink-0 rounded-xl bg-info-bg px-3 py-2.5 text-[13px] leading-snug text-info-fg">
      {monthName(month)}. You can still change what was assigned; the change carries into {monthName(current)}
      .
    </p>
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

function AllGroups({ b, month }: { b: BudgetView; month: string }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = { ...c, [id]: !c[id] };
      writeCollapsed(n);
      return n;
    });
  const empty = allAssignedZero(b);
  return (
    <>
      {b.groups.map((g) => (
        <Group
          key={g.id}
          id={g.id}
          name={g.name}
          total={formatCents(g.total)}
          collapsed={!!collapsed[g.id]}
          toggle={toggle}
        >
          {g.categories.map((c) => (
            <CategoryRowPhone key={c.id} row={c} month={month} />
          ))}
        </Group>
      ))}
      {b.archived.length > 0 && (
        <Group
          id="archived"
          name="Archived"
          total={formatCents(b.archived.reduce((s, c) => s + c.available, 0))}
          collapsed={collapsed.archived !== false}
          toggle={(id) => toggle(id)}
        >
          {b.archived.map((c) => (
            <CategoryRowPhone key={c.id} row={c} month={month} />
          ))}
        </Group>
      )}
      {b.cards.length > 0 && (
        <Group
          id="cards"
          name="Credit card payments"
          total={formatCents(b.cards.reduce((s, c) => s + c.available, 0))}
          collapsed={!!collapsed.cards}
          toggle={toggle}
        >
          {b.cards.map((c) => (
            <CardRowPhone key={c.accountId} card={c} />
          ))}
        </Group>
      )}
      {!empty && (
        <Group
          id="owed"
          name="Owed to you"
          total="not a category"
          collapsed={!!collapsed.owed}
          toggle={toggle}
        >
          <OwedRowPhone b={b} />
        </Group>
      )}
      <p className="m-0 text-[12px] text-muted">
        {empty
          ? 'Transactions will show up in Activity after the first sync, usually within a few minutes.'
          : 'Bars show how much of this month’s money is left.'}
      </p>
      <Link
        to="/budget/targets"
        data-track="budget.set_targets"
        className="hit flex h-10 items-center self-start text-[14px] font-bold text-accent no-underline"
      >
        Set targets
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ desktop table

function DesktopTable({ b, month }: { b: BudgetView; month: string }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const selected = /\/budget\/category\/([^/]+)/.exec(path)?.[1];
  const head = 'grid grid-cols-[minmax(200px,2fr)_repeat(3,minmax(90px,1fr))] items-center';
  const cell = 'tnum px-3.5 py-1 text-right text-ink-2';
  const groupRow = (name: string) => (
    <div
      role="row"
      key={`g-${name}`}
      className="border-t border-line bg-surface-2 px-3.5 py-2 text-[12px] font-bold uppercase tracking-[0.5px] text-ink-2"
    >
      <span role="rowheader">{name}</span>
    </div>
  );
  const row = (
    key: string,
    name: string,
    detail: string,
    assigned: string,
    spent: string,
    avail: string,
    tone: Tone,
    onClick: () => void,
    track: string,
  ) => (
    <div
      role="row"
      key={key}
      className={cx(head, 'border-t border-divider', selected === key ? 'bg-accent-soft' : '')}
    >
      <span role="rowheader" className="px-3.5 py-1">
        <button
          type="button"
          data-track={track}
          onClick={onClick}
          className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 text-left text-[14px] font-semibold text-ink"
        >
          {name}
          <span className="text-[12px] font-normal text-muted">{detail}</span>
        </button>
      </span>
      <span role="cell" className={cell}>
        {assigned}
      </span>
      <span role="cell" className={cell}>
        {spent}
      </span>
      <span role="cell" className="px-3.5 py-1 text-right">
        <span
          className={cx(
            'tnum inline-block rounded-full px-2.5 py-[3px] font-bold',
            TONE[tone].bg,
            TONE[tone].fg,
          )}
        >
          {avail}
        </span>
      </span>
    </div>
  );
  const t = owedTone(b);
  return (
    <div className="min-w-0 overflow-x-auto rounded-xl border border-line bg-surface">
      <div role="table" aria-label={`Budget for ${monthLabel(month)}`} className="min-w-[520px] text-[14px]">
        <div
          role="row"
          className={cx(head, 'border-b border-line bg-surface-2 text-[12px] font-bold text-ink-2')}
        >
          <span role="columnheader" className="px-3.5 py-2.5">
            Category
          </span>
          <span role="columnheader" className="px-3.5 py-2.5 text-right">
            Assigned
          </span>
          <span role="columnheader" className="px-3.5 py-2.5 text-right">
            Spent
          </span>
          <span role="columnheader" className="px-3.5 py-2.5 text-right">
            Available
          </span>
        </div>
        {b.groups.flatMap((g) => [
          groupRow(g.name),
          ...g.categories.map((c) =>
            row(
              c.id,
              c.name,
              `${STATUS[c.status].word} · ${c.detail}`,
              formatCents(c.assigned),
              c.status === 'invested' ? `Invested ${formatCents(c.spent)}` : formatCents(c.spent),
              formatCents(c.available),
              STATUS[c.status].tone,
              () => void navigate({ to: `/budget/category/${c.id}`, search: { month } }),
              'budget.category',
            ),
          ),
        ])}
        {b.cards.length > 0 && groupRow('Credit card payments')}
        {b.cards.map((c) =>
          row(
            c.accountId,
            c.name,
            c.detail,
            '—',
            '—',
            formatCents(c.available),
            c.status === 'short' ? 'over' : 'funded',
            () => void navigate({ to: `/accounts/${c.accountId}` }),
            'budget.card',
          ),
        )}
        {groupRow('Owed to you · not a category')}
        {row(
          'owed',
          'Owed to you',
          `${t.word} · fronted money comes back to Ready to Assign`,
          '—',
          '—',
          `${formatCents(b.owed.out)} out`,
          t.tone,
          () => void navigate({ to: '/owed' }),
          'budget.owed',
        )}
      </div>
    </div>
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
  const canWrite = useCanWrite();
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
        <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-6 py-2">
          <MonthNav b={b} month={month} view={view} desktop />
          <div className="flex items-center gap-2">
            <ViewChips view={view} count={count} lowCount={lowCount} month={month} current={b.currentMonth} />
            <Link
              to="/categories"
              data-track="budget.edit_categories"
              className="hit flex h-9 items-center px-2 text-[13px] font-bold text-accent no-underline"
            >
              Edit categories
            </Link>
            <Link
              to="/budget/targets"
              data-track="budget.set_targets"
              className="hit flex h-9 items-center px-2 text-[13px] font-bold text-accent no-underline"
            >
              Set targets
            </Link>
            {canWrite ? (
              <Link
                to="/budget/assign"
                data-track="budget.assign"
                className="hit flex h-9 items-center rounded-full bg-accent px-4 text-[13px] font-bold text-on-accent no-underline"
              >
                Assign {formatCents(b.rta)}
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className="flex h-9 items-center rounded-full bg-disabled-bg px-4 text-[13px] font-bold text-muted"
              >
                Assign {formatCents(b.rta)}
              </span>
            )}
          </div>
        </header>
        {b.syncProblem && <SyncProblem text={b.syncProblem} />}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-3">{content}</div>
        </div>
        <Outlet />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col border-b border-line bg-surface">
        <MonthNav b={b} month={month} view={view} desktop={false} />
        <div className="px-4 pb-3 pt-1">
          <ViewChips view={view} count={count} lowCount={lowCount} month={month} current={b.currentMonth} />
        </div>
        {b.syncProblem && <SyncProblem text={b.syncProblem} />}
      </header>
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {content}
      </div>
      <RtaBar b={b} onFix={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
      <Outlet />
    </div>
  );
}
