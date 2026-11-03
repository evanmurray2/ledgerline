// Budget (home): month switcher, All / Needs attention, card payment rows pinned first, the Owed to you row,
// collapsible groups with totals, status words and bars. Desktop shows the same data, bars and status words as
// a table with Assigned, Spent and Available columns. Needs attention offers one-tap fixes with amounts.
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
  DESKTOP_WIDTH,
  DesktopHeader,
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
  OverflowMenu,
  useIsDesktop,
  useShortcuts,
  type IconName,
  type Tone,
} from '../components/ui';
import { centsToInput, formatCents, parseCents } from '../lib/money';
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
      className="relative flex min-h-11 flex-col gap-[7px] border-t border-divider px-3 py-2.5 text-ink no-underline first:border-t-0"
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
      className="relative flex min-h-11 flex-col gap-[7px] border-t border-divider px-3 py-2.5 text-ink no-underline first:border-t-0"
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
                    {/* Overspent and Owed amounts are the problem itself; for the rest the balance is just
                        context, and the button says what it needs. */}
                    <span
                      className={cx(
                        'tnum text-[14px] font-bold',
                        sec.title === 'Overspent' || a.link === 'owed' ? TONE[t.tone].fg : 'text-ink-2',
                      )}
                    >
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
  useShortcuts(
    {
      '[': () => canPrev && void go(addMonths(month, -1)),
      ']': () => canNext && void go(addMonths(month, 1)),
    },
    desktop,
  );
  return (
    <div className={cx('flex items-center', desktop ? '-ml-3 gap-1' : 'justify-between px-2 py-1.5')}>
      <button
        type="button"
        data-track="budget.month.prev"
        aria-label="Previous month"
        aria-keyshortcuts={desktop ? '[' : undefined}
        title={desktop ? 'Previous month ( [ )' : undefined}
        disabled={!canPrev}
        onClick={() => go(addMonths(month, -1))}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 disabled:text-line-strong"
      >
        <Icon name="chevL" size={22} />
      </button>
      <h1
        className={cx(
          'm-0 text-center font-bold',
          desktop ? 'min-w-[170px] text-[22px]' : 'flex-1 pl-11 text-[17px]',
        )}
      >
        {monthLabel(month)}
      </h1>
      <button
        type="button"
        data-track="budget.month.next"
        aria-label="Next month"
        aria-keyshortcuts={desktop ? ']' : undefined}
        title={desktop ? 'Next month ( ] )' : undefined}
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
          total={`${formatCents(g.total)} available`}
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
          total={`${formatCents(b.archived.reduce((s, c) => s + c.available, 0))} available`}
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
          total={`${formatCents(b.cards.reduce((s, c) => s + c.available, 0))} available`}
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
        className="hit flex h-10 shrink-0 items-center self-start text-[14px] font-bold text-accent no-underline"
      >
        Set targets
      </Link>
    </>
  );
}

// ------------------------------------------------------------------ desktop table

/** Moves focus to the Assigned field `step` rows away. False when there is none (Tab then leaves the table). */
function focusAssigned(from: HTMLElement, step: number): boolean {
  const table = from.closest('[role="table"]');
  if (!table) return false;
  const all = [...table.querySelectorAll<HTMLInputElement>('input[data-assigned]')];
  const next = all[all.indexOf(from as HTMLInputElement) + step];
  if (!next) return false;
  next.focus();
  return true;
}

/**
 * Assigned, typed straight into the table: click or Tab in, type, Enter or Tab saves. Tab and the arrow keys
 * move between rows; Escape puts the old amount back. It saves the same way the category panel does.
 */
function AssignedCell({
  id,
  name,
  cents,
  month,
}: {
  id: string;
  name: string;
  cents: number;
  month: string;
}) {
  const canWrite = useCanWrite();
  const set = useMoneyMutation(api.setAssigned);
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const edit = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };
  const commit = async () => {
    const v = draftRef.current === null ? null : parseCents(draftRef.current);
    edit(null);
    if (v === null || v === cents) return;
    try {
      await set.mutateAsync({ month, categoryId: id, assigned: v });
    } catch (e) {
      toast.show({ text: e instanceof Error ? e.message : 'Couldn’t save that.' });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      // Only undo the typing; the open side panel stays.
      e.stopPropagation();
      edit(null);
      el.blur();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusAssigned(el, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Tab') {
      if (focusAssigned(el, e.shiftKey ? -1 : 1)) e.preventDefault();
    }
  };
  // While a save is on its way, show what was typed rather than flicking back to the old amount.
  const shown = set.isPending && set.variables ? set.variables.assigned : cents;
  return (
    <input
      data-assigned={id}
      data-track="budget.assigned"
      aria-label={`Assigned to ${name}`}
      inputMode="decimal"
      autoComplete="off"
      disabled={!canWrite}
      value={draft ?? formatCents(shown)}
      onFocus={(e) => {
        edit(centsToInput(cents));
        const el = e.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(e) => edit(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className="tnum h-9 w-full max-w-[140px] rounded-lg border border-transparent bg-surface-2 px-2 text-right text-[14px] text-ink-2 outline-none hover:border-line-strong focus:border-accent focus:bg-surface focus:text-ink disabled:bg-transparent disabled:hover:border-transparent"
    />
  );
}

/**
 * Spent, so spending stands out: nothing spent fades back, money spent reads dark with the share of the
 * month's money it used beneath it (not for overspent rows: their red pill already says it).
 */
function SpentCell({ row }: { row: BudgetCategoryRow }) {
  if (row.status === 'invested') return <span className="text-ink">Invested {formatCents(row.spent)}</span>;
  if (row.spent === 0) return <span className="text-faint">{formatCents(0)}</span>;
  const used = row.leftPercent === null || row.status === 'overspent' ? null : 100 - row.leftPercent;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span className="font-semibold text-ink">{formatCents(row.spent)}</span>
      {used !== null && <span className="text-[12px] text-muted">{used}% used</span>}
    </span>
  );
}

function DesktopTable({ b, month }: { b: BudgetView; month: string }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const selected = /\/budget\/category\/([^/]+)/.exec(path)?.[1];
  // Narrow (a side panel open on a small screen): Spent drops out so Assigned and Available stay in view.
  const head =
    'grid grid-cols-[minmax(130px,2fr)_repeat(2,minmax(108px,1fr))] items-center @[540px]:grid-cols-[minmax(220px,2.2fr)_repeat(3,minmax(110px,1fr))]';
  const spentCls = 'hidden @[540px]:block';
  const cell = 'tnum px-3.5 py-1 text-right text-ink-2';
  const groupRow = (name: string, totals?: { assigned: number; spent: number; available: number }) => (
    <div
      role="row"
      key={`g-${name}`}
      className={cx(
        head,
        'border-t border-line-strong bg-sunken py-2 text-[12px] font-bold uppercase tracking-[0.5px] text-ink',
      )}
    >
      <span role="rowheader" className="px-3.5">
        {name}
      </span>
      {totals && (
        <>
          {/* 15px: the Assigned field's own padding and border, so the totals line up with its amount. */}
          <span
            role="cell"
            className="tnum pl-3.5 pr-[15px] text-right font-semibold tracking-normal text-ink-2"
          >
            {formatCents(totals.assigned)}
          </span>
          <span
            role="cell"
            className={cx('tnum px-3.5 text-right font-semibold tracking-normal text-ink-2', spentCls)}
          >
            {formatCents(totals.spent)}
          </span>
          <span role="cell" className="tnum px-6 text-right tracking-normal">
            {formatCents(totals.available)}
          </span>
        </>
      )}
    </div>
  );
  const row = (r: {
    key: string;
    name: string;
    detail: ReactNode;
    assigned: ReactNode;
    spent: ReactNode;
    avail: string;
    bar?: { percent: number; tone: Tone } | null;
    tone: Tone | null;
    open: () => void;
    track: string;
  }) => (
    <div
      role="row"
      key={r.key}
      // The whole row opens it; the name stays the keyboard and screen-reader way in.
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('input, button, a')) r.open();
      }}
      className={cx(
        head,
        'cursor-pointer border-t border-divider',
        selected === r.key ? 'bg-accent-soft' : 'hover:bg-surface-2',
      )}
    >
      <span role="rowheader" className="px-3.5 py-1">
        <button
          type="button"
          data-track={r.track}
          onClick={r.open}
          className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 text-left text-[14px] font-semibold text-ink"
        >
          {r.name}
          <span className="text-[13px] font-normal text-muted">{r.detail}</span>
        </button>
        {/* The phone's bar: how much of the month's money is left, readable without the numbers. */}
        {r.bar && (
          <div className="mb-1.5 max-w-[320px]">
            <Bar percent={r.bar.percent} tone={r.bar.tone} />
          </div>
        )}
      </span>
      <span role="cell" className="tnum flex justify-end px-1.5 py-1 text-right text-ink-2">
        {r.assigned}
      </span>
      <span role="cell" className={cx(cell, spentCls)}>
        {r.spent}
      </span>
      <span role="cell" className="px-3.5 py-1 text-right">
        {/* Healthy rows stay plain so the pills mark only what needs you. */}
        <span
          className={cx(
            'tnum inline-block whitespace-nowrap rounded-full px-2.5 py-[3px] font-bold',
            r.tone ? [TONE[r.tone].bg, TONE[r.tone].fg].join(' ') : 'text-ink',
          )}
        >
          {r.avail}
        </span>
      </span>
    </div>
  );
  const dash = <span className="px-[9px]">—</span>;
  const t = owedTone(b);
  return (
    <div className="@container min-w-0 overflow-x-auto rounded-xl border border-line bg-surface">
      <div role="table" aria-label={`Budget for ${monthLabel(month)}`} className="text-[14px]">
        <div
          role="row"
          className={cx(head, 'border-b border-line bg-surface-2 text-[12px] font-bold text-ink-2')}
        >
          <span role="columnheader" className="px-3.5 py-2.5">
            Category
          </span>
          <span role="columnheader" className="py-2.5 pl-3.5 pr-[15px] text-right">
            Assigned
          </span>
          <span role="columnheader" className={cx('px-3.5 py-2.5 text-right', spentCls)}>
            Spent
          </span>
          <span role="columnheader" className="px-6 py-2.5 text-right">
            Available
          </span>
        </div>
        {b.groups.flatMap((g) => [
          groupRow(g.name, {
            assigned: g.categories.reduce((s, c) => s + c.assigned, 0),
            // Matches the column: invested money shows as "Invested", not as spending.
            spent: g.categories.reduce((s, c) => s + (c.status === 'invested' ? 0 : c.spent), 0),
            available: g.total,
          }),
          ...g.categories.map((c) =>
            row({
              key: c.id,
              name: c.name,
              detail: isQuiet(c.status) ? (
                <>
                  <span className="sr-only">{STATUS[c.status].word} · </span>
                  {c.detail}
                </>
              ) : (
                <>
                  <StatusWord {...STATUS[c.status]} /> · {c.detail}
                </>
              ),
              assigned: <AssignedCell id={c.id} name={c.name} cents={c.assigned} month={month} />,
              spent: <SpentCell row={c} />,
              avail: formatCents(c.available),
              tone: isQuiet(c.status) ? null : STATUS[c.status].tone,
              bar: c.leftPercent === null ? null : { percent: c.leftPercent, tone: catTone(c) },
              open: () => void navigate({ to: `/budget/category/${c.id}`, search: { month } }),
              track: 'budget.category',
            }),
          ),
        ])}
        {b.cards.length > 0 && groupRow('Credit card payments')}
        {b.cards.map((c) =>
          row({
            key: c.accountId,
            name: c.name,
            detail: c.detail,
            assigned: dash,
            spent: '—',
            avail: formatCents(c.available),
            tone: c.status === 'short' ? 'over' : null,
            open: () => void navigate({ to: `/accounts/${c.accountId}` }),
            track: 'budget.card',
          }),
        )}
        {groupRow('Owed to you · not a category')}
        {row({
          key: 'owed',
          name: 'Owed to you',
          detail: `${t.word} · fronted money comes back to Ready to Assign`,
          assigned: dash,
          spent: '—',
          avail: `${formatCents(b.owed.out)} out`,
          tone: b.owed.status === 'late' ? t.tone : null,
          open: () => void navigate({ to: '/owed' }),
          track: 'budget.owed',
        })}
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
        <DesktopHeader
          title={<MonthNav b={b} month={month} view={view} desktop />}
          right={
            <>
              {/* The header narrows when a side panel opens: these two fold into a menu instead of wrapping. */}
              <Link
                to="/categories"
                data-track="budget.edit_categories"
                className="hit hidden h-9 items-center whitespace-nowrap px-2 text-[13px] font-bold text-accent no-underline @min-[560px]:flex"
              >
                Edit categories
              </Link>
              <Link
                to="/budget/targets"
                data-track="budget.set_targets"
                className="hit hidden h-9 items-center whitespace-nowrap px-2 text-[13px] font-bold text-accent no-underline @min-[560px]:flex"
              >
                Set targets
              </Link>
              <OverflowMenu
                label="More budget actions"
                className="@min-[560px]:hidden"
                items={[
                  { to: '/categories', name: 'Edit categories', track: 'budget.edit_categories' },
                  { to: '/budget/targets', name: 'Set targets', track: 'budget.set_targets' },
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className={cx(DESKTOP_WIDTH, 'flex flex-col gap-3')}>{content}</div>
        </div>
        <Outlet />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col border-b border-line bg-surface">
        <MonthNav b={b} month={month} view={view} desktop={false} />
        {(count > 0 || lowCount > 0 || view !== 'all') && (
          <div className="px-4 pb-3 pt-1">
            <ViewChips view={view} count={count} lowCount={lowCount} month={month} current={b.currentMonth} />
          </div>
        )}
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
