// Budget's phone list: pinned, category, card payment and Owed to you rows in collapsible group cards.
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

/** The pinned categories that are in this month's groups (archived and removed ones drop out), in pin order. */
export function pinnedRows(b: BudgetView): BudgetCategoryRow[] {
  const all = new Map(b.groups.flatMap((g) => g.categories.map((c) => [c.id, c] as const)));
  return b.pinned.flatMap((id) => all.get(id) ?? []);
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
          <span className="text-base font-semibold">{row.name}</span>
          <span className="text-xs leading-snug text-muted">
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
          <span className="tnum shrink-0 px-2.5 text-base font-semibold">{formatCents(row.available)}</span>
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
          <span className="text-base font-semibold">{card.name}</span>
          <span className="text-xs leading-snug text-muted">
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
          <span className="tnum shrink-0 px-2.5 text-base font-semibold">{formatCents(card.available)}</span>
        )}
      </div>
    </Link>
  );
}

/** The Owed to you row: a status word only when something is late; otherwise just what happens to the money. */
export function owedTone(b: BudgetView): { tone: Tone; word: string | null; icon: IconName } {
  return b.owed.status === 'late'
    ? { tone: 'under', word: `${b.owed.late} late`, icon: 'clock' }
    : { tone: 'none', word: null, icon: 'dash' };
}

export const OWED_DETAIL = 'Goes back to Ready to Assign when paid back';

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
          <span className="text-base font-semibold">Owed to you</span>
          <span className="text-xs leading-normal text-muted">
            {t.word && (
              <>
                <StatusWord word={t.word} tone={t.tone} icon={t.icon} /> ·{' '}
              </>
            )}
            {OWED_DETAIL}
          </span>
        </div>
        <Pill tone={t.tone}>{formatCents(b.owed.out)} out</Pill>
      </div>
    </Link>
  );
}

/**
 * The bar at the top of a Budget card: a group (tap to fold it) or a Needs attention section (an h2 in its status
 * color, with an action on the right). 12 px uppercase on surface-2.
 */
export function GroupHeader({
  title,
  icon,
  color = 'text-ink-2',
  right,
  divider = true,
  toggle,
}: {
  title: ReactNode;
  icon: IconName;
  color?: string;
  right?: ReactNode;
  divider?: boolean;
  toggle?: { expanded: boolean; onClick: () => void; track: string };
}) {
  const bar = cx(
    'flex min-h-11 w-full items-center justify-between gap-2 bg-surface-2 pl-3',
    right && !toggle ? 'pr-2' : 'pr-3',
    divider && 'border-b border-line',
  );
  const label = 'm-0 flex items-center gap-1.5 text-xs font-bold uppercase tracking-caps';
  if (toggle)
    return (
      <button
        type="button"
        data-track={toggle.track}
        aria-expanded={toggle.expanded}
        onClick={toggle.onClick}
        className={bar}
      >
        <span className={cx(label, color)}>
          <Icon name={icon} size={14} stroke={2.4} />
          {title}
        </span>
        {right}
      </button>
    );
  return (
    <div className={bar}>
      <h2 className={cx(label, color)}>
        <Icon name={icon} size={14} stroke={2.6} />
        {title}
      </h2>
      {right}
    </div>
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
  name: ReactNode;
  total: string;
  children: ReactNode;
  collapsed: boolean;
  toggle: (id: string) => void;
}) {
  return (
    <Card>
      <GroupHeader
        title={name}
        icon={collapsed ? 'chevR' : 'chevD'}
        right={<span className="tnum text-xs text-muted">{total}</span>}
        divider={!collapsed}
        toggle={{ expanded: !collapsed, onClick: () => toggle(id), track: 'budget.group.toggle' }}
      />
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
  const pinned = pinnedRows(b);
  return (
    <>
      {pinned.length > 0 && (
        <Group
          id="pinned"
          // A pin, not a total: these categories are counted in their own groups below.
          name={
            <>
              <Icon name="pin" size={14} stroke={2.4} />
              Pinned
            </>
          }
          total=""
          collapsed={!!collapsed.pinned}
          toggle={toggle}
        >
          {pinned.map((c) => (
            <CategoryRowPhone key={c.id} row={c} month={month} />
          ))}
        </Group>
      )}
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
          name="Card payments"
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
        <Group id="owed" name="Owed to you" total="" collapsed={!!collapsed.owed} toggle={toggle}>
          <OwedRowPhone b={b} />
        </Group>
      )}
      <p className="m-0 text-xs text-muted">
        {empty
          ? 'Transactions show up in Activity after each bank sync.'
          : 'Bars show how much of this month’s money is left.'}
      </p>
    </>
  );
}
