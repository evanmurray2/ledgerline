// Budget's phone list: category, card payment and Owed to you rows in collapsible group cards.
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { BudgetCategoryRow, BudgetView, CardRow } from '@ledgerline/contracts';
import { Bar, Card, cx, Icon, Pill, STATUS, StatusWord, type IconName, type Tone } from '../components/ui';
import { formatCents } from '../lib/money';

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

export function allAssignedZero(b: BudgetView) {
  return b.groups.every((g) => g.categories.every((c) => c.assigned === 0 && c.spent === 0));
}

// ------------------------------------------------------------------ rows

export function catTone(row: BudgetCategoryRow): Tone {
  return STATUS[row.status].tone;
}

/** Healthy rows stay quiet (no status word, no colored pill) so the ones that need you stand out. */
export function isQuiet(status: BudgetCategoryRow['status']): boolean {
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

export function owedTone(b: BudgetView): { tone: Tone; word: string; icon: IconName } {
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

export function AllGroups({ b, month }: { b: BudgetView; month: string }) {
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
    </>
  );
}
